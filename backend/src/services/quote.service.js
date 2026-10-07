const mongoose = require("mongoose");

const Business = require("../models/Business");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Product = require("../models/Product");
const Quote = require("../models/Quote");
const StockMovement = require("../models/StockMovement");
const AppError = require("../utils/appError");
const { buildGstSnapshot, validateGstin, validateStateCode } = require("../utils/gst");
const { buildInvoiceNumber, buildInvoiceTotals } = require("../utils/invoice");
const { buildTaxDocument } = require("../utils/tax-document");
const { log } = require("../utils/logger");
const { generateQuotePdfBuffer } = require("../utils/pdfQuote");
const { dispatchInvoiceIssuedAutomation } = require("./communication.service");
const { buildInventoryFlags } = require("./inventory.service");
const { createCustomerLedgerEntryOnce } = require("./ledger.service");

const normalizeLineItems = async ({ businessId, rawItems, session }) => {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) throw new AppError("At least one quote line item is required", 400);

  const productIds = items.map((item) => item.productId).filter(Boolean);
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds }, businessId }).session(session)
    : [];
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));

  return items.map((item) => {
    if (item.productId) {
      const product = productMap.get(String(item.productId));
      if (!product) throw new AppError("One or more quote products are invalid", 400);
      return {
        productId: product._id,
        productName: item.productName || product.name,
        hsnSac: item.hsnSac !== undefined && item.hsnSac !== "" ? item.hsnSac : (product.hsnSac || ""),
        gstClassification: item.gstClassification || product.gstClassification || "TAXABLE",
        isManual: false,
        quantity: Number(item.quantity || 0),
        rate: Number(item.rate ?? product.sellingPrice ?? 0),
        taxRate: Number(item.taxRate ?? item.tax ?? product.taxRate ?? 0),
        discountType: item.discountType === "amount" ? "amount" : "percent",
        discountValue: Number(item.discountValue !== undefined ? item.discountValue : item.discount ?? product.discount ?? 0),
      };
    }

    const manualName = String(item.productName || item.name || "").trim();
    if (!manualName) throw new AppError("One or more quote products are invalid", 400);
    return {
      productId: null,
      productName: manualName,
      hsnSac: String(item.hsnSac || "").trim(),
      gstClassification: item.gstClassification || "TAXABLE",
      isManual: true,
      quantity: Number(item.quantity || 0),
      rate: Number(item.rate || 0),
      taxRate: Number(item.taxRate ?? item.tax ?? 0),
      discountType: item.discountType === "amount" ? "amount" : "percent",
      discountValue: Number(item.discountValue !== undefined ? item.discountValue : item.discount ?? 0),
    };
  });
};

const buildCustomerSnapshot = (customer) => ({
  name: customer.name,
  email: customer.email,
  phone: customer.phone,
  address: customer.billingAddress,
  gstNumber: customer.gstNumber,
});

const buildBusinessSnapshot = (business) => ({
  name: business.name,
  email: business.email || business.billingEmail,
  phone: business.phone,
  address: business.address,
  gstNumber: business.gstTaxId,
});

const syncCustomerInvoiceHistory = async ({ customer, businessId, session }) => {
  const invoices = await Invoice.find({ businessId, customerId: customer._id, status: { $ne: "cancelled" } })
    .sort("-invoiceDate")
    .session(session);
  customer.invoiceHistory = invoices.map((invoice) => ({
    invoiceNumber: invoice.invoiceNumber,
    amount: invoice.grandTotal,
    status: invoice.paymentStatus,
    issuedAt: invoice.invoiceDate,
  }));
  await customer.save({ session });
};

const applyInvoiceStockDelta = async ({ business, businessId, invoiceId, nextItems, createdBy, session }) => {
  const productIds = [...new Set(nextItems.map((item) => item.productId).filter(Boolean).map((productId) => productId.toString()))];
  if (productIds.length !== nextItems.length) throw new AppError("One or more quote products are invalid", 400);
  const products = await Product.find({ _id: { $in: productIds }, businessId }).session(session);
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));

  for (const item of nextItems) {
    const product = productMap.get(item.productId.toString());
    if (!product) throw new AppError("Invoice product not found", 400);
    if (!product.trackInventory) continue;

    const quantity = Number(item.quantity || 0);
    const previousStock = product.currentStock;
    const newStock = previousStock - quantity;
    if (!business.inventorySettings?.allowNegativeStock && newStock < 0) {
      throw new AppError(`Insufficient stock for ${product.name}`, 403);
    }

    product.currentStock = newStock;
    Object.assign(product, buildInventoryFlags(product));
    await product.save({ session });
    await StockMovement.create(
      [{
        businessId,
        productId: product._id,
        type: "OUT",
        quantity,
        previousStock,
        newStock,
        reason: `Invoice issue for ${invoiceId}`,
        referenceType: "INVOICE",
        referenceId: invoiceId.toString(),
        createdBy,
      }],
      { session }
    );
  }
};

