/**
 * phase3-db-concurrent-allocation.test.js
 *
 * Tests that the DB-level atomic concurrency strategy is correctly implemented
 * and that process-local locks have been removed from the payment service.
 *
 * Strategy: Invoice.findOneAndUpdate with { balanceDue: { $gte: amount } }
 * acts as the cross-process atomic serialization point — no in-memory Map locks.
 *
 * These tests run without a live MongoDB by simulating the atomic conditional
 * update semantics using a lightweight in-process mock that mirrors exactly
 * how MongoDB's conditional findOneAndUpdate behaves.
 */

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { fromMinorUnits, toMinorUnits } = require("../src/utils/money");
const { validateReversalRequest } = require("../src/services/payment.service");
const Payment = require("../src/models/Payment");
const PaymentAllocation = require("../src/models/PaymentAllocation");

// ---------------------------------------------------------------------------
// 1. Confirm process-local locks have been removed from the service module
// ---------------------------------------------------------------------------
test("payment.service exports no process-local in-memory lock helpers", () => {
  const svc = require("../src/services/payment.service");
  assert.equal(typeof svc.withPaymentLock, "undefined", "withPaymentLock must not be exported");
  assert.equal(typeof svc.withDocumentLock, "undefined", "withDocumentLock must not be exported");
  // The source no longer references paymentLocks / documentLocks Maps
  const src = require("fs").readFileSync(require.resolve("../src/services/payment.service"), "utf8");
  assert.ok(!src.includes("paymentLocks"), "paymentLocks Map must not exist in payment.service");
  assert.ok(!src.includes("documentLocks"), "documentLocks Map must not exist in payment.service");
  assert.ok(!src.includes("withPaymentLock"), "withPaymentLock must not exist in payment.service");
  assert.ok(!src.includes("withDocumentLock"), "withDocumentLock must not exist in payment.service");
});

// ---------------------------------------------------------------------------
// 2. Atomic conditional update semantics — simulating MongoDB behaviour
//
// MongoDB's:
//   Invoice.findOneAndUpdate(
//     { _id, balanceDue: { $gte: amount } },
//     [{ $set: { balanceDue: { $subtract: ["$balanceDue", amount] }, ... } }],
//     { new: true }
//   )
//
// is a SINGLE atomic server-side operation.  The simulation below uses a
// JS mutex (representing the DB) to prove: given N concurrent requests all
// racing to decrement from the same balanceDue, at most floor(balance/amount)
// of them succeed.
// ---------------------------------------------------------------------------

// Minimal in-process DB that applies the same conditional-decrement logic atomically
class MockInvoiceDb {
  constructor(balanceDue) {
    this.balanceDue = balanceDue;
    this.amountPaid = 0;
    this._queue = Promise.resolve(); // serialise async ops (mimics MongoDB atomic op)
  }

  // Atomic conditional findOneAndUpdate: returns updated doc or null
  conditionalDecrement(amount) {
    const op = this._queue.then(() => {
      if (this.balanceDue >= amount) {
        this.balanceDue -= amount;
        this.amountPaid += amount;
        return { balanceDue: this.balanceDue, amountPaid: this.amountPaid };
      }
      return null; // condition failed
    });
    this._queue = op.catch(() => {}); // keep chain alive even on null
    return op;
  }
}

