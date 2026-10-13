const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Invoice = require("../src/models/Invoice");
const { findPossibleDuplicateInvoices, billingMonth } = require("../src/services/invoice-duplicate.service");

const oid = () => new mongoose.Types.ObjectId();

const withInvoices = async (rows, fn) => {
  const original = Invoice.find;
  let lastFilter = null;
  Invoice.find = (filter) => {
    lastFilter = filter;
    const chain = { select: () => chain, sort: () => chain, limit: () => chain, session: () => chain, lean: async () => rows };
    return chain;
  };
  try {
    return await fn(() => lastFilter);
  } finally {
    Invoice.find = original;
  }
};

const existing = (overrides = {}) => ({
  _id: oid(),
  invoiceNumber: "INV-2026-0006",
  invoiceDate: new Date("2026-10-03T06:00:00Z"),
  grandTotal: 29500,
  status: "issued",
  lineItems: [{ productName: "Cabin rent – A-12 (4 Seater)" }],
  ...overrides,
});

test("billing month uses the CRM period first, otherwise the invoice date in IST", () => {
  assert.equal(billingMonth({ crmSourceRef: { billingPeriod: "2026-09" }, invoiceDate: "2026-10-05" }), "2026-09");
  // 31 Oct 20:00 UTC is already 1 Nov in India.
  assert.equal(billingMonth({ invoiceDate: "2026-10-31T20:00:00Z" }), "2026-11");
});

test("a manual invoice repeating the same item for the same client and month is flagged", async () => {
  await withInvoices([existing()], async (filter) => {
    const result = await findPossibleDuplicateInvoices({
      businessId: oid(),
      customerId: oid(),
      invoiceDate: "2026-10-12",
      lineItems: [{ productName: "cabin rent  -  a-12 (4 seater)" }],
      grandTotal: 31000,
    });
    assert.equal(result.length, 1);
    assert.match(result[0].reason, /Same item/);
    assert.deepEqual(filter().status, { $nin: ["cancelled", "draft"] }, "cancelled invoices never block");
  });
});

test("same total in the same month is flagged even when the description changed", async () => {
  await withInvoices([existing()], async () => {
    const result = await findPossibleDuplicateInvoices({
      businessId: oid(), customerId: oid(), invoiceDate: "2026-10-20",
      lineItems: [{ productName: "Office rent October" }], grandTotal: 29500,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].reason, "Same total amount");
  });
});

test("a different extra charge in the same month is not flagged", async () => {
  await withInvoices([existing()], async () => {
    const result = await findPossibleDuplicateInvoices({
      businessId: oid(), customerId: oid(), invoiceDate: "2026-10-20",
      lineItems: [{ productName: "Meeting room – 4 hrs" }], grandTotal: 2360,
    });
    assert.deepEqual(result, []);
  });
});
