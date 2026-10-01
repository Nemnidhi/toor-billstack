const mongoose = require("mongoose");
const Business = require("../models/Business");
const Expense = require("../models/Expense");
const Supplier = require("../models/Supplier");
const AppError = require("../utils/appError");
const accountingService = require("./accounting.service");
const { EXPENSE_CATEGORIES } = require("../constants/expenses");
const { buildInvoiceNumber } = require("../utils/invoice");
const { calculateGst, validateStateCode } = require("../utils/gst");

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const normalizeExpensePayload = async ({ businessId, payload }) => {
  const category = EXPENSE_CATEGORIES.includes(payload.category) ? payload.category : "Miscellaneous";
  const amountBeforeTax = roundMoney(payload.amountBeforeTax ?? payload.amount ?? 0);
  if (!Number.isFinite(amountBeforeTax) || amountBeforeTax < 0) throw new AppError("Invalid expense amount", 400);
  const paymentStatus = String(payload.paymentStatus || "UNPAID").toUpperCase();
  const paymentMethod = String(payload.paymentMethod || "").toUpperCase();
  const paidAmountInput = payload.paidAmount === "" || payload.paidAmount === null || payload.paidAmount === undefined
    ? undefined
    : payload.paidAmount;

  let supplierId = payload.supplierId || null;
  if (supplierId) {
    const supplier = await Supplier.findOne({ _id: supplierId, businessId });
    if (!supplier) throw new AppError("Supplier not found for this business", 404);
  }

  const gstEnabled = Boolean(payload.gstEnabled);
  const gstRate = Number(payload.gstRate || 0);
  if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 100) throw new AppError("Invalid GST rate", 400);

  let gstSnapshot = null;
  let taxAmount = 0;
  let gstType = "NONE";
  if (gstEnabled && gstRate > 0) {
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
  const paidAmount = roundMoney(paidAmountInput ?? (paymentStatus === "PAID" ? totalAmount : 0));
  if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new AppError("Invalid expense paid amount", 400);
  if (paidAmount > totalAmount) throw new AppError("Expense paid amount cannot exceed total amount", 400);
  const balanceAmount = roundMoney(totalAmount - paidAmount);
  let normalizedPaymentStatus = paymentStatus;
  if (paidAmount === 0) normalizedPaymentStatus = "UNPAID";
  else if (paidAmount < totalAmount) normalizedPaymentStatus = "PARTIAL";
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
    gstEnabled,
    gstRate,
    gstType,
    gstSnapshot,
    paymentStatus: normalizedPaymentStatus,
    paymentMethod,
    referenceNumber: payload.referenceNumber?.trim() || "",
    notes: payload.notes?.trim() || "",
  };
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
      [expense] = await Expense.create([{ businessId, expenseNumber, ...normalized, createdBy: userId, updatedBy: userId }], { session });
      const business = await Business.findById(businessId).session(session);
      await accountingService.postExpenseJournalEntry({ expense, business, userId, session });
    });
    return expense;
  } finally {
    session.endSession();
  }
};

const updateExpense = async ({ businessId, expenseId, userId, payload }) => {
  const expense = await Expense.findOne({ _id: expenseId, businessId });
  if (!expense) throw new AppError("Expense not found", 404);
  if (expense.status === "CANCELLED") throw new AppError("Cancelled expenses cannot be edited", 409);
  const normalized = await normalizeExpensePayload({ businessId, payload: { ...expense.toObject(), ...payload } });
  Object.assign(expense, normalized, { updatedBy: userId });
  await expense.save();
  return expense;
};

const cancelExpense = async ({ businessId, expenseId, userId, reason = "" }) => {
  const expense = await Expense.findOne({ _id: expenseId, businessId });
  if (!expense) throw new AppError("Expense not found", 404);
  if (expense.status === "CANCELLED") return expense;
  expense.status = "CANCELLED";
  expense.cancelledAt = new Date();
  expense.cancellationReason = reason;
  expense.updatedBy = userId;
  await expense.save();
  return expense;
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
    const regex = new RegExp(String(query.search).trim(), "i");
    filter.$or = [{ expenseNumber: regex }, { description: regex }, { vendorName: regex }, { referenceNumber: regex }];
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