const createQuote = async ({ businessId, userId, payload }) => {
  const session = await mongoose.startSession();
  try {
    let quote;
    await session.withTransaction(async () => {
      const [customer, business] = await Promise.all([
        Customer.findOne({ _id: payload.customerId, businessId }).session(session),
        Business.findOne({ _id: businessId }).session(session),
      ]);
      if (!customer || !business) throw new AppError("Customer or business not found", 404);

      const items = await normalizeLineItems({ businessId, rawItems: payload.lineItems, session });
      const { totals, gstSnapshot } = buildTaxDocument({ business, counterparty: customer, placeOfSupplyCode: payload.placeOfSupplyCode, lineItems: items, shippingCharges: payload.shippingCharges, roundOff: payload.roundOff });
      const numbering = business.quoteNumbering || {};
      const sequence = numbering.nextSequence || 1;
      const quoteNumber = buildInvoiceNumber({
        prefix: numbering.prefix || "QUO",
        format: numbering.format || "QUO-{YYYY}-{0001}",
        sequence,
        date: new Date(),
      });

      [quote] = await Quote.create(
        [{
          businessId,
          customerId: customer._id,
          quoteNumber,
          lineItems: totals.lineItems,
          subtotal: totals.subtotal,
          totalTax: totals.totalTax,
          totalDiscount: totals.totalDiscount,
          grandTotal: totals.grandTotal,
          gstSnapshot, placeOfSupplyCode: gstSnapshot?.placeOfSupplyCode || "", shippingCharges: totals.shippingCharges, roundOff: totals.roundOff,
          customerSnapshot: buildCustomerSnapshot(customer),
          businessSnapshot: buildBusinessSnapshot(business),
          createdBy: userId,
        }],
        { session }
      );

      business.quoteNumbering = {
        prefix: numbering.prefix || "QUO",
        format: numbering.format || "QUO-{YYYY}-{0001}",
        nextSequence: sequence + 1,
      };
      await business.save({ session });
    });
    return quote;
  } finally {
    session.endSession();
  }
};

const listQuotes = ({ businessId }) => Quote.find({ businessId }).sort("-createdAt");
const getQuote = ({ businessId, id }) => Quote.findOne({ _id: id, businessId });

const updateQuote = async ({ businessId, id, payload }) => {
  const session = await mongoose.startSession();
  try {
    let quote;
    await session.withTransaction(async () => {
      quote = await Quote.findOne({ _id: id, businessId }).session(session);
      if (!quote) throw new AppError("Quote not found", 404);
      if (quote.status !== "DRAFT") throw new AppError("Only draft quotes can be edited", 400);

      const [customer, business] = await Promise.all([
        Customer.findOne({ _id: payload.customerId || quote.customerId, businessId }).session(session),
        Business.findOne({ _id: businessId }).session(session),
      ]);
      if (!customer || !business) throw new AppError("Customer or business not found", 404);

      const items = await normalizeLineItems({ businessId, rawItems: payload.lineItems || quote.lineItems, session });
      const { totals, gstSnapshot } = buildTaxDocument({ business, counterparty: customer, placeOfSupplyCode: payload.placeOfSupplyCode ?? quote.placeOfSupplyCode, lineItems: items, shippingCharges: payload.shippingCharges ?? quote.shippingCharges, roundOff: payload.roundOff ?? quote.roundOff });

      quote.customerId = customer._id;
      quote.lineItems = totals.lineItems;
      quote.subtotal = totals.subtotal;
      quote.totalTax = totals.totalTax;
      quote.totalDiscount = totals.totalDiscount;
      quote.grandTotal = totals.grandTotal;
      quote.gstSnapshot = gstSnapshot; quote.placeOfSupplyCode = gstSnapshot?.placeOfSupplyCode || ""; quote.shippingCharges = totals.shippingCharges; quote.roundOff = totals.roundOff;
      quote.customerSnapshot = buildCustomerSnapshot(customer);
      quote.businessSnapshot = buildBusinessSnapshot(business);
      await quote.save({ session });
    });
    return quote;
  } finally {
    session.endSession();
  }
};

const setQuoteStatus = async ({ businessId, id, status }) => {
  const quote = await Quote.findOne({ _id: id, businessId });
  if (!quote) throw new AppError("Quote not found", 404);
  const allowed = { DRAFT: ["SENT"], SENT: ["ACCEPTED", "REJECTED", "EXPIRED"], ACCEPTED: [], REJECTED: [], EXPIRED: [], CONVERTED: [] };
  if (!allowed[quote.status]?.includes(status)) throw new AppError("Invalid quote lifecycle transition", 400);
  quote.status = status;
  return quote.save();
};