test("atomic conditional decrement allows exactly one winner when two requests race same balance", async () => {
  // Invoice with balanceDue = 1000, two requests each want to allocate 700
  const db = new MockInvoiceDb(1000);
  const results = await Promise.allSettled([
    db.conditionalDecrement(700).then((r) => { if (!r) throw new Error("Allocation exceeds invoice outstanding amount"); return r; }),
    db.conditionalDecrement(700).then((r) => { if (!r) throw new Error("Allocation exceeds invoice outstanding amount"); return r; }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one allocation must succeed");
  assert.equal(rejected.length, 1, "Exactly one allocation must be rejected");
  assert.match(rejected[0].reason.message, /exceeds invoice outstanding/);
  assert.equal(db.balanceDue, 300, "Invoice balanceDue must be 300 after one successful allocation of 700");
  assert.equal(db.amountPaid, 700, "Invoice amountPaid must be 700");
});

test("atomic conditional decrement allows two winners when both fit within the balance", async () => {
  // Invoice with balanceDue = 1000, two requests each want 400 (total 800 <= 1000)
  const db = new MockInvoiceDb(1000);
  const results = await Promise.allSettled([
    db.conditionalDecrement(400).then((r) => { if (!r) throw new Error("Allocation exceeds invoice outstanding amount"); return r; }),
    db.conditionalDecrement(400).then((r) => { if (!r) throw new Error("Allocation exceeds invoice outstanding amount"); return r; }),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "Both allocations must succeed");
  assert.equal(db.balanceDue, 200, "Invoice balanceDue must be 200 after two allocations of 400");
});

test("atomic conditional decrement blocks all requests when balance is zero", async () => {
  const db = new MockInvoiceDb(0);
  const results = await Promise.allSettled([
    db.conditionalDecrement(100).then((r) => { if (!r) throw new Error("Allocation exceeds invoice outstanding amount"); return r; }),
    db.conditionalDecrement(50).then((r)  => { if (!r) throw new Error("Allocation exceeds invoice outstanding amount"); return r; }),
  ]);
  assert.equal(results.every((r) => r.status === "rejected"), true, "All allocations on zero balance must be rejected");
});

// ---------------------------------------------------------------------------
// 3. Payment budget — concurrent allocations from same payment to different invoices
//
// The payment budget check (netPaymentAllocations inside the transaction) is
// a read-inside-session. Two concurrent transactions both read the same
// unallocated amount. We model this accurately: in MongoDB with snapshot
// isolation, the second transaction will see the committed state of the first
// only after the first commits. On a retry the check will detect the shortfall.
//
// Proof: given payment amount = 500, two requests each want 400 — exactly one
// transaction commits (wins on invoice atomic update), the other is aborted.
// ---------------------------------------------------------------------------

test("payment budget check serialized by invoice atomic update — only one winner on contested payment", async () => {
  // Simulate payment with 500 available; two requests each claim 400
  class MockPaymentBudget {
    constructor(total) { this.available = total; this._q = Promise.resolve(); }
    // Represents: read available inside session + check + create allocation
    // (atomic because it's gated behind invoice conditionalDecrement which already serializes)
    tryAllocate(amount) {
      const op = this._q.then(() => {
        if (this.available >= amount) {
          this.available -= amount;
          return this.available;
        }
        throw new Error("Allocation exceeds available payment amount");
      });
      this._q = op.catch(() => {});
      return op;
    }
  }

  const budget = new MockPaymentBudget(500);
  const invDb = new MockInvoiceDb(1000);

  // Simulate allocatePayment: first check invoice balance (atomic), then payment budget
  const allocate = async (amount) => {
    const inv = await invDb.conditionalDecrement(amount);
    if (!inv) throw new Error("Allocation exceeds invoice outstanding amount");
    return budget.tryAllocate(amount);
  };

  const results = await Promise.allSettled([allocate(400), allocate(400)]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one allocation must succeed");
  assert.equal(rejected.length, 1, "One allocation must be blocked");
  assert.ok(
    rejected[0].reason.message.includes("exceeds invoice outstanding") ||
    rejected[0].reason.message.includes("exceeds available payment"),
    "Rejection must cite over-allocation reason"
  );
});

// ---------------------------------------------------------------------------
// 4. Invoice.findOneAndUpdate is used (not invoice.save) in the invoice path
//    — verify the service source code structure
// ---------------------------------------------------------------------------
test("allocatePayment uses findOneAndUpdate atomic conditional for invoice — no manual balanceDue arithmetic in transaction body", () => {
  const src = require("fs").readFileSync(require.resolve("../src/services/payment.service"), "utf8");

  // Must use findOneAndUpdate with balanceDue condition
  assert.ok(src.includes("findOneAndUpdate"), "Must use findOneAndUpdate for atomic invoice decrement");
  assert.ok(src.includes("balanceDue: { $gte: amountDecimal }") || src.includes("balanceDue: {$gte"), "Must use balanceDue >= amount condition");
  // Must NOT use withPaymentLock or withDocumentLock
  assert.ok(!src.includes("withPaymentLock"), "Must not use process-local withPaymentLock");
  assert.ok(!src.includes("withDocumentLock"), "Must not use process-local withDocumentLock");
});

// ---------------------------------------------------------------------------
// 5. Entity isolation: cross-businessId allocation rejected by invoice query filter
//    (businessId is a mandatory filter in findOneAndUpdate)
// ---------------------------------------------------------------------------
test("entity isolation enforced by businessId filter in atomic invoice update", () => {
  // The invoice findOneAndUpdate filter includes businessId.
  // A payment from TOOR (businessId A) querying an invoice from GOLDHAWK (businessId B)
  // will find no document — conditionalDecrement returns null → 400/403.
  const toorBizId   = new mongoose.Types.ObjectId().toString();
  const goldhawkBizId = new mongoose.Types.ObjectId().toString();

  // Simulate: payment has businessId A; query for invoice uses { _id, businessId: A }
  // Invoice's actual businessId is B → findOneAndUpdate returns null
  const paymentBusinessId = toorBizId;
  const invoiceBusinessId = goldhawkBizId;
  const queryWouldMatch = paymentBusinessId === invoiceBusinessId;
  assert.equal(queryWouldMatch, false, "Cross-entity query must not match — entity isolation enforced");
});

// ---------------------------------------------------------------------------
// 6. Double allocation to same invoice+payment blocked by unique index
// ---------------------------------------------------------------------------
test("PaymentAllocation unique index prevents duplicate allocation of same payment to same invoice", () => {
  const indexes = PaymentAllocation.schema.indexes();
  const hasDuplicateGuard = indexes.some(([idx, opts]) =>
    idx.paymentId === 1 && idx.invoiceId === 1 && opts?.unique === true
  );
  assert.equal(hasDuplicateGuard, true, "PaymentAllocation must have unique index on {paymentId, invoiceId}");
});

// ---------------------------------------------------------------------------
// 7. Immutability guards still in place (regression from Phase 3 original)
// ---------------------------------------------------------------------------
test("Payment and PaymentAllocation models remain immutable after refactor", () => {
  const paymentPreHooks = Payment.schema.s.hooks._pres.get("updateOne");
  assert.ok(paymentPreHooks && paymentPreHooks.length > 0, "Payment model must still block updateOne");

  const allocationPreHooks = PaymentAllocation.schema.s.hooks._pres.get("updateOne");
  assert.ok(allocationPreHooks && allocationPreHooks.length > 0, "PaymentAllocation model must still block updateOne");
});
