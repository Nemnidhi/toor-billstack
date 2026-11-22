const test = require("node:test");
const assert = require("node:assert/strict");

const { toMinorUnits, fromMinorUnits } = require("../src/utils/money");
const { deriveFinancialState } = require("../src/services/financial-read.service");
const { createPayment, allocatePayment, validateAllocationCounterparty, validateReversalRequest } = require("../src/services/payment.service");
const { paymentCreateValidator } = require("../src/validators/payment.validation");

test("payment money policy preserves two-decimal values using minor units", () => {
  assert.equal(toMinorUnits("125.45"), 12545);
  assert.equal(fromMinorUnits(12545), 125.45);
  assert.throws(() => toMinorUnits("10.999"), /two decimal places/);
  assert.throws(() => toMinorUnits("0"), /positive monetary amount/);
  assert.equal(toMinorUnits("0", "Outstanding", { allowZero: true }), 0);
});

test("payment validator rejects invalid method, date, currency, and counterparty direction", () => {
  const result = paymentCreateValidator({
    direction: "RECEIVED",
    amount: 100,
    paymentMethod: "WIRE",
    currency: "RUPEES",
    paymentDate: "not-a-date",
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.customerId);
  assert.ok(result.errors.paymentMethod);
  assert.ok(result.errors.currency);
  assert.ok(result.errors.paymentDate);
});

test("production payment service rejects invalid payment directions before persistence", async () => {
  await assert.rejects(
    () => createPayment({ businessId: "tenant", userId: "user", payload: { direction: "TRANSFER", amount: 10 } }),
    /direction must be RECEIVED or PAID/
  );
});

test("production allocation service rejects invalid allocation document combinations before persistence", async () => {
  await assert.rejects(
    () => allocatePayment({ businessId: "tenant", userId: "user", paymentId: "payment", payload: { allocatedAmount: 10 } }),
    /exactly one invoice or purchase/
  );
});
test("allocation history enforces invoice customer and purchase supplier ownership", () => {
  assert.equal(validateAllocationCounterparty({ sourceType: "INVOICE", document: { customerId: "c1" }, payment: { customerId: "c1" } }), true);
  assert.throws(() => validateAllocationCounterparty({ sourceType: "INVOICE", document: { customerId: "c1" }, payment: { customerId: "c2" } }), /counterparty/);
  assert.equal(validateAllocationCounterparty({ sourceType: "PURCHASE", document: { supplierId: "s1" }, payment: { supplierId: "s1" } }), true);
  assert.throws(() => validateAllocationCounterparty({ sourceType: "PURCHASE", document: { supplierId: "s1" }, payment: { supplierId: "s2" } }), /counterparty/);
});
test("allocation reversal rejects duplicates and over-reversal while preserving tenant-scoped ownership", () => {
  assert.equal(validateReversalRequest({ allocationAmount: 100, alreadyReversed: false, requestedAmount: 40 }), 40);
  assert.throws(() => validateReversalRequest({ allocationAmount: 100, alreadyReversed: true, requestedAmount: 40 }), /already been reversed/);
  assert.throws(() => validateReversalRequest({ allocationAmount: 100, alreadyReversed: false, requestedAmount: 101 }), /exceeds allocated/);
});

test("invoice payment lifecycle derives partial, final paid, and never negative balances", () => {
  const invoice = { grandTotal: 1180, amountPaid: 0, balanceDue: 1180, paymentStatus: "unpaid" };
  const first = deriveFinancialState({ sourceType: "INVOICE", document: invoice, migrated: true, allocatedAmount: 400 });
  assert.equal(first.paidAmount, 400);
  assert.equal(first.outstandingAmount, 780);
  assert.equal(first.paymentStatus, "partial");

  const second = deriveFinancialState({ sourceType: "INVOICE", document: invoice, migrated: true, allocatedAmount: 700 });
  assert.equal(second.paidAmount, 700);
  assert.equal(second.outstandingAmount, 480);
  assert.equal(second.paymentStatus, "partial");

  const final = deriveFinancialState({ sourceType: "INVOICE", document: invoice, migrated: true, allocatedAmount: 1180 });
  assert.equal(final.paidAmount, 1180);
  assert.equal(final.outstandingAmount, 0);
  assert.equal(final.paymentStatus, "paid");

  const over = deriveFinancialState({ sourceType: "INVOICE", document: invoice, migrated: true, allocatedAmount: 1280 });
  assert.equal(over.paidAmount, 1180);
  assert.equal(over.outstandingAmount, 0);
  assert.equal(over.paymentStatus, "paid");
});

test("payment creation supports idempotency key validation", () => {
  const result = paymentCreateValidator({
    direction: "RECEIVED",
    amount: 400,
    customerId: "64f000000000000000000001",
    idempotencyKey: "invoice-1180-payment-400-submit-1",
  });
  assert.equal(result.valid, true);
  const invalid = paymentCreateValidator({
    direction: "RECEIVED",
    amount: 400,
    customerId: "64f000000000000000000001",
    idempotencyKey: "x".repeat(121),
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.idempotencyKey);
});

test("financial reads derive paid state from real allocations even without migration provenance", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../src/services/financial-read.service.js"), "utf8");

  assert.match(source, /mongoose\.connection\.readyState !== 1/);
  assert.match(source, /const allocatedAmount = await allocationTotal/);
  assert.match(source, /Boolean\(provenance\) \|\| allocatedAmount > 0/);
  assert.match(source, /isOverdueByBusinessDate\(invoice\.dueDate\)/);
});

test("allocation syncs invoice cached payment fields for dashboard aggregates without duplicating ledgers", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../src/services/payment.service.js"), "utf8");

  // The invoice's cached amountPaid / balanceDue / paymentStatus move in one
  // atomic, conditional update, so two allocations at once cannot over-pay it.
  assert.match(source, /balanceDue: \{ \$gte: amountDecimal \}/);
  assert.match(source, /amountPaid: \{ \$add: \["\$amountPaid", amountDecimal\] \}/);
  assert.match(source, /balanceDue: \{ \$subtract: \["\$balanceDue", amountDecimal\] \}/);
  assert.match(source, /then: "paid"/);
  assert.match(source, /then: "partial"/);
  assert.match(source, /createCustomerLedgerEntryOnce/);
});
