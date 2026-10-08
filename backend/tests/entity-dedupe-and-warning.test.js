const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Invoice = require("../src/models/Invoice");
const Payment = require("../src/models/Payment");
const Expense = require("../src/models/Expense");
const JournalEntry = require("../src/models/JournalEntry");
const { pickCanonicalEntities } = require("../src/services/billing-entity.service");
const { getHistoricalWarning } = require("../src/services/accounting-reports.service");

const oid = () => new mongoose.Types.ObjectId();
const lean = (rows) => ({ select: () => ({ lean: async () => rows }) });

const stub = (target, name, impl) => {
  const original = target[name];
  target[name] = impl;
  return () => { target[name] = original; };
};

test("duplicate Goldhawk companies collapse to the one that holds invoices", async () => {
  const root = { _id: oid(), name: "THE OFFICE ON RENT", billingEntityCode: "TOOR", createdAt: new Date("2026-01-01") };
  const emptyCopy = { _id: oid(), name: "Goldhawk Infrabulls Pvt. Ltd.", billingEntityCode: "GOLDHAWK", billingParentId: root._id, createdAt: new Date("2026-02-01") };
  const realCopy = { _id: oid(), name: "Goldhawk Infrabulls Pvt. Ltd.", billingEntityCode: "GOLDHAWK", billingParentId: root._id, createdAt: new Date("2026-03-01") };
  const restore = stub(Invoice, "countDocuments", async ({ businessId }) => (String(businessId) === String(realCopy._id) ? 7 : 0));
  try {
    const picked = await pickCanonicalEntities([root, emptyCopy, realCopy], { rootId: root._id });
    assert.deepEqual(picked.map((row) => String(row._id)).sort(), [String(root._id), String(realCopy._id)].sort());
  } finally {
    restore();
  }
});

test("with no invoices anywhere, the in-group and then oldest copy wins", async () => {
  const root = { _id: oid(), billingEntityCode: "TOOR", createdAt: new Date("2026-01-01") };
  const outside = { _id: oid(), billingEntityCode: "GOLDHAWK", billingParentId: oid(), createdAt: new Date("2025-01-01") };
  const older = { _id: oid(), billingEntityCode: "GOLDHAWK", billingParentId: root._id, createdAt: new Date("2026-02-01") };
  const newer = { _id: oid(), billingEntityCode: "GOLDHAWK", billingParentId: root._id, createdAt: new Date("2026-04-01") };
  const restore = stub(Invoice, "countDocuments", async () => 0);
  try {
    const picked = await pickCanonicalEntities([root, outside, newer, older], { rootId: root._id });
    assert.ok(picked.some((row) => row === older));
    assert.ok(!picked.includes(newer) && !picked.includes(outside));
  } finally {
    restore();
  }
});

test("accounting warning only counts records that are really missing journal entries", async () => {
  const businessId = oid();
  const posted = oid();
  const missing = oid();
  const pay = oid();
  const exp = oid();
  const queries = [];
  const restores = [
    stub(Invoice, "find", (query) => { queries.push(["invoice", query]); return lean([{ _id: posted }, { _id: missing }]); }),
    stub(Payment, "find", (query) => { queries.push(["payment", query]); return lean([{ _id: pay }]); }),
    stub(Expense, "find", (query) => { queries.push(["expense", query]); return lean([{ _id: exp }]); }),
    stub(JournalEntry, "find", () => lean([
      { sourceKey: `INVOICE:${posted}:ISSUED` },
      { sourceKey: `PAYMENT:${pay}:RECEIVED` },
      { sourceKey: `EXPENSE:${exp}:RECORDED` },
    ])),
  ];
  try {
    const warning = await getHistoricalWarning({ businessId });
    assert.equal(warning.hasUnpostedLegacyData, true);
    assert.deepEqual(
      { invoices: warning.unpostedCounts.invoices, payments: warning.unpostedCounts.payments, expenses: warning.unpostedCounts.expenses },
      { invoices: 1, payments: 0, expenses: 0 }
    );
    const paymentQuery = queries.find(([kind]) => kind === "payment")[1];
    assert.equal(paymentQuery.direction, "RECEIVED", "supplier payments never get receipt entries");
    const invoiceQuery = queries.find(([kind]) => kind === "invoice")[1];
    assert.deepEqual(invoiceQuery.grandTotal, { $gt: 0 }, "zero-value invoices are not journaled");
  } finally {
    restores.forEach((restore) => restore());
  }
});

test("accounting warning clears once every eligible record is posted", async () => {
  const inv = oid();
  const restores = [
    stub(Invoice, "find", () => lean([{ _id: inv }])),
    stub(Payment, "find", () => lean([])),
    stub(Expense, "find", () => lean([])),
    stub(JournalEntry, "find", () => lean([{ sourceKey: `INVOICE:${inv}:ISSUED` }])),
  ];
  try {
    const warning = await getHistoricalWarning({ businessId: oid(), fromDate: "2026-04-01", toDate: "2027-03-31" });
    assert.equal(warning.hasUnpostedLegacyData, false);
    assert.equal(warning.status, "COMPLETE");
  } finally {
    restores.forEach((restore) => restore());
  }
});
