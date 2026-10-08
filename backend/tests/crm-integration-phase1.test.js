const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const service = require("../src/services/integration.service");
const credential = { source: "THE_OFFICE_ON_RENT_CRM" };

test("integration API key remains required for customer sync", () => assert.match(read("src", "routes", "integration.routes.js"), /customers\/upsert", integrationAuthMiddleware/));
test("valid customer sync payload is normalized", () => assert.deepEqual(service.normalizeCustomerSyncPayload({ externalId: "lead-1", name: " Rahul ", phone: "+91 98765 43210", email: "R@EXAMPLE.COM" }, credential), { externalId: "lead-1", source: "THE_OFFICE_ON_RENT_CRM", name: "Rahul", phone: "919876543210", email: "r@example.com", billingAddress: "", gstNumber: "", stateCode: "", placeOfSupplyCode: "" }));
test("invalid customer sync payload is rejected", () => assert.throws(() => service.normalizeCustomerSyncPayload({ externalId: "", name: "" }, credential), /externalId/));
test("invalid email is rejected", () => assert.throws(() => service.normalizeCustomerSyncPayload({ externalId: "1", name: "A", email: "bad" }, credential), /email/));
test("invalid GSTIN is rejected", () => assert.throws(() => service.normalizeCustomerSyncPayload({ externalId: "1", name: "A", gstNumber: "BAD" }, credential), /GSTIN/));
test("GSTIN state conflicts are rejected", () => assert.throws(() => service.normalizeCustomerSyncPayload({ externalId: "1", name: "A", gstNumber: "23CGZPB7175E1Z5", stateCode: "27" }, credential), /do not match/));
test("external mapping enforces tenant source identity uniqueness", () => assert.match(read("src", "models", "IntegrationCustomerMapping.js"), /businessId: 1, source: 1, externalId: 1.*unique: true/));
test("same external identity follows mapped customer path", () => assert.match(read("src", "services", "integration.service.js"), /IntegrationCustomerMapping\.findOne[\s\S]*outcome: changed \? "updated" : "already_synced"/));
test("same-business matching supports GSTIN phone and email", () => assert.match(read("src", "services", "integration.service.js"), /input\.gstNumber[\s\S]*input\.phone[\s\S]*input\.email/));
test("shared contact identifiers never block a mapped CRM customer", () => {
  const source = read("src", "services", "integration.service.js");
  assert.doesNotMatch(source, /identifiers match different existing customers/);
  assert.doesNotMatch(source, /conflict with another existing customer/);
});
test("customer creation and mapping use a transaction", () => assert.match(read("src", "services", "integration.service.js"), /syncExternalCustomer[\s\S]*withTransaction/));
test("existing external order endpoint is preserved", () => assert.match(read("src", "routes", "integration.routes.js"), /router\.post\("\/orders", integrationAuthMiddleware, ingestOrder\)/));
test("handoff customer lookup is tenant scoped", () => assert.match(read("src", "services", "integration.service.js"), /Customer\.findOne\(\{ _id: payload\.customerId, businessId: credential\.businessId \}\)/));
test("handoff token is random hashed and short lived", () => { const source = read("src", "services", "integration.service.js"); assert.match(source, /randomBytes\(32\)/); assert.match(source, /tokenHash: hashValue\(rawToken\)/); assert.match(source, /3 \* 60 \* 1000/); });
test("handoff token is purpose restricted and consumed once", () => assert.match(read("src", "services", "integration.service.js"), /purpose: "INVOICE_CREATE", usedAt: null, expiresAt: \{ \$gt: new Date\(\) \}/));
test("handoff resolution requires normal BillStack authentication", () => assert.match(read("src", "routes", "integration.routes.js"), /handoffs\/invoice\/:token", authMiddleware, tenantMiddleware/));
test("frontend reuses invoice creation and preselects handoff customer", () => { assert.match(read("..", "frontend", "src", "features", "integrations", "InvoiceHandoffPage.jsx"), /dashboard\/invoices\?action=create/); assert.match(read("..", "frontend", "src", "features", "dashboard", "pages", "InvoicesPage.jsx"), /billstack-invoice-handoff-customer/); });

test('request log URL redacts handoff path and query tokens while retaining ordinary URLs', () => {
  const { integrationLogUrl } = require('../src/utils/integrationLogUrl');
  assert.equal(integrationLogUrl({ originalUrl: '/api/integrations/handoffs/invoice/secret-token?token=another&x=1' }), '/api/integrations/handoffs/invoice/[REDACTED]?token=[REDACTED]&x=1');
  assert.equal(integrationLogUrl({ originalUrl: '/api/customers?page=2' }), '/api/customers?page=2');
});

test('server-error logging also redacts handoff tokens from path, message and stack', () => {
  const vm = require('node:vm');
  const file = path.join(root, 'src/middlewares/error.middleware.js');
  const module = { exports: {} }, logged = [];
  const localRequire = require('node:module').createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, process, require: name => name === '../utils/logger' ? { log: (...args) => logged.push(args) } : localRequire(name) });
  const url = '/api/integrations/handoffs/invoice/secret-token';
  module.exports.errorHandler(new Error(`Failure at ${url}`), { originalUrl: url, method: 'GET' }, { status() { return this; }, json() {} });
  assert.equal(logged.length, 1); assert.ok(!JSON.stringify(logged).includes('secret-token'));
});

function loadIntegration(stubs) {
  const vm = require('node:vm');
  const file = path.join(root, 'src/services/integration.service.js');
  const localRequire = require('node:module').createRequire(file), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => name in stubs ? stubs[name] : localRequire(name), process, Date, URL, Buffer });
  return module.exports;
}

