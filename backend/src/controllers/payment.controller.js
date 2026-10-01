const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const paymentService = require("../services/payment.service");
const { writeAuditLog } = require("../services/audit.service");

const createPayment = asyncHandler(async (req, res) => {
  const payment = await paymentService.createPayment({ businessId: req.tenant.businessId, userId: req.user._id, payload: req.body });
  await writeAuditLog({ req, action: "PAYMENT_CREATED", entityType: "PAYMENT", entityId: payment._id, metadata: { direction: payment.direction, amount: payment.amount, status: payment.status } });
  res.status(201).json({ message: "Payment recorded successfully", data: payment });
});
const listPayments = asyncHandler(async (req, res) => {
  const payments = await paymentService.listPayments({ businessId: req.tenant.businessId, query: req.query });
  res.status(200).json({ message: "Payments fetched successfully", data: payments });
});
const getPayment = asyncHandler(async (req, res) => {
  const payment = await paymentService.getPayment({ businessId: req.tenant.businessId, paymentId: req.params.paymentId });
  if (!payment) throw new AppError("Payment not found", 404);
  res.status(200).json({ message: "Payment fetched successfully", data: payment });
});
const allocatePayment = asyncHandler(async (req, res) => {
  const allocation = await paymentService.allocatePayment({ businessId: req.tenant.businessId, userId: req.user._id, paymentId: req.params.paymentId, payload: req.body });
  await writeAuditLog({ req, action: "PAYMENT_ALLOCATED", entityType: "PAYMENT_ALLOCATION", entityId: allocation._id, metadata: { paymentId: req.params.paymentId, invoiceId: req.body.invoiceId, purchaseId: req.body.purchaseId, allocatedAmount: allocation.allocatedAmount } });
  res.status(201).json({ message: "Payment allocated successfully", data: allocation });
});
const reverseAllocation = asyncHandler(async (req, res) => {
  const reversal = await paymentService.reverseAllocation({ businessId: req.tenant.businessId, userId: req.user._id, allocationId: req.params.allocationId, amount: req.body.amount, reason: req.body.reason });
  await writeAuditLog({ req, action: "PAYMENT_ALLOCATION_REVERSED", entityType: "PAYMENT_ALLOCATION_REVERSAL", entityId: reversal._id, metadata: { allocationId: req.params.allocationId, amount: reversal.amount } });
  res.status(201).json({ message: "Payment allocation reversed successfully", data: reversal });
});
const listInvoiceAllocations = asyncHandler(async (req, res) => res.json({ message: "Invoice allocations fetched successfully", data: await paymentService.listAllocations({ businessId: req.tenant.businessId, sourceType: "INVOICE", sourceDocumentId: req.params.invoiceId }) }));
const listPurchaseAllocations = asyncHandler(async (req, res) => res.json({ message: "Purchase allocations fetched successfully", data: await paymentService.listAllocations({ businessId: req.tenant.businessId, sourceType: "PURCHASE", sourceDocumentId: req.params.purchaseId }) }));
const reversePayment = asyncHandler(async (req, res) => {
  const reversal = await paymentService.reversePayment({ businessId: req.tenant.businessId, userId: req.user._id, paymentId: req.params.paymentId, reason: req.body.reason });
  await writeAuditLog({ req, action: "PAYMENT_REVERSED", entityType: "PAYMENT", entityId: reversal._id, metadata: { originalPaymentId: req.params.paymentId, amount: reversal.amount } });
  res.status(201).json({ message: "Payment reversed successfully", data: reversal });
});
const getCustomerAdvances = asyncHandler(async (req, res) => {
  const advances = await paymentService.getCustomerAdvances({ businessId: req.tenant.businessId, customerId: req.params.customerId });
  res.status(200).json({ message: "Customer advances fetched successfully", data: advances });
});
module.exports = { allocatePayment, createPayment, getCustomerAdvances, getPayment, listInvoiceAllocations, listPayments, listPurchaseAllocations, reverseAllocation, reversePayment };
