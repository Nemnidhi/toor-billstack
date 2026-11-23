const mongoose = require("mongoose");
const { searchRegex } = require("../utils/search");
const Business = require("../models/Business");
const Expense = require("../models/Expense");
const Supplier = require("../models/Supplier");
const AppError = require("../utils/appError");
const accountingService = require("./accounting.service");
const { EXPENSE_CATEGORIES } = require("../constants/expenses");
const { buildInvoiceNumber } = require("../utils/invoice");
const { calculateGst, validateStateCode } = require("../utils/gst");

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const { tdsKind: findTdsKind, TDS_NO_PAN_RATE } = require("../constants/tds");
const { normalizeTdsKind } = require("../utils/tax-ids");
const { cleanTags } = require("./reporting-tags.service");

// TDS on this bill: the kind comes from the bill or the supplier's default; the rate from the
// bill, else the supplier's own rate (lower-deduction certificate), else the usual rate (20% at
// least when the supplier has no PAN); the amount from the bill, else rate x amount before GST,
// rounded to the rupee.
const resolveExpenseTds = ({ payload, supplier, amountBeforeTax }) => {
  const kindKey = normalizeTdsKind(payload.tdsKind !== undefined ? payload.tdsKind : supplier?.tdsKind || "");
  if (!kindKey) return { tdsKind: "", tdsRate: 0, tdsAmount: 0 };
  const kind = findTdsKind(kindKey);
  let rate = payload.tdsRate !== undefined && payload.tdsRate !== null && payload.tdsRate !== "" ? Number(payload.tdsRate) : null;
  if (rate === null) {
    rate = supplier?.tdsRate !== null && supplier?.tdsRate !== undefined ? Number(supplier.tdsRate) : kind.rate;
    if (supplier && !supplier.pan) rate = Math.max(rate, TDS_NO_PAN_RATE);
  }
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new AppError("TDS rate must be between 0 and 100", 400);
  const given = payload.tdsAmount !== undefined && payload.tdsAmount !== null && payload.tdsAmount !== "";
  const tdsAmount = given ? roundMoney(Number(payload.tdsAmount)) : Math.round((amountBeforeTax * rate) / 100);
  if (!Number.isFinite(tdsAmount) || tdsAmount < 0) throw new AppError("Invalid TDS amount", 400);
  return { tdsKind: kindKey, tdsRate: rate, tdsAmount };
};

