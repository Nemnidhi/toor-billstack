const Expense = require("../models/Expense");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const { EXPENSE_CATEGORIES } = require("../constants/expenses");
const {
  cancelExpense,
  createExpense,
  getExpenseSummary,
  listExpenses,
  updateExpense,
} = require("../services/expense.service");

const list = asyncHandler(async (req, res) => {
  const data = await listExpenses({ businessId: req.tenant.businessId, query: req.query });
  res.status(200).json({ message: "Expenses fetched successfully", data });
});

const summary = asyncHandler(async (req, res) => {
  const data = await getExpenseSummary({ businessId: req.tenant.businessId, query: req.query });
  res.status(200).json({ message: "Expense summary fetched successfully", data });
});

const categories = asyncHandler(async (_req, res) => {
  res.status(200).json({ message: "Expense categories fetched successfully", data: EXPENSE_CATEGORIES });
});

const detail = asyncHandler(async (req, res) => {
  const expense = await Expense.findOne({ _id: req.params.expenseId, businessId: req.tenant.businessId }).populate("supplierId", "supplierName");
  if (!expense) throw new AppError("Expense not found", 404);
  res.status(200).json({ message: "Expense fetched successfully", data: expense });
});

// Bill photo / PDF -> the expense form's fields (Claude vision). Nothing is saved.
const readBill = asyncHandler(async (req, res) => {
  const { fileBase64, fileName } = req.body || {};
  const data = await require("../services/bill-reader.service").readBill({ businessId: req.tenant.businessId, userId: req.user._id, fileBase64, fileName });
  res.json({ success: true, data });
});

const readBillStatus = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { enabled: require("../services/bill-reader.service").isConfigured() } });
});

const create = asyncHandler(async (req, res) => {
  const expense = await createExpense({ businessId: req.tenant.businessId, userId: req.user._id, payload: req.body });
  res.status(201).json({ message: "Expense created successfully", data: expense });
});

const update = asyncHandler(async (req, res) => {
  const expense = await updateExpense({ businessId: req.tenant.businessId, expenseId: req.params.expenseId, userId: req.user._id, payload: req.body });
  res.status(200).json({ message: "Expense updated successfully", data: expense });
});

const cancel = asyncHandler(async (req, res) => {
  const expense = await cancelExpense({ businessId: req.tenant.businessId, expenseId: req.params.expenseId, userId: req.user._id, reason: req.body.reason });
  res.status(200).json({ message: "Expense cancelled successfully", data: expense });
});

module.exports = { cancel, categories, create, detail, list, readBill, readBillStatus, summary, update };
