const mongoose = require("mongoose");
const Payment = require("../models/Payment");
const PaymentAllocation = require("../models/PaymentAllocation");
const PaymentAllocationReversal = require("../models/PaymentAllocationReversal");
const FinancialMigrationProvenance = require("../models/FinancialMigrationProvenance");
const Invoice = require("../models/Invoice");
const Purchase = require("../models/Purchase");
const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const { isOverdueByBusinessDate } = require("../utils/business-date");
const { MIGRATION_TYPE, MIGRATION_VERSION } = require("./financial-migration.service");

const deriveFinancialState = ({ sourceType, document, migrated, allocatedAmount = 0 }) => {
  const legacyPaid = Number(sourceType === "INVOICE" ? document.amountPaid || 0 : document.paidAmount || 0);
  const total = Number(sourceType === "INVOICE" ? document.grandTotal || 0 : document.totalAmount || 0);
  const legacyStatus = document.paymentStatus || "unpaid";
  if (sourceType === "INVOICE" && document.status === "cancelled") return { paidAmount: legacyPaid, outstandingAmount: Number(document.balanceDue || 0), paymentStatus: "cancelled", source: "legacy", reconciliation: { status: "NOT_APPLICABLE", difference: 0 } };
  if (!migrated) return { paidAmount: legacyPaid, outstandingAmount: sourceType === "INVOICE" ? Number(document.balanceDue || 0) : Math.max(total - legacyPaid, 0), paymentStatus: legacyStatus, source: "legacy", reconciliation: { status: "NOT_MIGRATED", difference: 0 } };
  const allocated = fromMinorUnits(toMinorUnits(allocatedAmount, "Allocated amount", { allowZero: true }));
  const totalMinor = toMinorUnits(total, "Document total", { allowZero: true });
  const allocatedMinor = toMinorUnits(allocated, "Allocated amount", { allowZero: true });
  const effectivePaidMinor = Math.min(allocatedMinor, totalMinor);
  const effectivePaid = fromMinorUnits(effectivePaidMinor);
  const outstanding = fromMinorUnits(Math.max(totalMinor - effectivePaidMinor, 0));
  const paymentStatus = effectivePaidMinor >= totalMinor ? "paid" : effectivePaidMinor > 0 ? "partial" : "unpaid";
  const difference = fromMinorUnits(toMinorUnits(legacyPaid, "Legacy paid amount", { allowZero: true }) - toMinorUnits(allocated, "Allocated amount", { allowZero: true }));
  const overAllocated = allocatedMinor > totalMinor;
  return { paidAmount: effectivePaid, outstandingAmount: outstanding, paymentStatus, source: "allocations", reconciliation: { status: difference === 0 && !overAllocated ? "MATCHED" : "MISMATCH", difference, legacyPaidAmount: legacyPaid, allocatedAmount: allocated, overAllocated } };
};

const allocationQuery = ({ businessId, sourceType, sourceDocumentId }) => ({ businessId, [sourceType === "INVOICE" ? "invoiceId" : "purchaseId"]: sourceDocumentId });
const hasDocumentAllocations = async ({ businessId, sourceType, sourceDocumentId, session }) => {
  const query = PaymentAllocation.exists(allocationQuery({ businessId, sourceType, sourceDocumentId }));
  if (session) query.session(session);
  return Boolean(await query);
};
const hasMigratedFinancialState = async ({ businessId, sourceType, sourceDocumentId, session }) => {
  const query = FinancialMigrationProvenance.exists({ businessId, sourceType, sourceDocumentId, migrationType: MIGRATION_TYPE, migrationVersion: MIGRATION_VERSION, state: "MIGRATED" });
  if (session) query.session(session);
  return Boolean(await query);
};
const hasFinancialChanges = ({ sourceType, body = {} }) => {
  const safe = new Set(["notes", "termsAndConditions", "centre", "businessLine", "reportCategory"]);
  return Object.keys(body).some((key) => !safe.has(key));
};
const hasLegacyPaymentWrite = ({ sourceType, body = {} }) => Object.keys(body).some((key) => (sourceType === "INVOICE" && ["amountPaid", "paymentStatus"].includes(key)) || (sourceType === "PURCHASE" && ["paidAmount", "paymentStatus"].includes(key)));
const legacyPaymentWriteDecision = ({ sourceType, migrated, allocationsExist, body = {} }) => ({ allowed: !(migrated || allocationsExist) || !hasLegacyPaymentWrite({ sourceType, body }), reason: (migrated || allocationsExist) && hasLegacyPaymentWrite({ sourceType, body }) ? "USE_PAYMENT_WORKFLOW" : "ALLOWED" });
const documentUpdateDecision = ({ sourceType, allocationsExist, body = {} }) => {
  if (!allocationsExist) return { allowed: true, reason: "NO_ALLOCATIONS" };
  if (hasFinancialChanges({ sourceType, body })) return { allowed: false, reason: "ALLOCATED_DOCUMENT_FINANCIAL_VALUES_LOCKED" };
  return { allowed: true, reason: "SAFE_NON_FINANCIAL_EDIT" };
};
const allocationTotal = async ({ businessId, sourceType, sourceDocumentId }) => {
  if (mongoose.connection.readyState !== 1) return 0;
  const field = sourceType === "INVOICE" ? "invoiceId" : "purchaseId";
  const allocations = await PaymentAllocation.find(allocationQuery({ businessId, sourceType, sourceDocumentId })).select("paymentId allocatedAmount");
  if (!allocations.length) return 0;
  const payments = await Payment.find({ businessId, _id: { $in: allocations.map((row) => row.paymentId) }, status: "POSTED" }).select("_id");
  const validIds = new Set(payments.map((payment) => payment._id.toString()));
  const reversals = await PaymentAllocationReversal.find({ businessId, allocationId: { $in: allocations.map((row) => row._id) } }).select("allocationId amount");
  const reversed = new Map(reversals.map((row) => [row.allocationId.toString(), toMinorUnits(row.amount)]));
  return fromMinorUnits(allocations.filter((row) => validIds.has(row.paymentId.toString())).reduce((sum, row) => sum + Math.max(toMinorUnits(row.allocatedAmount) - (reversed.get(row._id.toString()) || 0), 0), 0));
};

