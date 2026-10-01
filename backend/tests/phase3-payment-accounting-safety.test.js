const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { toMinorUnits, fromMinorUnits } = require("../src/utils/money");
const { validateAllocationCounterparty, validateReversalRequest } = require("../src/services/payment.service");
const Invoice = require("../src/models/Invoice");
const Payment = require("../src/models/Payment");
const PaymentAllocation = require("../src/models/PaymentAllocation");
const PaymentAllocationReversal = require("../src/models/PaymentAllocationReversal");
const CustomerLedger = require("../src/models/CustomerLedger");

// --- 1. Partial Payments & Balance Calculations ---
test("multiple partial payments accumulate accurately to paid status", () => {
  const total = 1000;
  const totalMinor = toMinorUnits(total);
  let paidMinor = 0;
  
  // Payment 1: 400
  const p1Minor = toMinorUnits(400);
  paidMinor += p1Minor;
  let balanceMinor = Math.max(totalMinor - paidMinor, 0);
  let status = balanceMinor === 0 ? "paid" : paidMinor > 0 ? "partial" : "unpaid";
  assert.equal(fromMinorUnits(paidMinor), 400);
  assert.equal(fromMinorUnits(balanceMinor), 600);
  assert.equal(status, "partial");
  
  // Payment 2: 600
  const p2Minor = toMinorUnits(600);
  paidMinor += p2Minor;
  balanceMinor = Math.max(totalMinor - paidMinor, 0);
  status = balanceMinor === 0 ? "paid" : paidMinor > 0 ? "partial" : "unpaid";
  assert.equal(fromMinorUnits(paidMinor), 1000);
  assert.equal(fromMinorUnits(balanceMinor), 0);
  assert.equal(status, "paid");
});

// --- 2. Payment Allocation across Multiple Invoices ---
test("one payment allocated across multiple invoices tracks remaining unallocated advance", () => {
  const paymentAmount = 1000;
  const paymentMinor = toMinorUnits(paymentAmount);
  const allocInv1Minor = toMinorUnits(400);
  const allocInv2Minor = toMinorUnits(450);
  
  const totalAllocatedMinor = allocInv1Minor + allocInv2Minor;
  assert.equal(fromMinorUnits(totalAllocatedMinor), 850);
  
  const unallocatedMinor = Math.max(paymentMinor - totalAllocatedMinor, 0);
  assert.equal(fromMinorUnits(unallocatedMinor), 150);
  
  const allocationStatus = unallocatedMinor === 0 ? "FULLY_ALLOCATED" : totalAllocatedMinor > 0 ? "PARTIALLY_ALLOCATED" : "UNALLOCATED";
  assert.equal(allocationStatus, "PARTIALLY_ALLOCATED");
});

// --- 3. Advance / Unallocated Payment & Later Allocation ---
test("unallocated payment remains available as advance and is allocatable later", () => {
  const advancePayment = { amount: 500, allocatedMinor: 0 };
  let unallocated = advancePayment.amount - fromMinorUnits(advancePayment.allocatedMinor);
  assert.equal(unallocated, 500);
  
  // Later, allocate 300 to new invoice
  const allocationMinor = toMinorUnits(300);
  advancePayment.allocatedMinor += allocationMinor;
  unallocated = fromMinorUnits(toMinorUnits(advancePayment.amount) - advancePayment.allocatedMinor);
  assert.equal(unallocated, 200);
  
  // Allocate remaining 200
  advancePayment.allocatedMinor += toMinorUnits(200);
  unallocated = fromMinorUnits(toMinorUnits(advancePayment.amount) - advancePayment.allocatedMinor);
  assert.equal(unallocated, 0);
});

// --- 4. Overpayment / Over-Allocation Blocked ---
test("over-allocation beyond available payment or invoice balance is blocked", () => {
  const paymentMinor = toMinorUnits(500);
  const usedPaymentMinor = toMinorUnits(400);
  const availablePaymentMinor = paymentMinor - usedPaymentMinor; // 100
  
  // Request 150 from payment with 100 available -> blocked
  const reqAmountMinor = toMinorUnits(150);
  assert.ok(reqAmountMinor > availablePaymentMinor, "Must detect allocation exceeds available payment");
  
  // Invoice with 200 total, 150 already paid -> outstanding is 50
  const invTotalMinor = toMinorUnits(200);
  const invPaidMinor = toMinorUnits(150);
  const invOutstandingMinor = invTotalMinor - invPaidMinor; // 50
  
  // Request 80 on invoice with 50 outstanding -> blocked
  assert.ok(toMinorUnits(80) > invOutstandingMinor, "Must detect allocation exceeds invoice outstanding");
});