test('actual consume operation enforces tenant, expiry and single use before revealing customer', async () => {
  const row = { tokenHash: service.hashValue('test-token'), businessId: 'tenant-a', usedAt: null, expiresAt: new Date(Date.now() + 60000), customerId: { _id: 'customer-a' }, purpose: 'INVOICE_CREATE' };
  const api = loadIntegration({ '../models/IntegrationHandoff': {
    findOneAndUpdate(filter, update) {
      const matches = row.tokenHash === filter.tokenHash && row.businessId === filter.businessId && row.usedAt === null && row.expiresAt > filter.expiresAt.$gt;
      if (matches) Object.assign(row, update.$set);
      return { populate: async () => matches ? row : null };
    },
  } });
  await assert.rejects(api.resolveInvoiceHandoff({ token: 'test-token', businessId: 'tenant-b', userId: 'u' }), /invalid, expired, used/);
  assert.equal(row.usedAt, null);
  const result = await api.resolveInvoiceHandoff({ token: 'test-token', businessId: 'tenant-a', userId: 'u' });
  assert.equal(result.customer._id, 'customer-a');
  await assert.rejects(api.resolveInvoiceHandoff({ token: 'test-token', businessId: 'tenant-a', userId: 'u' }), /invalid, expired, used/);
  row.usedAt = null; row.expiresAt = new Date(0);
  await assert.rejects(api.resolveInvoiceHandoff({ token: 'test-token', businessId: 'tenant-a', userId: 'u' }), /invalid, expired, used/);
});

test('mapped CRM customer attribute edits and explicit clears retain the same mapping', async () => {
  const customer = { _id: 'customer-a', name: 'Customer', phone: '9876543210', email: 'old@example.test', billingAddress: 'Old', gstNumber: '23CGZPB7175E1Z5', async save() {} };
  const mapping = { customerId: customer._id, async save() {} };
  const sessionQuery = value => ({ session: async () => value });
  const api = loadIntegration({
    mongoose: { startSession: async () => ({ withTransaction: async fn => fn(), endSession() {} }) },
    '../models/IntegrationCustomerMapping': { findOne: () => sessionQuery(mapping) },
    '../models/Customer': { findOne: () => sessionQuery(customer), find: () => ({ limit: () => sessionQuery([]) }), create() { assert.fail('must not duplicate customer'); } },
  });
  const result = await api.syncExternalCustomer({ credential: { businessId: 'tenant-a', source: 'THE_OFFICE_ON_RENT_CRM' }, payload: { externalId: 'toor:company:coworking-client:client', name: 'Customer', phone: '9123456789', email: '', billingAddress: 'New address', gstNumber: '' } });
  assert.equal(result.customer._id, 'customer-a'); assert.equal(result.mapping, mapping);
  assert.equal(customer.phone, '9123456789'); assert.equal(customer.email, ''); assert.equal(customer.gstNumber, ''); assert.equal(customer.billingAddress, 'New address');
});
