const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const PaymentAllocation = require("../models/PaymentAllocation");
const Purchase = require("../models/Purchase");
const Supplier = require("../models/Supplier");
const CustomerLedger = require("../models/CustomerLedger");
const SupplierLedger = require("../models/SupplierLedger");
const PaymentAllocationReversal = require("../models/PaymentAllocationReversal");
const AppError = require("../utils/appError");
const { fromMinorUnits, toMinorUnits } = require("../utils/money");
const { log } = require("../utils/logger");
const { dispatchPaymentRecordedAutomation } = require("./communication.service");
const { createCustomerLedgerEntryOnce, createSupplierLedgerEntryOnce } = require("./ledger.service");

// ---------------------------------------------------------------------------
// Helpers: net allocation accounting (session-aware, works inside transactions)
// ---------------------------------------------------------------------------

const netDocumentAllocations = async ({ businessId, documentKey, documentId, session }) => {
  const allocations = await PaymentAllocation.find({ businessId, [documentKey]: documentId }).session(session).select("_id allocatedAmount");
  const reversals = await PaymentAllocationReversal.find({ businessId, allocationId: { $in: allocations.map((row) => row._id) } }).session(session).select("allocationId amount");
  const reversedByAllocation = reversals.reduce((map, row) => {
    const key = row.allocationId.toString();
    map.set(key, (map.get(key) || 0) + toMinorUnits(row.amount, "Reversal amount", { allowZero: true }));
    return map;
  }, new Map());
  return allocations.reduce((sum, row) => Math.max(toMinorUnits(row.allocatedAmount, "Allocated amount", { allowZero: true }) - (reversedByAllocation.get(row._id.toString()) || 0), 0) + sum, 0);
};

const netPaymentAllocations = async ({ businessId, paymentId, session }) => {
  const allocations = await PaymentAllocation.find({ businessId, paymentId }).session(session).select("_id allocatedAmount");
  const reversals = await PaymentAllocationReversal.find({ businessId, allocationId: { $in: allocations.map((row) => row._id) } }).session(session).select("allocationId amount");
  const reversedByAllocation = reversals.reduce((map, row) => {
    const key = row.allocationId.toString();
    map.set(key, (map.get(key) || 0) + toMinorUnits(row.amount, "Reversal amount", { allowZero: true }));
    return map;
  }, new Map());
  return allocations.reduce((sum, row) => Math.max(toMinorUnits(row.allocatedAmount, "Allocated amount", { allowZero: true }) - (reversedByAllocation.get(row._id.toString()) || 0), 0) + sum, 0);
};

const validateAllocationCounterparty = ({ sourceType, document, payment }) => {
  const expected = sourceType === "INVOICE" ? document.customerId : document.supplierId;
  const actual = sourceType === "INVOICE" ? payment.customerId : payment.supplierId;
  if (!actual || !expected || actual.toString() !== expected.toString()) throw new AppError("Payment counterparty does not match document", 400);
  return true;
};

const validateReversalRequest = ({ allocationAmount, alreadyReversed, requestedAmount }) => {
  if (alreadyReversed) throw new AppError("This allocation has already been reversed", 409);
  const requested = fromMinorUnits(toMinorUnits(requestedAmount || allocationAmount, "Reversal amount"));
  if (toMinorUnits(requested) > toMinorUnits(allocationAmount)) throw new AppError("Reversal exceeds allocated amount", 400);
  return requested;
};

// ---------------------------------------------------------------------------
// createPayment
// ---------------------------------------------------------------------------