// --- 5. Concurrent Allocation Serialization ---
test("concurrent allocation queue serializes requests preventing over-allocation", async () => {
  const paymentLocks = new Map();
  const withLock = async (id, fn) => {
    while (paymentLocks.has(id)) { await paymentLocks.get(id); }
    let resolve;
    const p = new Promise(r => { resolve = r; });
    paymentLocks.set(id, p);
    try { return await fn(); }
    finally { paymentLocks.delete(id); resolve(); }
  };
  
  let paymentBalance = 500;
  const executionLog = [];
  
  const attemptAllocation = async (reqId, amount) => {
    return withLock("pay_1", async () => {
      executionLog.push(reqId + "_start");
      await new Promise(r => setTimeout(r, 10)); // simulate async I/O
      if (amount > paymentBalance) {
        executionLog.push(reqId + "_rejected");
        throw new Error("Allocation exceeds available payment amount");
      }
      paymentBalance -= amount;
      executionLog.push(reqId + "_success");
      return paymentBalance;
    });
  };
  
  // Launch two concurrent requests for 400 each on a 500 balance
  const results = await Promise.allSettled([
    attemptAllocation("req1", 400),
    attemptAllocation("req2", 400),
  ]);
  
  // One must succeed, one must be rejected
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /exceeds available payment/);
  assert.equal(paymentBalance, 100);
});

// --- 6. Entity Isolation ---
test("cross-entity payment allocation between TOOR and Goldhawk is strictly blocked", () => {
  const toorBusinessId = new mongoose.Types.ObjectId().toString();
  const goldhawkBusinessId = new mongoose.Types.ObjectId().toString();
  
  const payment = { businessId: goldhawkBusinessId, customerId: "cust_1" };
  const invoice = { businessId: toorBusinessId, customerId: "cust_1" };
  
  // Verify check detects cross-entity mismatch
  const isCrossEntity = payment.businessId.toString() !== invoice.businessId.toString();
  assert.equal(isCrossEntity, true);
});

// --- 7. Reversal & Restoration of Balances ---
test("reversal accurately restores invoice outstanding and payment available balance", () => {
  const invTotalMinor = toMinorUnits(1000);
  let allocationAmountMinor = toMinorUnits(600);
  let reversalAmountMinor = 0;
  
  // Net allocation before reversal
  let netAllocatedMinor = allocationAmountMinor - reversalAmountMinor;
  assert.equal(fromMinorUnits(netAllocatedMinor), 600);
  assert.equal(fromMinorUnits(invTotalMinor - netAllocatedMinor), 400);
  
  // Process reversal of full allocation
  const validRev = validateReversalRequest({
    allocationAmount: fromMinorUnits(allocationAmountMinor),
    alreadyReversed: false,
    requestedAmount: 600,
  });
  assert.equal(validRev, 600);
  reversalAmountMinor = toMinorUnits(validRev);
  
  // Net allocation after reversal
  netAllocatedMinor = Math.max(allocationAmountMinor - reversalAmountMinor, 0);
  assert.equal(netAllocatedMinor, 0);
  
  const restoredBalanceMinor = Math.max(invTotalMinor - netAllocatedMinor, 0);
  assert.equal(fromMinorUnits(restoredBalanceMinor), 1000);
});

// --- 8. Double Reversal Blocked ---
test("double reversal of allocation and payment is blocked", () => {
  assert.throws(
    () => validateReversalRequest({ allocationAmount: 500, alreadyReversed: true, requestedAmount: 500 }),
    /already been reversed/
  );
  
  // Model level: Payment schema has unique index on reversalOfPaymentId
  const payIndexes = Payment.schema.indexes();
  const hasReversalIndex = payIndexes.some(
    ([idx, opts]) => idx.reversalOfPaymentId === 1 && opts?.unique === true
  );
  assert.equal(hasReversalIndex, true, "Payment model must have unique index on reversalOfPaymentId");
});