const normalizeExpensePayload = async ({ businessId, payload, previous = {} }) => {
  const category = EXPENSE_CATEGORIES.includes(payload.category) ? payload.category : "Miscellaneous";
  const amountBeforeTax = roundMoney(payload.amountBeforeTax ?? payload.amount ?? 0);
  if (!Number.isFinite(amountBeforeTax) || amountBeforeTax < 0) throw new AppError("Invalid expense amount", 400);
  const paymentStatus = String(payload.paymentStatus || "UNPAID").toUpperCase();
  const paymentMethod = String(payload.paymentMethod || "").toUpperCase();
  const paidAmountInput = payload.paidAmount === "" || payload.paidAmount === null || payload.paidAmount === undefined
    ? undefined
    : payload.paidAmount;

  let supplierId = payload.supplierId || null;
  let supplier = null;
  if (supplierId) {
    supplier = await Supplier.findOne({ _id: supplierId, businessId });
    if (!supplier) throw new AppError("Supplier not found for this business", 404);
  }

  const gstEnabled = Boolean(payload.gstEnabled);
  const gstRate = Number(payload.gstRate || 0);
  if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) throw new AppError("Invalid GST rate", 400);

  let gstSnapshot = null;
  let taxAmount = 0;
  let gstType = "NONE";
  const reverseCharge = payload.gstType === "REVERSE_CHARGE" || payload.reverseCharge === true || payload.reverseCharge === "true";
  if (reverseCharge) {
    // The supplier charges no GST; we owe it ourselves (paid in cash) and can claim it back.
    const business = await Business.findById(businessId);
    const stateCode = business?.gstConfiguration?.stateCode || "";
    if (!business?.gstConfiguration?.enabled || !stateCode) throw new AppError("Reverse charge applies only to a GST-registered company. Turn on GST in Settings first.", 400);
    const rcmRate = gstRate > 0 ? gstRate : 18;
    const gst = calculateGst({ taxableValue: amountBeforeTax, rate: rcmRate, supplierStateCode: payload.placeOfSupplyCode || stateCode, placeOfSupplyCode: stateCode, exempt: false });
    gstType = "REVERSE_CHARGE";
    gstSnapshot = { ...gst, reverseCharge: true, wording: "GST payable by the recipient under reverse charge", inputTaxCreditClaimed: false };
  } else if (gstEnabled && gstRate > 0) {
    const business = await Business.findById(businessId);
    const stateCode = business?.gstConfiguration?.stateCode || "";
    if (business?.gstConfiguration?.enabled && stateCode && !validateStateCode(stateCode)) {
      throw new AppError("Invalid business GST state code", 400);
    }
    const gst = calculateGst({
      taxableValue: amountBeforeTax,
      rate: gstRate,
      supplierStateCode: stateCode,
      placeOfSupplyCode: payload.placeOfSupplyCode || stateCode,
      exempt: false,
    });
    taxAmount = gst.totalTax;
    gstType = "GST_RECORDED";
    gstSnapshot = { ...gst, wording: "GST recorded", inputTaxCreditClaimed: false };
  } else if (payload.gstType === "EXEMPT") {
    gstType = "EXEMPT";
    gstSnapshot = { taxableValue: amountBeforeTax, rate: 0, totalTax: 0, exempt: true, wording: "GST recorded as exempt", inputTaxCreditClaimed: false };
  }

  const totalAmount = roundMoney(amountBeforeTax + taxAmount);
  const tds = resolveExpenseTds({ payload, supplier, amountBeforeTax });
  if (tds.tdsAmount > totalAmount) throw new AppError("TDS cannot be more than the bill", 400);
  // The supplier is owed the bill less the TDS we keep back for the government.
  const payableAmount = roundMoney(totalAmount - tds.tdsAmount);
  const paidAmount = roundMoney(paidAmountInput ?? (paymentStatus === "PAID" ? payableAmount : 0));
  if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new AppError("Invalid expense paid amount", 400);
  if (paidAmount > payableAmount) throw new AppError(tds.tdsAmount ? "Paid amount cannot exceed the bill less TDS" : "Expense paid amount cannot exceed total amount", 400);
  const balanceAmount = roundMoney(payableAmount - paidAmount);
  let normalizedPaymentStatus = paymentStatus;
  if (paidAmount === 0 && payableAmount > 0) normalizedPaymentStatus = "UNPAID";
  else if (paidAmount < payableAmount) normalizedPaymentStatus = "PARTIAL";
  else normalizedPaymentStatus = "PAID";
  if (paymentStatus !== normalizedPaymentStatus) {
    throw new AppError(`Invalid expense payment state: ${paymentStatus} does not match paid amount`, 400);
  }
  return {
    expenseDate: payload.expenseDate ? new Date(payload.expenseDate) : new Date(),
    category,
    customCategory: payload.customCategory?.trim() || "",
    description: payload.description?.trim() || "",
    vendorName: payload.vendorName?.trim() || "",
    supplierId,
    amountBeforeTax,
    taxAmount,
    totalAmount,
    paidAmount,
    balanceAmount,
    gstEnabled: gstType === "REVERSE_CHARGE" ? false : gstEnabled,
    gstRate: gstType === "REVERSE_CHARGE" ? gstSnapshot.rate ?? (gstRate || 18) : gstRate,
    gstType,
    gstSnapshot,
    supplierInvoiceNumber: String(payload.supplierInvoiceNumber || "").trim().slice(0, 40),
    supplierInvoiceDate: payload.supplierInvoiceDate ? new Date(payload.supplierInvoiceDate) : null,
    supplierGstin: String(payload.supplierGstin || supplier?.gstNumber || "").trim().toUpperCase().slice(0, 15),
    placeOfSupplyCode: String(payload.placeOfSupplyCode || "").trim().slice(0, 2),
    itcEligible: !(payload.itcEligible === false || payload.itcEligible === "false"),
    paymentStatus: normalizedPaymentStatus,
    paymentMethod,
    referenceNumber: payload.referenceNumber?.trim() || "",
    notes: payload.notes?.trim() || "",
    centre: String(payload.centre || "").trim().slice(0, 80),
    ...(await cleanTags(businessId, { businessLine: payload.businessLine, reportCategory: payload.reportCategory }, previous)),
    ...tds,
  };
};

