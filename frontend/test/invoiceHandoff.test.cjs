const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBillingContext } = require('../../backend/src/services/integration.service');

for (const rate of [0, '0', 100, null, undefined, '', ' ', 'invalid', NaN, Infinity, -1, false]) {
  test(`CRM handoff rate ${String(rate)} survives normalization and editable prefill correctly`, async () => {
    const { handoffRate, hasInvoiceRate } = await import('../src/features/dashboard/invoiceHandoff.js');
    const context = normalizeBillingContext({ billingType: 'COWORKING', billingEntityCode: '',
      prefill: { lineItems: [{ productName: 'Coworking rental', quantity: 1, rate, rateReliable: true }] } });
    const valid = [0, '0', 100].includes(rate);
    const item = JSON.parse(JSON.stringify(context)).prefill.lineItems[0];
    assert.equal(item.rateReliable, valid);
    assert.equal(item.rate, valid ? Number(rate) : null);
    assert.deepEqual(handoffRate(item), { rate: valid ? String(rate) : '', rateRequired: !valid });
    assert.equal(hasInvoiceRate(handoffRate(item).rate), valid);
    assert.deepEqual(handoffRate({ rate, rateReliable: true }), { rate: valid ? String(rate) : '', rateRequired: !valid });
  });
}

test('unknown CRM amount stays editable and accepts an intentional user-entered zero', async () => {
  const { handoffRate, hasInvoiceRate } = await import('../src/features/dashboard/invoiceHandoff.js');
  assert.deepEqual(handoffRate({ rate: 0, rateReliable: false }), { rate: '', rateRequired: true });
  assert.equal(hasInvoiceRate(''), false);
  assert.equal(hasInvoiceRate('0'), true);
});

test('zero and missing rate stay distinct through the persisted handoff schema', async () => {
  const Handoff = require('../../backend/src/models/IntegrationHandoff');
  const { handoffRate } = await import('../src/features/dashboard/invoiceHandoff.js');
  const billingContext = normalizeBillingContext({ billingType: 'COWORKING', billingEntityCode: '',
    prefill: { lineItems: [{ rate: 0, rateReliable: true }, { rate: null, rateReliable: true }] } });
  const record = new Handoff({ billingContext });
  const items = JSON.parse(JSON.stringify(record)).billingContext.prefill.lineItems;
  assert.deepEqual(handoffRate(items[0]), { rate: '0', rateRequired: false });
  assert.deepEqual(handoffRate(items[1]), { rate: '', rateRequired: true });
});

test('existing invoice validation and calculation accept zero without allowing negative rates', () => {
  const { invoiceCreateValidator } = require('../../backend/src/validators/resource.validation');
  const { buildInvoiceTotals } = require('../../backend/src/utils/invoice');
  const invoice = { customerId: 'test-customer', lineItems: [{ productName: 'Coworking rental', quantity: 1, rate: 0 }] };
  assert.equal(invoiceCreateValidator(invoice).valid, true);
  assert.equal(buildInvoiceTotals(invoice).grandTotal, 0);
  invoice.lineItems[0].rate = -1;
  assert.equal(invoiceCreateValidator(invoice).valid, false);
});