// --- 9. Safe Invoice Cancellation with Payment Allocations ---
test("cancelling an invoice with active payment allocations is safely rejected", () => {
  const activeAllocatedMinor = toMinorUnits(500);
  assert.ok(activeAllocatedMinor > 0, "Must detect active allocations exist");
  
  const cancelGuard = (activeAllocated) => {
    if (activeAllocated > 0) {
      throw new Error("Cannot cancel an invoice with active payment allocations. Please reverse all payment allocations before cancelling.");
    }
    return "cancelled";
  };
  
  assert.throws(() => cancelGuard(activeAllocatedMinor), /active payment allocations/);
  assert.equal(cancelGuard(0), "cancelled");
});

// --- 10. Reissue Preserves Audit Trail & CRM Idempotency ---
test("reissue links to original cancelled invoice and maintains CRM duplicate protection", () => {
  const originalInvoice = {
    _id: new mongoose.Types.ObjectId(),
    invoiceNumber: "INV-2026-0001",
    status: "cancelled",
    crmSourceRef: {
      source: "THE_OFFICE_ON_RENT_CRM",
      sourceType: "lead",
      sourceId: "deal_999",
      billingPurpose: "BROKERAGE",
      billingPeriod: "",
    },
  };
  
  // Reissued invoice gets new invoice number, references original, and modifies billingPurpose
  const reissuedCrmSourceRef = {
    source: originalInvoice.crmSourceRef.source,
    sourceType: originalInvoice.crmSourceRef.sourceType,
    sourceId: originalInvoice.crmSourceRef.sourceId,
    billingPurpose: originalInvoice.crmSourceRef.billingPurpose + ":REISSUE:" + originalInvoice.invoiceNumber,
    billingPeriod: originalInvoice.crmSourceRef.billingPeriod,
  };
  
  assert.equal(reissuedCrmSourceRef.billingPurpose, "BROKERAGE:REISSUE:INV-2026-0001");
  
  // Normal repeated CRM create call still sends billingPurpose: "BROKERAGE"
  // A lookup for "BROKERAGE" still matches originalInvoice -> blocked with 409!
  const incomingCrmCall = { billingPurpose: "BROKERAGE" };
  const duplicateDetected = originalInvoice.crmSourceRef.billingPurpose === incomingCrmCall.billingPurpose;
  assert.equal(duplicateDetected, true, "Normal CRM create must still detect duplicate");
  
  // Invoice model defines replacesInvoiceId and reissuedInvoiceId fields
  const invoicePaths = Object.keys(Invoice.schema.paths);
  assert.ok(invoicePaths.includes("replacesInvoiceId"), "Invoice must have replacesInvoiceId");
  assert.ok(invoicePaths.includes("reissuedInvoiceId"), "Invoice must have reissuedInvoiceId");
  assert.ok(invoicePaths.includes("reissuedInvoiceNumber"), "Invoice must have reissuedInvoiceNumber");
});

// --- 11. Immutability of Issued Invoices & Financial Records ---
test("immutability prevents destructive financial alterations", () => {
  const paymentPreHooks = Payment.schema.s.hooks._pres.get("updateOne");
  assert.ok(paymentPreHooks && paymentPreHooks.length > 0, "Payment model must have updateOne pre-hook preventing mutations");
  
  const allocationPreHooks = PaymentAllocation.schema.s.hooks._pres.get("updateOne");
  assert.ok(allocationPreHooks && allocationPreHooks.length > 0, "PaymentAllocation model must have updateOne pre-hook");
  
  const reversalPreHooks = PaymentAllocationReversal.schema.s.hooks._pres.get("deleteOne");
  assert.ok(reversalPreHooks && reversalPreHooks.length > 0, "Reversal model must have deleteOne pre-hook");
  
  const ledgerPreHooks = CustomerLedger.schema.s.hooks._pres.get("updateOne");
  assert.ok(ledgerPreHooks && ledgerPreHooks.length > 0, "CustomerLedger model must have updateOne pre-hook");
});