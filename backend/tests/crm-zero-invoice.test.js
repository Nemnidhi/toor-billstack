const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function load(file, stubs) {
  const filename = path.resolve(__dirname, '../src', file);
  const module = { exports: {} }, localRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: name => name in stubs ? stubs[name] : localRequire(name), process, Date, console,
  }, { filename });
  return module.exports;
}

test('zero invoices and their reversals create no ledger entry; positive invoices still post once', async () => {
  const writes = [];
  const ledger = load('services/ledger.service.js', { '../models/CustomerLedger': {
    async create(rows) { writes.push(rows[0]); return rows; },
  } });
  for (const eventType of ['INVOICE', 'REVERSAL']) {
    const entry = { invoiceId: 'test-invoice', eventType, amount: 0 };
    assert.equal(await ledger.createCustomerLedgerEntryOnce(entry), null);
    assert.equal(await ledger.createCustomerLedgerEntryOnce(entry), null);
  }
  assert.equal(writes.length, 0);
  await ledger.createCustomerLedgerEntryOnce({ invoiceId: 'test-invoice', eventType: 'INVOICE', amount: 100 });
  assert.equal(writes.length, 1); assert.equal(writes[0].amount, 100);
});

test('zero invoice exception does not bypass validation for missing/invalid amounts or payments', async () => {
  const ledger = load('services/ledger.service.js', { '../models/CustomerLedger': {
    async create() { throw new Error('Ledger validation remains required'); },
  } });
  for (const amount of [undefined, null, -1, NaN, '0']) {
    await assert.rejects(ledger.createCustomerLedgerEntryOnce({ invoiceId: 'test-invoice', eventType: 'INVOICE', amount }), /validation/);
  }
  await assert.rejects(ledger.createCustomerLedgerEntryOnce({ invoiceId: 'test-invoice', eventType: 'PAYMENT', amount: 0 }), /validation/);
});

test('zero-total invoice journal posting is a no-op, while manual zero journal entries remain invalid', async () => {
  const accounting = require('../src/services/accounting.service');
  const input = { invoice: { grandTotal: 0, totalTax: 0 }, business: {} };
  assert.equal(await accounting.postInvoiceJournalEntry(input), null);
  assert.equal(await accounting.postInvoiceJournalEntry(input), null);
  await assert.rejects(accounting.postJournalEntry({ lines: [
    { debitMinor: 0, creditMinor: 0 }, { debitMinor: 0, creditMinor: 0 },
  ] }), /non-zero/);
});

test('CRM zero invoice is issued through the controller; repeated source and foreign tenant remain rejected', async () => {
  const mongoose = require('mongoose');
  const Invoice = require('../src/models/Invoice');
  const company = new mongoose.Types.ObjectId(), customerId = new mongoose.Types.ObjectId(), userId = new mongoose.Types.ObjectId();
  const q = value => ({ session() { return this; }, sort() { return this; }, populate() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  const invoices = [];
  const business = { _id: company, name: 'Test workspace', invoiceNumbering: { nextSequence: 1, prefix: 'TEST', format: 'INV-{YYYY}-{0001}' }, gstConfiguration: { enabled: false }, async save() {} };
  const customer = { _id: customerId, name: 'Test customer', async save() {} };
  const controller = load('controllers/invoice.controller.js', {
    mongoose: { ...mongoose, startSession: async () => ({ withTransaction: async fn => fn(), endSession() {} }) },
    '../utils/asyncHandler': fn => fn,
    '../models/Business': { findById: id => q(String(id) === String(company) ? business : null) },
    '../models/Customer': { findOne(filter) { assert.equal(String(filter.businessId.$in[0]), String(company)); return q(customer); } },
    '../models/Product': { find(filter) { assert.equal(String(filter.businessId), String(company)); return q([]); } },
    '../models/Invoice': {
      findOne: () => q(invoices[0] || null),
      async create(rows) {
        const invoice = new Invoice(rows[0]);
        assert.equal(invoice.validateSync(), undefined);
        invoices.push(invoice); return [invoice];
      },
      findById: () => q(invoices[0]), find: () => q(invoices),
    },
    '../services/communication.service': { dispatchInvoiceIssuedAutomation: async () => {} },
  });
  const req = { tenant: { businessId: company }, user: { _id: userId }, body: {
    customerId,
    crmSourceRef: { source: 'THE_OFFICE_ON_RENT_CRM', sourceType: 'board', sourceId: 'test-room:test-agreement', billingPurpose: 'RENT', billingPeriod: '2026-10' },
    lineItems: [{ productName: 'Coworking rental', quantity: 1, rate: 0 }],
  } };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.createInvoice(req, res);
  assert.equal(res.code, 201); assert.equal(res.body.data.grandTotal, 0);
  assert.equal(res.body.data.status, 'issued'); assert.equal(customer.invoiceHistory[0].amount, 0);
  await assert.rejects(controller.createInvoice(req, res), error => error.statusCode === 409);
  assert.equal(invoices.length, 1);
  await assert.rejects(controller.createInvoice({ ...req, tenant: { businessId: new mongoose.Types.ObjectId() } }, res), /Business not found/);
});
