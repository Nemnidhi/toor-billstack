const mongoose = require("mongoose");

const Invoice = require("../models/Invoice");
const Business = require("../models/Business");
const accountingService = require("./accounting.service");
const CreditNote = require("../models/CreditNote");
const SalesReturn = require("../models/SalesReturn");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const AppError = require("../utils/appError");
const { buildInventoryFlags } = require("./inventory.service");
const { createCustomerLedgerEntryOnce } = require("./ledger.service");

const cents = (value) => Math.round(Number(value || 0) * 100);
const money = (minor) => Math.round(Number(minor || 0)) / 100;
const lineValue = (invoiceLine, quantity) => {
  const soldQty = Number(invoiceLine.quantity || 0);
  if (!(soldQty > 0)) return 0;
  return money((cents(invoiceLine.itemTotal || 0) * Number(quantity || 0)) / soldQty);
};

const normalizeSourceKey = ({ prefix, businessId, invoiceId, explicit, number, lines }) =>
  String(explicit || number || `${prefix}:${businessId}:${invoiceId}:${JSON.stringify(lines || [])}`);

const getIssuedCreditUsage = async ({ businessId, invoiceId, session }) => {
  const notes = await CreditNote.find({ businessId, invoiceId, status: "ISSUED" }).session(session);
  const byLine = new Map();
  let totalMinor = 0;
  for (const note of notes) {
    totalMinor += cents(note.totalAmount);
    for (const line of note.lineItems || []) {
      const key = Number(line.invoiceLineIndex);
      const current = byLine.get(key) || { quantity: 0, amountMinor: 0 };
      current.quantity += Number(line.quantity || 0);
      current.amountMinor += cents(line.amount);
      byLine.set(key, current);
    }
  }
  return { byLine, totalMinor };
};

const getIssuedReturnUsage = async ({ businessId, invoiceId, session }) => {
  const returns = await SalesReturn.find({ businessId, invoiceId, status: "ISSUED" }).session(session);
  const byLine = new Map();
  for (const ret of returns) {
    for (const line of ret.lineItems || []) {
      const key = Number(line.invoiceLineIndex);
      byLine.set(key, (byLine.get(key) || 0) + Number(line.quantity || 0));
    }
  }
  return byLine;
};

const createCreditNote = async ({ businessId, userId, payload }) => {
  const session = await mongoose.startSession();
  try {
    let note;
    await session.withTransaction(async () => {
      const inv = await Invoice.findOne({ _id: payload.invoiceId, businessId, status: { $ne: "cancelled" } }).session(session);
      if (!inv) throw new AppError("Eligible invoice not found", 404);

      const rawLines = Array.isArray(payload.lineItems) ? payload.lineItems : [];
      if (!rawLines.length) throw new AppError("At least one credit note line is required", 400);
      const sourceKey = normalizeSourceKey({ prefix: "CREDIT_NOTE", businessId, invoiceId: inv._id, explicit: payload.sourceKey, number: payload.creditNoteNumber, lines: rawLines });
      const priorByKey = await CreditNote.findOne({ businessId, sourceKey }).session(session);
      if (priorByKey) {
        note = priorByKey;
        return;
      }

      const usage = await getIssuedCreditUsage({ businessId, invoiceId: inv._id, session });
      let requestedTotalMinor = 0;
      const lineItems = rawLines.map((line) => {
        const index = Number(line.invoiceLineIndex);
        const sold = inv.lineItems[index];
        if (!sold || sold.productId.toString() !== String(line.productId)) throw new AppError("Credit line does not match invoice line", 400);

        const quantity = Number(line.quantity || 0);
        const amount = Number(line.amount !== undefined ? line.amount : lineValue(sold, quantity));
        if (!(quantity > 0) || !(amount > 0)) throw new AppError("Credit line quantity and amount must be positive", 400);

        const used = usage.byLine.get(index) || { quantity: 0, amountMinor: 0 };
        const remainingQty = Number(sold.quantity || 0) - used.quantity;
        const remainingAmountMinor = cents(sold.itemTotal || 0) - used.amountMinor;
        if (quantity > remainingQty || cents(amount) > remainingAmountMinor) {
          throw new AppError("Credit line exceeds remaining eligible quantity or value", 400);
        }
        requestedTotalMinor += cents(amount);
        return { invoiceLineIndex: index, productId: sold.productId, quantity, amount: money(cents(amount)) };
      });

      if (requestedTotalMinor <= 0 || usage.totalMinor + requestedTotalMinor > cents(inv.grandTotal)) {
        throw new AppError("Credit exceeds eligible invoice amount", 400);
      }

      [note] = await CreditNote.create(
        [{
          businessId,
          invoiceId: inv._id,
          customerId: inv.customerId,
          creditNoteNumber: payload.creditNoteNumber || `CN-${Date.now()}`,
          sourceKey,
          lineItems,
          totalAmount: money(requestedTotalMinor),
          createdBy: userId,
        }],
        { session }
      );

      await createCustomerLedgerEntryOnce({ businessId, customerId: inv.customerId, eventType: "CREDIT", amount: note.totalAmount, direction: "CREDIT", invoiceId: inv._id, sourceKey: `CREDIT_NOTE:${note._id}`, createdBy: userId, notes: "Credit note issued" }, { session });
      const business = await Business.findById(businessId).session(session);
      await accountingService.postCreditNoteJournalEntry({ note, invoice: inv, business, userId, session });
    });
    return note;
  } finally {
    session.endSession();
  }
};

