const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const CustomerLedger = require("../src/models/CustomerLedger");
const SupplierLedger = require("../src/models/SupplierLedger");
const { createCustomerLedgerEntryOnce } = require("../src/services/ledger.service");

const src = (...parts) => fs.readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");

const withPatched = async (patches, fn) => {
  const originals = patches.map(([target, key, value]) => {
    const original = target[key];
    target[key] = value;
    return [target, key, original];
  });
  try {
    return await fn();
  } finally {
    originals.reverse().forEach(([target, key, original]) => {
      target[key] = original;
    });
  }
};

const query = (value) => ({
  session() {
    return this;
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  },
});

test("CustomerLedger remains append-only and service creates idempotent events without updates", async () => {
  await assert.rejects(
    () => CustomerLedger.updateOne({ sourceKey: "x" }, { $set: { notes: "bad" } }),
    /Customer ledger entries are append-only/
  );

  const entry = {
    businessId: new mongoose.Types.ObjectId(),
    customerId: new mongoose.Types.ObjectId(),
    eventType: "CREDIT",
    amount: 10,
    direction: "CREDIT",
    sourceKey: "TEST:CUSTOMER_LEDGER:ONCE",
  };
  let createCalls = 0;

  await withPatched(
    [
      [CustomerLedger, "create", async (rows) => {
        createCalls += 1;
        return rows;
      }],
      [CustomerLedger, "findOne", () => query(entry)],
    ],
    async () => {
      const created = await createCustomerLedgerEntryOnce(entry);
      assert.equal(created.sourceKey, entry.sourceKey);
      assert.equal(createCalls, 1);
    }
  );
});

test("ledger idempotency handles duplicate insert by reading existing append-only entry", async () => {
  const entry = {
    businessId: new mongoose.Types.ObjectId(),
    customerId: new mongoose.Types.ObjectId(),
    eventType: "CREDIT",
    amount: 10,
    direction: "CREDIT",
    sourceKey: "TEST:CUSTOMER_LEDGER:DUPLICATE",
  };
  let readExisting = false;

  await withPatched(
    [
      [CustomerLedger, "create", async () => {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }],
      [CustomerLedger, "findOne", (filter) => {
        readExisting = true;
        assert.equal(String(filter.businessId), String(entry.businessId));
        assert.equal(filter.sourceKey, entry.sourceKey);
        return query({ ...entry, _id: new mongoose.Types.ObjectId() });
      }],
    ],
    async () => {
      const existing = await createCustomerLedgerEntryOnce(entry);
      assert.equal(existing.sourceKey, entry.sourceKey);
      assert.equal(readExisting, true);
    }
  );
});

test("financial callers no longer update append-only ledgers directly", () => {
  const files = [
    src("controllers", "invoice.controller.js"),
    src("controllers", "purchase.controller.js"),
    src("services", "quote.service.js"),
    src("services", "workflow.service.js"),
    src("services", "integration.service.js"),
    src("services", "financial-migration.service.js"),
    src("services", "sales-lifecycle.service.js"),
    src("services", "payment.service.js"),
  ].join("\n");

  assert.doesNotMatch(files, /CustomerLedger\.updateOne/);
  assert.doesNotMatch(files, /CustomerLedger\.findOneAndUpdate/);
  assert.doesNotMatch(files, /CustomerLedger\.updateMany/);
  assert.doesNotMatch(files, /SupplierLedger\.updateOne/);
  assert.doesNotMatch(files, /SupplierLedger\.findOneAndUpdate/);
  assert.doesNotMatch(files, /SupplierLedger\.updateMany/);
  assert.match(files, /createCustomerLedgerEntryOnce/);
});

test("payment allocation ledger events do not reuse paymentId unique key", () => {
  const paymentService = src("services", "payment.service.js");
  const allocationEntryPattern = /createCustomerLedgerEntryOnce\(\s*\{ businessId, customerId: (?:updatedInvoice|invoice)\.customerId, eventType: "PAYMENT"[\s\S]*?sourceKey: `PAYMENT_ALLOCATION:\$\{allocation\._id\}`[\s\S]*?\}/;
  const allocationEntry = paymentService.match(allocationEntryPattern)?.[0] || "";

  assert.match(allocationEntry, /allocationId: allocation\._id/);
  assert.match(allocationEntry, /sourceKey: `PAYMENT_ALLOCATION:\$\{allocation\._id\}`/);
  assert.doesNotMatch(allocationEntry, /paymentId: payment\._id/);
});

test("payment creation does not create customer ledger credits before allocation", () => {
  const paymentService = src("services", "payment.service.js");
  const createPaymentBlock = paymentService.match(/const createPayment = async[\s\S]*?const allocatePayment = async/)?.[0] || "";

  assert.doesNotMatch(createPaymentBlock, /CustomerLedger\.create/);
  assert.doesNotMatch(createPaymentBlock, /SupplierLedger\.create/);
  assert.doesNotMatch(createPaymentBlock, /createCustomerLedgerEntryOnce/);
  assert.doesNotMatch(createPaymentBlock, /createSupplierLedgerEntryOnce/);
  assert.match(createPaymentBlock, /idempotencyKey/);
});

test("sales lifecycle UI guards duplicate mutations and de-duplicates identical toasts", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "features", "dashboard", "pages", "SalesLifecyclePage.jsx"), "utf8");
  const store = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", "store", "uiStore.js"), "utf8");

  assert.match(page, /pendingActionRef/);
  assert.match(page, /if \(!beginAction\("credit"\)\) return/);
  assert.match(page, /if \(!beginAction\("return"\)\) return/);
  assert.match(store, /duplicate = state\.toasts\.some/);
  assert.match(store, /row\.title === toast\.title/);
  assert.match(store, /row\.message === toast\.message/);
});
