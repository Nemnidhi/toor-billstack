const mongoose = require("mongoose");
const validId = (value) => mongoose.Types.ObjectId.isValid(value);
// RAZORPAY: money a customer paid through Razorpay outside a BillStack link. It goes to "Razorpay -
// Settlements Due" (1030), not the bank, because it reaches the bank inside a Razorpay settlement.
const paymentMethods = ["CASH", "BANK_TRANSFER", "CHEQUE", "UPI", "CARD", "RAZORPAY", "OTHER"];
const paymentCreateValidator = (body) => {
  const errors = {};
  const direction = String(body.direction || "").toUpperCase();
  if (!["RECEIVED", "PAID"].includes(direction)) errors.direction = "Direction must be RECEIVED or PAID";
  if (!body.amount || !Number.isFinite(Number(body.amount)) || Number(body.amount) <= 0) errors.amount = "Amount must be positive";
  if (body.customerId && !validId(body.customerId)) errors.customerId = "Customer ID is invalid";
  if (body.supplierId && !validId(body.supplierId)) errors.supplierId = "Supplier ID is invalid";
  if (body.customerId && body.supplierId) errors.counterparty = "Use either customer or supplier";
  if (direction === "RECEIVED" && !body.customerId) errors.customerId = "A received payment requires a customer";
  if (direction === "PAID" && !body.supplierId) errors.supplierId = "A paid payment requires a supplier";
  if (body.paymentMethod && !paymentMethods.includes(String(body.paymentMethod).toUpperCase())) errors.paymentMethod = "Payment method is invalid";
  else if (String(body.paymentMethod || "").toUpperCase() === "RAZORPAY" && direction !== "RECEIVED") errors.paymentMethod = "Razorpay is only for money received from a customer";
  if (body.currency && !/^[A-Za-z]{3}$/.test(body.currency)) errors.currency = "Currency must be a three-letter ISO code";
  if (body.paymentDate && Number.isNaN(Date.parse(body.paymentDate))) errors.paymentDate = "Payment date is invalid";
  if (body.status && String(body.status).toUpperCase() !== "POSTED") errors.status = "New payments can only be POSTED";
  if (body.idempotencyKey && String(body.idempotencyKey).length > 120) errors.idempotencyKey = "Idempotency key is too long";
  if (body.tdsAmount !== undefined && body.tdsAmount !== "" && body.tdsAmount !== null) {
    const tds = Number(body.tdsAmount);
    if (!Number.isFinite(tds) || tds < 0) errors.tdsAmount = "TDS must be zero or more";
    else if (tds > 0 && direction !== "RECEIVED") errors.tdsAmount = "TDS on a receipt is only for money received from a customer";
  }
  return { valid: Object.keys(errors).length === 0, errors };
};
const paymentAllocationValidator = (body) => {
  const errors = {};
  if (!body.allocatedAmount || !Number.isFinite(Number(body.allocatedAmount)) || Number(body.allocatedAmount) <= 0) errors.allocatedAmount = "Allocated amount must be positive";
  if (Boolean(body.invoiceId) === Boolean(body.purchaseId)) errors.document = "Provide exactly one invoiceId or purchaseId";
  if (body.invoiceId && !validId(body.invoiceId)) errors.invoiceId = "Invoice ID is invalid";
  if (body.purchaseId && !validId(body.purchaseId)) errors.purchaseId = "Purchase ID is invalid";
  return { valid: Object.keys(errors).length === 0, errors };
};
module.exports = { paymentAllocationValidator, paymentCreateValidator };