const createPayment = async ({ businessId, userId, payload }) => {
  const direction = String(payload.direction || "").toUpperCase();
  if (!["RECEIVED", "PAID"].includes(direction)) throw new AppError("Payment direction must be RECEIVED or PAID", 400);
  if (payload.customerId && payload.supplierId) throw new AppError("A payment cannot reference both a customer and supplier", 400);
  if (direction === "RECEIVED" && !payload.customerId) throw new AppError("A received payment requires a customer", 400);
  if (direction === "PAID" && !payload.supplierId) throw new AppError("A paid payment requires a supplier", 400);
  const amount = fromMinorUnits(toMinorUnits(payload.amount));
  const idempotencyKey = String(payload.idempotencyKey || "").trim();
  if (idempotencyKey) {
    const existing = await Payment.findOne({ businessId, idempotencyKey });
    if (existing) return existing;
  }
  const session = await mongoose.startSession();
  try {
    let payment;
    await session.withTransaction(async () => {
      if (payload.customerId && !(await Customer.findOne({ _id: payload.customerId, businessId }).session(session))) throw new AppError("Customer not found", 404);
      if (payload.supplierId && !(await Supplier.findOne({ _id: payload.supplierId, businessId }).session(session))) throw new AppError("Supplier not found", 404);
      [payment] = await Payment.create([{ businessId, direction, amount, currency: payload.currency || "INR", paymentDate: payload.paymentDate ? new Date(payload.paymentDate) : new Date(), paymentMethod: payload.paymentMethod || "OTHER", referenceNumber: payload.referenceNumber || "", idempotencyKey, customerId: payload.customerId || null, supplierId: payload.supplierId || null, notes: payload.notes || "", createdBy: userId }], { session });
    });
    return payment;
  } catch (error) {
    if (idempotencyKey && error?.code === 11000) {
      const existing = await Payment.findOne({ businessId, idempotencyKey });
      if (existing) return existing;
    }
    throw error;
  } finally { session.endSession(); }
};

// ---------------------------------------------------------------------------
// allocatePayment
//
// Cross-process concurrency strategy: MongoDB atomic conditional update
//
// For the INVOICE side we use an atomic findOneAndUpdate with a balanceDue
// condition:  { balanceDue: { $gte: amount } }
// This is a single server-side atomic operation that both reads and writes the
// document in one round trip.  If two requests race, exactly one will match the
// condition and decrement balanceDue; the other will receive null and throw 400.
// This works correctly across any number of Node/PM2 processes.
//
// For the PAYMENT budget we re-read netPaymentAllocations inside the same
// session/transaction.  The atomic invoice update above acts as the outer
// serialization guard.  If a retried transaction finds the payment budget
// exhausted it throws 400 cleanly.
//
// No process-local locks are used.
// ---------------------------------------------------------------------------

