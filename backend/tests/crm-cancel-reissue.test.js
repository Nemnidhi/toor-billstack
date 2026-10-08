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


test('after an invoice is cancelled, the same CRM source can be invoiced again; a live one still blocks', async () => {
  const mongoose = require('mongoose');
  const Invoice = require('../src/models/Invoice');
  const company = new mongoose.Types.ObjectId(), customerId = new mongoose.Types.ObjectId(), userId = new mongoose.Types.ObjectId();
  const q = value => ({ session() { return this; }, sort() { return this; }, populate() { return this; }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });
  const invoices = [];
  const business = { _id: company, name: 'Test workspace', invoiceNumbering: { nextSequence: 1, prefix: 'TEST', format: 'INV-{YYYY}-{0001}' }, gstConfiguration: { enabled: false }, async save() {} };
  const customer = { _id: customerId, name: 'Test customer', async save() {} };
  const ref = (invoice) => invoice.crmSourceRef || {};
  const controller = load('controllers/invoice.controller.js', {
    mongoose: { ...mongoose, startSession: async () => ({ withTransaction: async fn => fn(), endSession() {} }) },
    '../utils/asyncHandler': fn => fn,
    '../models/Business': { findById: id => q(String(id) === String(company) ? business : null) },
    '../models/Customer': { findOne: () => q(customer) },
    '../models/Product': { find: () => q([]) },
    '../models/Invoice': {
      // Honours the same filter fields the controller uses, like MongoDB would.
      findOne: (filter) => q(invoices.find(i => ref(i).sourceId === filter['crmSourceRef.sourceId']
        && ref(i).billingPeriod === filter['crmSourceRef.billingPeriod']
        && (!filter.status || i.status === filter.status)) || null),
      collection: {
        async updateMany(filter, update) {
          let n = 0;
          for (const i of invoices) {
            if (i.status === filter.status && ref(i).sourceId === filter['crmSourceRef.sourceId'] && ref(i).billingPeriod === filter['crmSourceRef.billingPeriod']) {
              i.voidedCrmSourceRef = i.crmSourceRef; i.crmSourceRef = undefined; n++;
            }
          }
          return { modifiedCount: n };
        },
      },
      async create(rows) { const invoice = new Invoice(rows[0]); invoices.push(invoice); return [invoice]; },
      findById: () => q(invoices[0]), find: () => q(invoices),
    },
    '../services/communication.service': { dispatchInvoiceIssuedAutomation: async () => {} },
  });
  const req = { tenant: { businessId: company }, user: { _id: userId }, body: {
    customerId,
    crmSourceRef: { source: 'THE_OFFICE_ON_RENT_CRM', sourceType: 'board', sourceId: 'multi:client:2026-10', billingPurpose: 'RENT', billingPeriod: '2026-10' },
    lineItems: [{ productName: 'Coworking rental', quantity: 1, rate: 0 }],
  } };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.createInvoice(req, res);
  assert.equal(res.code, 201);
  await assert.rejects(controller.createInvoice(req, res), error => error.statusCode === 409, 'a live invoice still blocks a duplicate');
  assert.equal(invoices.length, 1);
  invoices[0].status = 'cancelled';
  await controller.createInvoice(req, res);
  assert.equal(invoices.length, 2, 'a replacement invoice is issued after the first is cancelled');
  assert.equal(invoices[0].voidedCrmSourceRef.sourceId, 'multi:client:2026-10', 'the cancelled invoice keeps its audit reference');
  assert.equal(invoices[1].crmSourceRef.sourceId, 'multi:client:2026-10');
});