// Self-invoice for a reverse-charge supply: our own series per financial year, RCM/26-27/0001.
const nextSelfInvoiceNumber = async ({ businessId, date, session }) => {
  const d = new Date(date || Date.now());
  const fyStart = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const prefix = `RCM/${String(fyStart).slice(2)}-${String((fyStart + 1) % 100).padStart(2, "0")}/`;
  const last = await Expense.find({ businessId, selfInvoiceNumber: { $regex: `^${prefix.replace(/\//g, "\\/")}` } }).select("selfInvoiceNumber").session(session).lean();
  const highest = last.reduce((max, row) => Math.max(max, Number(String(row.selfInvoiceNumber).slice(prefix.length)) || 0), 0);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
};

const nextExpenseNumber = async ({ businessId, session }) => {
  const business = await Business.findById(businessId).session(session);
  if (!business) throw new AppError("Business not found", 404);
  const numbering = business.expenseNumbering || { prefix: "EXP", format: "EXP-{YYYY}-{0001}", nextSequence: 1 };
  const sequence = numbering.nextSequence || 1;
  const expenseNumber = buildInvoiceNumber({ prefix: numbering.prefix || "EXP", format: numbering.format || "EXP-{YYYY}-{0001}", sequence });
  business.expenseNumbering = { prefix: numbering.prefix || "EXP", format: numbering.format || "EXP-{YYYY}-{0001}", nextSequence: sequence + 1 };
  await business.save({ session });
  return expenseNumber;
};

const createExpense = async ({ businessId, userId, payload }) => {
  const session = await mongoose.startSession();
  try {
    let expense;
    await session.withTransaction(async () => {
      const normalized = await normalizeExpensePayload({ businessId, payload });
      const expenseNumber = await nextExpenseNumber({ businessId, session });
      if (normalized.gstType === "REVERSE_CHARGE") normalized.selfInvoiceNumber = await nextSelfInvoiceNumber({ businessId, date: normalized.expenseDate, session });
      [expense] = await Expense.create([{ businessId, expenseNumber, ...normalized, createdBy: userId, updatedBy: userId }], { session });
      const business = await Business.findById(businessId).session(session);
      await accountingService.postExpenseJournalEntry({ expense, business, userId, session });
    });
    return expense;
  } finally {
    session.endSession();
  }
};

// Edits and cancellations move the journal with the expense, in the same transaction,
// so the Profit & Loss and the bank / payables never disagree with the expense list.
const updateExpense = async ({ businessId, expenseId, userId, payload }) => {
  const session = await mongoose.startSession();
  try {
    let expense;
    await session.withTransaction(async () => {
      expense = await Expense.findOne({ _id: expenseId, businessId }).session(session);
      if (!expense) throw new AppError("Expense not found", 404);
      if (expense.status === "CANCELLED") throw new AppError("Cancelled expenses cannot be edited", 409);
      const previousExpenseDate = expense.expenseDate;
      const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
      const differs = (key, current) => has(key) && String(payload[key] ?? "") !== String(current ?? "");
      if (expense.tdsChallanId && (differs("amountBeforeTax", expense.amountBeforeTax) || differs("amount", expense.amountBeforeTax) || differs("tdsAmount", expense.tdsAmount) || differs("tdsKind", expense.tdsKind) || differs("tdsRate", expense.tdsRate) || differs("supplierId", expense.supplierId))) {
        throw new AppError("The TDS on this bill is already deposited by a challan. Cancel that challan first to change the amount, supplier or TDS.", 409);
      }
      const merged = { ...expense.toObject(), ...payload };
      // TDS follows the bill: unless a TDS amount is typed in, work it out again when the
      // amount, supplier, TDS type or rate changes; a new supplier brings their own TDS type.
      if (!expense.tdsChallanId) {
        if (!has("tdsAmount") && ["amountBeforeTax", "amount", "tdsRate", "tdsKind", "supplierId"].some(has)) delete merged.tdsAmount;
        if (differs("supplierId", expense.supplierId)) {
          if (!has("tdsKind")) delete merged.tdsKind;
          if (!has("tdsRate")) delete merged.tdsRate;
        }
        if (differs("tdsKind", expense.tdsKind) && !has("tdsRate")) delete merged.tdsRate;
      }
      const normalized = await normalizeExpensePayload({ businessId, payload: merged, previous: expense });
      if (normalized.gstType === "REVERSE_CHARGE" && !expense.selfInvoiceNumber) normalized.selfInvoiceNumber = await nextSelfInvoiceNumber({ businessId, date: normalized.expenseDate, session });
      Object.assign(expense, normalized, { updatedBy: userId });
      await expense.save({ session });
      const business = await Business.findById(businessId).session(session);
      await accountingService.repostEditedExpenseJournalEntry({ expense, business, previousExpenseDate, editKey: new mongoose.Types.ObjectId().toString(), userId, session });
    });
    return expense;
  } finally {
    session.endSession();
  }
};