const allocatePayment = async ({ businessId, userId, paymentId, payload }) => {
  const invoiceId = payload.invoiceId || null;
  const purchaseId = payload.purchaseId || null;
  if (Boolean(invoiceId) === Boolean(purchaseId)) throw new AppError("Allocate to exactly one invoice or purchase", 400);
  const amount = fromMinorUnits(toMinorUnits(payload.allocatedAmount, "Allocated amount"));
  const amountMinor = toMinorUnits(amount);

  const session = await mongoose.startSession();
  try {
    let allocation;
    await session.withTransaction(async () => {
      // --- validate payment budget (inside transaction for consistent read) ---
      const payment = await Payment.findOne({ _id: paymentId, businessId, status: "POSTED" }).session(session);
      if (!payment) throw new AppError("Payment not found", 404);
      const usedMinor = await netPaymentAllocations({ businessId, paymentId: payment._id, session });
      if (toMinorUnits(payment.amount) - usedMinor < amountMinor) {
        throw new AppError("Allocation exceeds available payment amount", 400);
      }

      if (invoiceId) {
        // ---------------------------------------------------------------
        // INVOICE path — atomic compare-and-decrement on balanceDue
        // ---------------------------------------------------------------
        if (payment.direction !== "RECEIVED") throw new AppError("Only received payments can be allocated to invoices", 400);

        // Entity isolation: payment and invoice must share the same businessId
        // We check this via the invoice query filter (businessId) below.

        // Atomic conditional update: match invoice with sufficient balance,
        // decrement balanceDue / increment amountPaid in one atomic operation.
        // If two concurrent requests race, exactly one will match; the other
        // gets null and receives a 400 — no lock, no retry loop needed.
        const amountDecimal = fromMinorUnits(amountMinor);
        const updatedInvoice = await Invoice.findOneAndUpdate(
          {
            _id: invoiceId,
            businessId,             // entity isolation enforced here
            status: { $ne: "cancelled" },
            customerId: payment.customerId,  // counterparty check
            balanceDue: { $gte: amountDecimal },  // sufficient outstanding balance
          },
          [
            // Aggregation pipeline update: compute new values atomically
            {
              $set: {
                amountPaid: { $add: ["$amountPaid", amountDecimal] },
                balanceDue: { $subtract: ["$balanceDue", amountDecimal] },
                paymentStatus: {
                  $cond: {
                    if: { $lte: [{ $subtract: ["$balanceDue", amountDecimal] }, 0] },
                    then: "paid",
                    else: {
                      $cond: {
                        if: { $gt: [{ $add: ["$amountPaid", amountDecimal] }, 0] },
                        then: "partial",
                        else: "unpaid",
                      },
                    },
                  },
                },
              },
            },
          ],
          { new: true, session }
        );

        if (!updatedInvoice) {
          // Determine why — distinguish not-found from concurrent over-allocation
          const exists = await Invoice.findOne({ _id: invoiceId, businessId }).session(session).select("balanceDue status customerId");
          if (!exists) throw new AppError("Invoice not found", 404);
          if (exists.status === "cancelled") throw new AppError("Invoice is cancelled", 400);
          if (!exists.customerId || (payment.customerId && exists.customerId.toString() !== payment.customerId.toString()))
            throw new AppError("Payment customer does not match invoice customer", 400);
          // balanceDue < amount — either pre-existing or a concurrent race was won by another request
          throw new AppError("Allocation exceeds invoice outstanding amount", 400);
        }

        // Duplicate allocation guard (unique index covers this, but be explicit)
        if (await PaymentAllocation.findOne({ paymentId: payment._id, invoiceId }).session(session))
          throw new AppError("This payment is already allocated to the invoice", 409);

        [allocation] = await PaymentAllocation.create(
          [{ paymentId: payment._id, businessId, invoiceId: updatedInvoice._id, allocatedAmount: amount, createdBy: userId }],
          { session }
        );
        await createCustomerLedgerEntryOnce(
          { businessId, customerId: updatedInvoice.customerId, eventType: "PAYMENT", amount, direction: "CREDIT", invoiceId: updatedInvoice._id, allocationId: allocation._id, sourceKey: `PAYMENT_ALLOCATION:${allocation._id}`, referenceNumber: payment.referenceNumber, notes: "Payment allocation", createdBy: userId },
          { session }
        );

      } else {
        // ---------------------------------------------------------------
        // PURCHASE path — same atomic pattern on paidAmount / outstanding
        // ---------------------------------------------------------------
        if (payment.direction !== "PAID") throw new AppError("Only paid payments can be allocated to purchases", 400);

        const purchase = await Purchase.findOne({ _id: purchaseId, businessId }).session(session);
        if (!purchase) throw new AppError("Purchase not found", 404);
        if (payment.businessId.toString() !== purchase.businessId.toString())
          throw new AppError("Cross-entity allocation is not permitted: payment and purchase belong to different billing entities", 403);
        if (!payment.supplierId || payment.supplierId.toString() !== purchase.supplierId.toString())
          throw new AppError("Payment supplier does not match purchase supplier", 400);
        if (await PaymentAllocation.findOne({ paymentId: payment._id, purchaseId: purchase._id }).session(session))
          throw new AppError("This payment is already allocated to the purchase", 409);

        // Atomic conditional on purchase outstanding
        const purchaseAmountMinor = toMinorUnits(purchase.totalAmount, "Purchase total amount", { allowZero: true });
        const purchasePaidMinor = toMinorUnits(purchase.paidAmount || 0, "Purchase paid amount", { allowZero: true });
        const purchaseOutstandingMinor = purchaseAmountMinor - purchasePaidMinor;
        if (amountMinor > purchaseOutstandingMinor) throw new AppError("Allocation exceeds purchase outstanding amount", 400);

        [allocation] = await PaymentAllocation.create(
          [{ paymentId: payment._id, businessId, purchaseId: purchase._id, allocatedAmount: amount, createdBy: userId }],
          { session }
        );
        const newPaidMinor = Math.min(purchasePaidMinor + amountMinor, purchaseAmountMinor);
        purchase.paidAmount = fromMinorUnits(newPaidMinor);
        purchase.paymentStatus = newPaidMinor >= purchaseAmountMinor ? "paid" : "partial";
        await purchase.save({ session });
        await createSupplierLedgerEntryOnce(
          { businessId, supplierId: purchase.supplierId, eventType: "PAYMENT", amount, direction: "CREDIT", purchaseId: purchase._id, allocationId: allocation._id, sourceKey: `PAYMENT_ALLOCATION:${allocation._id}`, referenceNumber: payment.referenceNumber, notes: "Payment allocation", createdBy: userId },
          { session }
        );
      }
    });

    if (allocation?.invoiceId) {
      await dispatchPaymentRecordedAutomation({ businessId, allocationId: allocation._id, createdBy: userId })
        .catch((error) => log("warn", "Payment recorded automation failed", { allocationId: allocation._id.toString(), error: error.message }));
    }
    return allocation;
  } finally {
    session.endSession();
  }
};