const convertQuote = async ({ businessId, userId, id }) => {
  const session = await mongoose.startSession();
  try {
    let invoice;
    await session.withTransaction(async () => {
      const quote = await Quote.findOne({ _id: id, businessId }).session(session);
      if (!quote) throw new AppError("Quote not found", 404);
      if (quote.convertedInvoiceId) {
        invoice = await Invoice.findOne({ _id: quote.convertedInvoiceId, businessId }).session(session);
        return;
      }
      if (quote.status !== "ACCEPTED") throw new AppError("Only accepted quotes can be converted", 400);

      const existing = await Invoice.findOne({ businessId, sourceQuoteId: quote._id }).session(session);
      if (existing) {
        quote.convertedInvoiceId = existing._id;
        quote.status = "CONVERTED";
        await quote.save({ session });
        invoice = existing;
        return;
      }

      const [business, customer] = await Promise.all([
        Business.findOne({ _id: businessId }).session(session),
        Customer.findOne({ _id: quote.customerId, businessId }).session(session),
      ]);
      if (!business || !customer) throw new AppError("Business or customer not found", 404);

      const productIds = quote.lineItems.map((item) => item.productId).filter(Boolean);
      const products = productIds.length ? await Product.find({ _id: { $in: productIds }, businessId }).session(session) : [];
      const { totals, gstSnapshot } = buildTaxDocument({ business, counterparty: customer, products, lineItems: quote.lineItems, placeOfSupplyCode: quote.placeOfSupplyCode, shippingCharges: quote.shippingCharges, roundOff: quote.roundOff, amountPaid: 0 });

      const sequence = business.invoiceNumbering?.nextSequence || 1;
      const invoiceDate = new Date();
      const [created] = await Invoice.create(
        [{
          businessId,
          customerId: customer._id,
          invoiceNumber: buildInvoiceNumber({ prefix: business.invoiceNumbering?.prefix, format: business.invoiceNumbering?.format, sequence, date: invoiceDate }),
          invoiceDate,
          dueDate: invoiceDate,
          customerDetails: buildCustomerSnapshot(customer),
          businessDetails: buildBusinessSnapshot(business),
          lineItems: totals.lineItems,
          subtotal: totals.subtotal,
          totalTax: totals.totalTax,
          totalDiscount: totals.totalDiscount,
          shippingCharges: totals.shippingCharges,
          roundOff: totals.roundOff,
          grandTotal: totals.grandTotal,
          amountPaid: 0,
          balanceDue: totals.grandTotal,
          paymentStatus: "unpaid",
          gstSnapshot,
          gstBreakup: gstSnapshot ? { cgst: gstSnapshot.cgst, sgst: gstSnapshot.sgst, utgst: gstSnapshot.utgst, igst: gstSnapshot.igst, taxableValue: gstSnapshot.taxableValue, hsnSacSummary: gstSnapshot.hsnSacSummary } : undefined,
          status: "issued",
          sourceQuoteId: quote._id,
          createdBy: userId,
        }],
        { session }
      );
      invoice = created;

      await createCustomerLedgerEntryOnce({ businessId, customerId: customer._id, eventType: "INVOICE", amount: invoice.grandTotal, direction: "DEBIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:DEBIT`, createdBy: userId }, { session });
      business.invoiceNumbering.nextSequence = sequence + 1;
      await business.save({ session });

      await applyInvoiceStockDelta({ business, businessId, invoiceId: invoice._id, nextItems: totals.lineItems, createdBy: userId, session });
      await syncCustomerInvoiceHistory({ customer, businessId, session });

      quote.convertedInvoiceId = invoice._id;
      quote.status = "CONVERTED";
      await quote.save({ session });
    });
    if (invoice?._id) {
      await dispatchInvoiceIssuedAutomation({ businessId, invoiceId: invoice._id, createdBy: userId })
        .catch((error) => log("warn", "Quote invoice issued automation failed", { invoiceId: invoice._id.toString(), error: error.message }));
    }
    return invoice;
  } finally {
    session.endSession();
  }
};

const generateQuotePdf = async ({ businessId, id }) => {
  const [quote, business] = await Promise.all([
    Quote.findOne({ _id: id, businessId }).populate("customerId", "name email phone"),
    Business.findOne({ _id: businessId }),
  ]);
  if (!quote) throw new AppError("Quote not found", 404);
  return generateQuotePdfBuffer({ quote, business });
};

module.exports = { normalizeLineItems, createQuote, listQuotes, getQuote, setQuoteStatus, convertQuote, updateQuote, generateQuotePdf };