const cancelExpense = async ({ businessId, expenseId, userId, reason = "" }) => {
  const session = await mongoose.startSession();
  try {
    let expense;
    await session.withTransaction(async () => {
      expense = await Expense.findOne({ _id: expenseId, businessId }).session(session);
      if (!expense) throw new AppError("Expense not found", 404);
      if (expense.status === "CANCELLED") return;
      if (expense.tdsChallanId) throw new AppError("The TDS on this bill is already deposited by a challan. Cancel that challan first.", 409);
      const asset = await require("../models/FixedAsset").findOne({ businessId, expenseId: expense._id, status: { $ne: "CANCELLED" } }).session(session).lean();
      if (asset) throw new AppError(`This bill is in the fixed asset register as ${asset.assetNumber}. Cancel or dispose of the asset first.`, 409);
      expense.status = "CANCELLED";
      expense.cancelledAt = new Date();
      expense.cancellationReason = reason;
      expense.updatedBy = userId;
      await expense.save({ session });
      await accountingService.postExpenseCancellationJournalEntry({ expense, userId, session });
    });
    return expense;
  } finally {
    session.endSession();
  }
};

const buildExpenseFilter = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.category) filter.category = query.category;
  if (query.paymentStatus) filter.paymentStatus = String(query.paymentStatus).toUpperCase();
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.from || query.to) {
    filter.expenseDate = {};
    if (query.from) filter.expenseDate.$gte = new Date(query.from);
    if (query.to) {
      const to = new Date(query.to);
      to.setHours(23, 59, 59, 999);
      filter.expenseDate.$lte = to;
    }
  }
  if (query.search) {
    const regex = searchRegex(query.search);
    if (regex) filter.$or = [{ expenseNumber: regex }, { description: regex }, { vendorName: regex }, { referenceNumber: regex }];
  }
  return filter;
};

const listExpenses = async ({ businessId, query = {} }) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  const filter = buildExpenseFilter({ businessId, query });
  const [items, total] = await Promise.all([
    Expense.find(filter).populate("supplierId", "supplierName").sort({ expenseDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Expense.countDocuments(filter),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) } };
};

const getExpenseSummary = async ({ businessId, query = {} }) => {
  const filter = buildExpenseFilter({ businessId, query });
  filter.status = { $ne: "CANCELLED" };
  const rows = await Expense.find(filter);
  const byCategory = new Map();
  rows.forEach((expense) => {
    byCategory.set(expense.category, roundMoney((byCategory.get(expense.category) || 0) + expense.totalAmount));
  });
  return {
    totalExpenses: roundMoney(rows.reduce((sum, item) => sum + item.totalAmount, 0)),
    paid: roundMoney(rows.reduce((sum, item) => sum + Number(item.paidAmount || 0), 0)),
    unpaid: roundMoney(rows.reduce((sum, item) => sum + Number(item.balanceAmount ?? Math.max(Number(item.totalAmount || 0) - Number(item.paidAmount || 0), 0)), 0)),
    gstRecorded: roundMoney(rows.reduce((sum, item) => sum + item.taxAmount, 0)),
    byCategory: Array.from(byCategory, ([category, amount]) => ({ category, amount })),
  };
};

module.exports = {
  cancelExpense,
  createExpense,
  getExpenseSummary,
  listExpenses,
  normalizeExpensePayload,
  updateExpense,
};