const createSalesReturn = async ({ businessId, userId, payload }) => {
  const session = await mongoose.startSession();
  try {
    let ret;
    await session.withTransaction(async () => {
      const inv = await Invoice.findOne({ _id: payload.invoiceId, businessId, status: { $ne: "cancelled" } }).session(session);
      if (!inv) throw new AppError("Eligible invoice not found", 404);
      const rawLines = Array.isArray(payload.lineItems) ? payload.lineItems : [];
      if (!rawLines.length) throw new AppError("At least one return line is required", 400);
      const sourceKey = normalizeSourceKey({ prefix: "SALES_RETURN", businessId, invoiceId: inv._id, explicit: payload.sourceKey, number: payload.returnNumber, lines: rawLines });
      const prior = await SalesReturn.findOne({ businessId, sourceKey }).session(session);
      if (prior) {
        ret = prior;
        return;
      }

      const returnedByLine = await getIssuedReturnUsage({ businessId, invoiceId: inv._id, session });
      const lines = [];
      let totalMinor = 0;
      for (const line of rawLines) {
        const index = Number(line.invoiceLineIndex);
        const sold = inv.lineItems[index];
        if (!sold || sold.productId.toString() !== String(line.productId)) throw new AppError("Return line does not match invoice line", 400);
        const quantity = Number(line.quantity || 0);
        const alreadyReturned = returnedByLine.get(index) || 0;
        if (!(quantity > 0) || quantity > Number(sold.quantity || 0) - alreadyReturned) throw new AppError("Return quantity exceeds remaining quantity", 400);

        const product = await Product.findOne({ _id: line.productId, businessId }).session(session);
        if (!product) throw new AppError("Return product not found", 404);
        const previousStock = product.currentStock;
        product.currentStock += quantity;
        Object.assign(product, buildInventoryFlags(product));
        await product.save({ session });
        await StockMovement.create(
          [{ businessId, productId: product._id, type: "RETURN", quantity, previousStock, newStock: product.currentStock, reason: "Sales return", referenceType: "RETURN", referenceId: sourceKey, createdBy: userId }],
          { session }
        );

        totalMinor += cents(lineValue(sold, quantity));
        lines.push({ invoiceLineIndex: index, productId: sold.productId, quantity });
      }

      [ret] = await SalesReturn.create(
        [{ businessId, invoiceId: inv._id, customerId: inv.customerId, returnNumber: payload.returnNumber || `RET-${Date.now()}`, sourceKey, lineItems: lines, totalAmount: money(totalMinor), createdBy: userId }],
        { session }
      );
      await createCustomerLedgerEntryOnce({ businessId, customerId: inv.customerId, eventType: "CREDIT", amount: ret.totalAmount, direction: "CREDIT", invoiceId: inv._id, sourceKey: `SALES_RETURN:${ret._id}`, createdBy: userId, notes: "Sales return adjustment" }, { session });
      const business = await Business.findById(businessId).session(session);
      await accountingService.postSalesReturnJournalEntry({ ret, invoice: inv, business, userId, session });
    });
    return ret;
  } finally {
    session.endSession();
  }
};

module.exports = {
  createCreditNote,
  createSalesReturn,
  listCreditNotes: ({ businessId }) => CreditNote.find({ businessId }).sort("-createdAt"),
  listSalesReturns: ({ businessId }) => SalesReturn.find({ businessId }).sort("-createdAt"),
  getCreditNote: ({ businessId, id }) => CreditNote.findOne({ _id: id, businessId }),
  getSalesReturn: ({ businessId, id }) => SalesReturn.findOne({ _id: id, businessId }),
};