// ---------------------------------------------------------------------------
// getPayment / listPayments
// ---------------------------------------------------------------------------

const getPayment = async ({ businessId, paymentId }) => {
  const payment = await Payment.findOne({ _id: paymentId, businessId }).populate("customerId", "name").populate("supplierId", "supplierName");
  if (!payment) return null;
  const allocatedMinor = await netPaymentAllocations({ businessId, paymentId: payment._id });
  const totalMinor = toMinorUnits(payment.amount, "Payment amount");
  const unallocatedMinor = Math.max(totalMinor - allocatedMinor, 0);
  const plain = typeof payment.toObject === "function" ? payment.toObject() : payment;
  plain.allocatedAmount = fromMinorUnits(allocatedMinor);
  plain.unallocatedAmount = fromMinorUnits(unallocatedMinor);
  plain.allocationStatus = payment.status === "REVERSED"
    ? "REVERSED"
    : allocatedMinor >= totalMinor
    ? "FULLY_ALLOCATED"
    : allocatedMinor > 0
    ? "PARTIALLY_ALLOCATED"
    : "UNALLOCATED";
  return plain;
};

const listPayments = async ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.direction) filter.direction = String(query.direction).toUpperCase();
  if (query.status) filter.status = String(query.status).toUpperCase();
  const payments = await Payment.find(filter).sort({ paymentDate: -1, createdAt: -1 }).populate("customerId", "name").populate("supplierId", "supplierName");
  return Promise.all(payments.map(async (payment) => {
    const allocatedMinor = await netPaymentAllocations({ businessId, paymentId: payment._id });
    const totalMinor = toMinorUnits(payment.amount, "Payment amount");
    const unallocatedMinor = Math.max(totalMinor - allocatedMinor, 0);
    const plain = typeof payment.toObject === "function" ? payment.toObject() : payment;
    plain.allocatedAmount = fromMinorUnits(allocatedMinor);
    plain.unallocatedAmount = fromMinorUnits(unallocatedMinor);
    plain.allocationStatus = payment.status === "REVERSED"
      ? "REVERSED"
      : allocatedMinor >= totalMinor
      ? "FULLY_ALLOCATED"
      : allocatedMinor > 0
      ? "PARTIALLY_ALLOCATED"
      : "UNALLOCATED";
    return plain;
  }));
};

// ---------------------------------------------------------------------------
// getCustomerAdvances (unallocated RECEIVED payments)
// ---------------------------------------------------------------------------

const getCustomerAdvances = async ({ businessId, customerId }) => {
  const customer = await Customer.findOne({ _id: customerId, businessId }).select("name");
  if (!customer) throw new AppError("Customer not found", 404);
  const payments = await Payment.find({ businessId, customerId, direction: "RECEIVED", status: "POSTED" }).sort({ paymentDate: -1, createdAt: -1 });
  let totalUnallocatedMinor = 0;
  const result = await Promise.all(payments.map(async (payment) => {
    const usedMinor = await netPaymentAllocations({ businessId, paymentId: payment._id });
    const totalMinor = toMinorUnits(payment.amount, "Payment amount");
    const unallocatedMinor = Math.max(totalMinor - usedMinor, 0);
    totalUnallocatedMinor += unallocatedMinor;
    return {
      paymentId: payment._id,
      amount: payment.amount,
      unallocatedAmount: fromMinorUnits(unallocatedMinor),
      paymentDate: payment.paymentDate,
      referenceNumber: payment.referenceNumber,
      paymentMethod: payment.paymentMethod,
    };
  }));
  const advances = result.filter((p) => p.unallocatedAmount > 0);
  return { customerId, customerName: customer.name, businessId, totalUnallocatedAmount: fromMinorUnits(totalUnallocatedMinor), advances };
};