const getDocumentFinancialState = async ({ businessId, sourceType, document }) => {
  const provenance = await FinancialMigrationProvenance.findOne({ businessId, sourceType, sourceDocumentId: document._id, migrationType: MIGRATION_TYPE, migrationVersion: MIGRATION_VERSION, state: "MIGRATED" });
  const allocatedAmount = await allocationTotal({ businessId, sourceType, sourceDocumentId: document._id });
  const state = deriveFinancialState({ sourceType, document, migrated: Boolean(provenance) || allocatedAmount > 0, allocatedAmount });
  return state;
};

const applyFinancialRead = async ({ businessId, sourceType, document }) => {
  const raw = document.toObject ? document.toObject() : { ...document };
  const state = await getDocumentFinancialState({ businessId, sourceType, document: raw });
  if (sourceType === "INVOICE") return { ...raw, amountPaid: state.paidAmount, balanceDue: state.outstandingAmount, paymentStatus: state.paymentStatus, financialRead: { source: state.source, reconciliation: state.reconciliation } };
  return { ...raw, paidAmount: state.paidAmount, paymentStatus: state.paymentStatus, financialRead: { source: state.source, outstandingAmount: state.outstandingAmount, reconciliation: state.reconciliation } };
};
const applyFinancialReads = ({ businessId, sourceType, documents }) => Promise.all(documents.map((document) => applyFinancialRead({ businessId, sourceType, document })));
const getDerivedInvoiceRows = async ({ businessId, filter = {} }) => applyFinancialReads({ businessId, sourceType: "INVOICE", documents: await Invoice.find({ businessId, ...filter }) });
const getDerivedPurchaseRows = async ({ businessId, filter = {} }) => applyFinancialReads({ businessId, sourceType: "PURCHASE", documents: await Purchase.find({ businessId, ...filter }) });
const summarizeInvoiceFinancials = (invoices) => {
  const active = invoices.filter((invoice) => invoice.status !== "cancelled");
  return { totalSales: active.reduce((sum, invoice) => sum + Number(invoice.grandTotal || 0), 0), paidAmount: active.reduce((sum, invoice) => sum + Number(invoice.amountPaid || 0), 0), unpaidAmount: active.reduce((sum, invoice) => sum + Number(invoice.balanceDue || 0), 0), totalInvoices: active.length, overdueInvoices: active.filter((invoice) => invoice.balanceDue > 0 && isOverdueByBusinessDate(invoice.dueDate)).length, mismatchCount: active.filter((invoice) => invoice.financialRead?.reconciliation?.status === "MISMATCH").length };
};
const summarizeCustomerFinancials = (invoices, customerId) => summarizeInvoiceFinancials(invoices.filter((invoice) => !customerId || invoice.customerId?.toString() === customerId.toString()));
const summarizeSupplierFinancials = (purchases, supplierId) => {
  const rows = purchases.filter((purchase) => purchase.status !== "cancelled" && (!supplierId || purchase.supplierId?.toString() === supplierId.toString()));
  return { totalPurchases: rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0), paidAmount: rows.reduce((sum, row) => sum + Number(row.paidAmount || 0), 0), outstandingAmount: rows.reduce((sum, row) => sum + Number(row.financialRead?.outstandingAmount ?? Math.max(Number(row.totalAmount || 0) - Number(row.paidAmount || 0), 0)), 0), totalPurchasesCount: rows.length };
};
module.exports = { allocationQuery, allocationTotal, applyFinancialRead, applyFinancialReads, deriveFinancialState, documentUpdateDecision, getDerivedInvoiceRows, getDerivedPurchaseRows, getDocumentFinancialState, hasDocumentAllocations, hasFinancialChanges, hasLegacyPaymentWrite, hasMigratedFinancialState, legacyPaymentWriteDecision, summarizeCustomerFinancials, summarizeInvoiceFinancials, summarizeSupplierFinancials };
