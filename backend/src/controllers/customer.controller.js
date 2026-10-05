const Business = require("../models/Business");
const Customer = require("../models/Customer");
const CreditNote = require("../models/CreditNote");
const CustomerLedger = require("../models/CustomerLedger");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Quote = require("../models/Quote");
const SalesReturn = require("../models/SalesReturn");
const { getDerivedInvoiceRows } = require("../services/financial-read.service");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const { isOverdueByBusinessDate } = require("../utils/business-date");
const { normalizeCode, states, validGstin, validState } = require("../../../shared/gst-policy.cjs");
const { listCustomerLedger } = require("../services/payment.service");
const {
  buildCustomerStatement,
  buildStatementCsv,
  buildStatementPdfBuffer,
} = require("../services/customer-statement.service");
const {
  buildPaginatedResponse,
  buildPagination,
  buildSearchFilter,
  buildSort,
} = require("../utils/queryFeatures");

const customerSortFields = ["name", "email", "phone", "createdAt", "updatedAt"];

const normalizeCustomerGst = (body) => {
  const gstNumber = String(body.gstNumber || "").trim().toUpperCase();
  if (gstNumber && !validGstin(gstNumber)) throw new AppError("Enter a valid 15-character customer GSTIN, or leave it blank for a non-GST customer.", 400);
  const suppliedState = String(body.stateCode || body.placeOfSupplyCode || "").trim();
  const stateCode = gstNumber ? gstNumber.slice(0, 2) : suppliedState ? normalizeCode(suppliedState) : "";
  if (stateCode && !validState(stateCode)) throw new AppError("Select a valid customer state.", 400);
  return { gstNumber, stateCode, placeOfSupplyCode: stateCode, state: stateCode ? states[stateCode] : "" };
};

const listCustomers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const sort = buildSort(req.query.sortBy, req.query.sortOrder, customerSortFields);
  const searchFilter = buildSearchFilter(req.query.search, [
    "name",
    "email",
    "phone",
    "gstNumber",
  ]);

  const currentBusiness = await Business.findById(req.tenant.businessId);
  const allowedBusinessIds = [req.tenant.businessId];
  if (currentBusiness?.billingParentId) {
    allowedBusinessIds.push(currentBusiness.billingParentId);
  }

  const filters = {
    businessId: { $in: allowedBusinessIds },
    ...searchFilter,
  };

  if (req.query.gstStatus === "with-gst") {
    filters.gstNumber = { $ne: "" };
  }

  if (req.query.gstStatus === "without-gst") {
    filters.gstNumber = "";
  }

  const [items, total] = await Promise.all([
    Customer.find(filters).sort(sort).skip(skip).limit(limit),
    Customer.countDocuments(filters),
  ]);

  res.status(200).json({
    message: "Customers fetched successfully",
    data: buildPaginatedResponse({ items, total, page, limit }),
  });
});

const getCustomerById = asyncHandler(async (req, res) => {
  const currentBusiness = await Business.findById(req.tenant.businessId);
  const allowedBusinessIds = [req.tenant.businessId];
  if (currentBusiness?.billingParentId) {
    allowedBusinessIds.push(currentBusiness.billingParentId);
  }

  const customer = await Customer.findOne({
    _id: req.params.customerId,
    businessId: { $in: allowedBusinessIds },
  });

  if (!customer) {
    throw new AppError("Customer not found", 404);
  }

  const invoices = (await getDerivedInvoiceRows({ businessId: req.tenant.businessId, filter: { customerId: customer._id } })).filter((invoice) => invoice.status !== "cancelled");
  const financialSummary = {
    totalInvoiced: invoices.reduce((sum, invoice) => sum + Number(invoice.grandTotal || 0), 0),
    totalCollected: invoices.reduce((sum, invoice) => sum + Number(invoice.amountPaid || 0), 0),
    outstanding: invoices.reduce((sum, invoice) => sum + Number(invoice.balanceDue || 0), 0),
    overdue: invoices.filter((invoice) => invoice.balanceDue > 0 && isOverdueByBusinessDate(invoice.dueDate)).reduce((sum, invoice) => sum + Number(invoice.balanceDue || 0), 0),
    reconciliationMismatches: invoices.filter((invoice) => invoice.financialRead?.reconciliation?.status === "MISMATCH").length,
  };
  res.status(200).json({
    message: "Customer fetched successfully",
    data: { ...customer.toObject(), financialSummary },
  });
});

const createCustomer = asyncHandler(async (req, res) => {
  const gst = normalizeCustomerGst(req.body);
  const customer = await Customer.create({
    businessId: req.tenant.businessId,
    name: req.body.name.trim(),
    phone: req.body.phone?.trim() || "",
    email: req.body.email?.trim().toLowerCase() || "",
    billingAddress: req.body.billingAddress?.trim() || "",
    shippingAddress: req.body.shippingAddress?.trim() || "",
    gstNumber: gst.gstNumber,
    stateCode: gst.stateCode,
    placeOfSupplyCode: gst.placeOfSupplyCode,
    notes: req.body.notes?.trim() || "",
    invoiceHistory: Array.isArray(req.body.invoiceHistory) ? req.body.invoiceHistory : [],
  });

  res.status(201).json({
    message: "Customer created successfully",
    data: customer,
  });
});