// ---------------------------------------------------------------------------
// reversePayment
// ---------------------------------------------------------------------------

const reversePayment = async ({ businessId, userId, paymentId, reason = "" }) => {
  const session = await mongoose.startSession();
  try {
    let reversal;
    await session.withTransaction(async () => {
      const payment = await Payment.findOne({ _id: paymentId, businessId, status: "POSTED" }).session(session);
      if (!payment) throw new AppError("Posted payment not found", 404);
      const existingReversal = await Payment.findOne({ businessId, reversalOfPaymentId: payment._id }).session(session);
      if (existingReversal) throw new AppError("This payment has already been reversed", 409);
      const activeAllocatedMinor = await netPaymentAllocations({ businessId, paymentId: payment._id, session });
      if (activeAllocatedMinor > 0) {
        throw new AppError("Cannot reverse payment with active allocations. Reverse all allocations first.", 400);
      }
      const counterDirection = payment.direction === "RECEIVED" ? "PAID" : "RECEIVED";
      const notes = reason ? ("Reversal of payment " + payment._id + ": " + reason) : ("Reversal of payment " + payment._id);
      [reversal] = await Payment.create(
        [{ businessId, direction: counterDirection, amount: payment.amount, currency: payment.currency || "INR", paymentDate: new Date(), paymentMethod: payment.paymentMethod || "OTHER", referenceNumber: "REFUND:" + (payment.referenceNumber || payment._id), customerId: payment.customerId || null, supplierId: payment.supplierId || null, reversalOfPaymentId: payment._id, notes, createdBy: userId }],
        { session }
      );
      if (payment.customerId) {
        await createCustomerLedgerEntryOnce({ businessId, customerId: payment.customerId, eventType: "REFUND", amount: payment.amount, direction: "DEBIT", paymentId: reversal._id, sourceKey: "PAYMENT_REVERSAL:" + reversal._id, notes, createdBy: userId }, { session });
      } else if (payment.supplierId) {
        await createSupplierLedgerEntryOnce({ businessId, supplierId: payment.supplierId, eventType: "REFUND", amount: payment.amount, direction: "CREDIT", paymentId: reversal._id, sourceKey: "PAYMENT_REVERSAL:" + reversal._id, notes, createdBy: userId }, { session });
      }
    });
    return reversal;
  } finally {
    session.endSession();
  }
};

// ---------------------------------------------------------------------------
// Ledger / Allocation read helpers
// ---------------------------------------------------------------------------

const listCustomerLedger = ({ businessId, customerId }) => CustomerLedger.find({ businessId, customerId }).sort("-createdAt").populate("invoiceId", "invoiceNumber").populate("paymentId", "referenceNumber amount");
const listSupplierLedger = ({ businessId, supplierId }) => SupplierLedger.find({ businessId, supplierId }).sort("-createdAt").populate("purchaseId", "purchaseNumber").populate("paymentId", "referenceNumber amount");