const updateCustomer = asyncHandler(async (req, res) => {
  const currentBusiness = await Business.findById(req.tenant.businessId);
  const allowedBusinessIds = [req.tenant.businessId];
  if (currentBusiness?.billingParentId) {
    allowedBusinessIds.push(currentBusiness.billingParentId);
  }
  const childBusinesses = await Business.find({ billingParentId: req.tenant.businessId }).select("_id");
  childBusinesses.forEach((cb) => allowedBusinessIds.push(cb._id));

  const customer = await Customer.findOne({
    _id: req.params.customerId,
    businessId: { $in: allowedBusinessIds },
  });

  if (!customer) {
    throw new AppError("Customer not found", 404);
  }

  const gst = normalizeCustomerGst(req.body);
  customer.name = req.body.name?.trim() || customer.name;
  customer.phone = req.body.phone?.trim() || "";
  customer.email = req.body.email?.trim().toLowerCase() || "";
  customer.billingAddress = req.body.billingAddress?.trim() || "";
  customer.shippingAddress = req.body.shippingAddress?.trim() || "";
  customer.gstNumber = gst.gstNumber;
  customer.stateCode = gst.stateCode;
  customer.placeOfSupplyCode = gst.placeOfSupplyCode;
  customer.notes = req.body.notes?.trim() || "";

  if (Array.isArray(req.body.invoiceHistory)) {
    customer.invoiceHistory = req.body.invoiceHistory;
  }

  await customer.save();

  res.status(200).json({
    message: "Customer updated successfully",
    data: customer,
  });
});

const deleteCustomer = asyncHandler(async (req, res) => {
  const currentBusiness = await Business.findById(req.tenant.businessId);
  const allowedBusinessIds = [req.tenant.businessId];
  if (currentBusiness?.billingParentId) {
    allowedBusinessIds.push(currentBusiness.billingParentId);
  }
  const childBusinesses = await Business.find({ billingParentId: req.tenant.businessId }).select("_id");
  childBusinesses.forEach((cb) => allowedBusinessIds.push(cb._id));

  const customer = await Customer.findOne({
    _id: req.params.customerId,
    businessId: { $in: allowedBusinessIds },
  });

  if (!customer) {
    throw new AppError("Customer not found", 404);
  }

  const [invoiceCount, paymentCount, ledgerCount, quoteCount, creditNoteCount, returnCount] = await Promise.all([
    Invoice.countDocuments({ businessId: req.tenant.businessId, customerId: customer._id }),
    Payment.countDocuments({ businessId: req.tenant.businessId, customerId: customer._id }),
    CustomerLedger.countDocuments({ businessId: req.tenant.businessId, customerId: customer._id }),
    Quote.countDocuments({ businessId: req.tenant.businessId, customerId: customer._id }),
    CreditNote.countDocuments({ businessId: req.tenant.businessId, customerId: customer._id }),
    SalesReturn.countDocuments({ businessId: req.tenant.businessId, customerId: customer._id }),
  ]);

  if (invoiceCount || paymentCount || ledgerCount || quoteCount || creditNoteCount || returnCount) {
    throw new AppError("Customer has historical financial or sales records and cannot be deleted.", 409);
  }

  await customer.deleteOne();

  res.status(200).json({
    message: "Customer deleted successfully",
  });
});

const getCustomerLedger = asyncHandler(async (req, res) => {
  const currentBusiness = await Business.findById(req.tenant.businessId);
  const allowedBusinessIds = [req.tenant.businessId];
  if (currentBusiness?.billingParentId) {
    allowedBusinessIds.push(currentBusiness.billingParentId);
  }
  const childBusinesses = await Business.find({ billingParentId: req.tenant.businessId }).select("_id");
  childBusinesses.forEach((cb) => allowedBusinessIds.push(cb._id));

  const customer = await Customer.findOne({
    _id: req.params.customerId,
    businessId: { $in: allowedBusinessIds },
  });

  if (!customer) {
    throw new AppError("Customer not found", 404);
  }

  const entries = await listCustomerLedger({
    businessId: req.tenant.businessId,
    customerId: customer._id,
  });

  res.status(200).json({
    message: "Customer ledger fetched successfully",
    data: entries,
  });
});

const getCustomerStatement = asyncHandler(async (req, res) => {
  const statement = await buildCustomerStatement({
    businessId: req.tenant.businessId,
    customerId: req.params.customerId,
    query: req.query,
  });

  res.status(200).json({
    message: "Customer statement fetched successfully",
    data: statement,
  });
});

const exportCustomerStatementCsv = asyncHandler(async (req, res) => {
  const statement = await buildCustomerStatement({
    businessId: req.tenant.businessId,
    customerId: req.params.customerId,
    query: req.query,
  });
  const csv = buildStatementCsv(statement);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"customer-statement-${req.params.customerId}.csv\"`);
  res.status(200).send(csv);
});

const downloadCustomerStatementPdf = asyncHandler(async (req, res) => {
  const statement = await buildCustomerStatement({
    businessId: req.tenant.businessId,
    customerId: req.params.customerId,
    query: req.query,
  });
  const buffer = await buildStatementPdfBuffer(statement);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=\"customer-statement-${req.params.customerId}.pdf\"`);
  res.status(200).send(buffer);
});

module.exports = {
  createCustomer,
  deleteCustomer,
  downloadCustomerStatementPdf,
  exportCustomerStatementCsv,
  getCustomerById,
  getCustomerLedger,
  getCustomerStatement,
  listCustomers,
  updateCustomer,
};