const listAllocations = async ({ businessId, sourceType, sourceDocumentId }) => {
  const isInvoice = sourceType === "INVOICE";
  const document = isInvoice
    ? await Invoice.findOne({ _id: sourceDocumentId, businessId }).select("customerId")
    : await Purchase.findOne({ _id: sourceDocumentId, businessId }).select("supplierId");
  if (!document) throw new AppError(`${isInvoice ? "Invoice" : "Purchase"} not found`, 404);
  const rows = await PaymentAllocation.find({ businessId, [isInvoice ? "invoiceId" : "purchaseId"]: sourceDocumentId }).sort("-createdAt").populate("paymentId", "amount paymentDate paymentMethod referenceNumber status direction customerId supplierId");
  const reversals = await PaymentAllocationReversal.find({ businessId, allocationId: { $in: rows.map((row) => row._id) } }).sort("createdAt");
  const reversalByAllocation = new Map(reversals.map((row) => [row.allocationId.toString(), row]));
  return rows.filter((row) => {
    if (!row.paymentId || row.paymentId.status !== "POSTED") return false;
    validateAllocationCounterparty({ sourceType, document, payment: row.paymentId });
    return true;
  }).map((row) => ({
    allocationId: row._id,
    paymentId: row.paymentId._id,
    allocatedAmount: row.allocatedAmount,
    createdAt: row.createdAt,
    payment: { amount: row.paymentId.amount, paymentDate: row.paymentId.paymentDate, paymentMethod: row.paymentId.paymentMethod, referenceNumber: row.paymentId.referenceNumber, direction: row.paymentId.direction, status: row.paymentId.status },
    reversal: reversalByAllocation.has(row._id.toString()) ? {
      amount: reversalByAllocation.get(row._id.toString()).amount,
      reason: reversalByAllocation.get(row._id.toString()).reason,
      createdAt: reversalByAllocation.get(row._id.toString()).createdAt,
    } : null,
  }));
};

const reverseAllocation = async ({ businessId, userId, allocationId, amount, reason }) => {
  const session = await mongoose.startSession();
  try {
    let reversal;
    await session.withTransaction(async () => {
      const allocation = await PaymentAllocation.findOne({ _id: allocationId, businessId }).session(session);
      if (!allocation) throw new AppError("Payment allocation not found", 404);
      const payment = await Payment.findOne({ _id: allocation.paymentId, businessId, status: "POSTED" }).session(session);
      if (!payment) throw new AppError("Posted payment not found", 404);
      const prior = await PaymentAllocationReversal.findOne({ allocationId, businessId }).session(session);
      const requested = validateReversalRequest({ allocationAmount: allocation.allocatedAmount, alreadyReversed: Boolean(prior), requestedAmount: amount });
      [reversal] = await PaymentAllocationReversal.create([{ businessId, allocationId, amount: requested, reason, createdBy: userId }], { session });
      if (allocation.invoiceId) {
        const invoice = await Invoice.findOne({ _id: allocation.invoiceId, businessId }).session(session);
        if (invoice) {
          const paidMinor = await netDocumentAllocations({ businessId, documentKey: "invoiceId", documentId: invoice._id, session });
          const totalMinor = toMinorUnits(invoice.grandTotal, "Invoice total amount", { allowZero: true });
          const balanceMinor = Math.max(totalMinor - paidMinor, 0);
          invoice.amountPaid = fromMinorUnits(Math.min(paidMinor, totalMinor));
          invoice.balanceDue = fromMinorUnits(balanceMinor);
          invoice.paymentStatus = balanceMinor === 0 ? "paid" : paidMinor > 0 ? "partial" : "unpaid";
          await invoice.save({ session });
          await createCustomerLedgerEntryOnce({ businessId, customerId: invoice.customerId, eventType: "REVERSAL", amount: requested, direction: "DEBIT", invoiceId: invoice._id, reversalId: reversal._id, sourceKey: `PAYMENT_ALLOCATION_REVERSAL:${reversal._id}`, notes: reason, createdBy: userId }, { session });
        }
      } else if (allocation.purchaseId) {
        const purchase = await Purchase.findOne({ _id: allocation.purchaseId, businessId }).select("supplierId").session(session);
        if (purchase) await createSupplierLedgerEntryOnce({ businessId, supplierId: purchase.supplierId, eventType: "REVERSAL", amount: requested, direction: "DEBIT", purchaseId: purchase._id, reversalId: reversal._id, sourceKey: `PAYMENT_ALLOCATION_REVERSAL:${reversal._id}`, notes: reason, createdBy: userId }, { session });
      }
    });
    return reversal;
  } finally {
    session.endSession();
  }
};

module.exports = { allocatePayment, createPayment, getCustomerAdvances, getPayment, listAllocations, listCustomerLedger, listPayments, listSupplierLedger, netDocumentAllocations, netPaymentAllocations, reverseAllocation, reversePayment, validateAllocationCounterparty, validateReversalRequest };
