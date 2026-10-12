const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/features/dashboard/invoiceReview.js');

const customer = { _id: 'c1', name: 'Somil Jain', gstNumber: '23ABCDE1234F1Z5', email: 's@x.co', stateCode: '23' };
const line = (over = {}) => ({ productId: '', productName: 'Coworking rent', quantity: 1, rate: 15000, taxRate: 18, discountType: 'percent', discountValue: 0, ...over });
const base = (over = {}) => ({
  form: { customerId: 'c1', invoiceDate: '2026-10-08', dueDate: '2026-10-15', placeOfSupplyCode: '23', paymentMode: 'unpaid', lineItems: [line()], ...(over.form || {}) },
  totals: { grand: 17700, ...(over.totals || {}) },
  customer: 'customer' in over ? over.customer : customer,
  business: over.business || { billingEntityCode: '' },
  ...(over.rest || {}),
});

test('a complete, normal invoice has nothing to fix or double-check', async () => {
  const { reviewInvoice } = await load();
  const r = reviewInvoice(base());
  assert.deepEqual(r, { blockers: [], warnings: [] });
});

test('missing customer, items, descriptions, quantity and rate block issuing', async () => {
  const { reviewInvoice } = await load();
  assert.ok(reviewInvoice(base({ customer: null, form: { customerId: '' } })).blockers.some((m) => /customer/i.test(m)));
  assert.ok(reviewInvoice(base({ form: { lineItems: [] } })).blockers.some((m) => /at least one item/i.test(m)));
  assert.ok(reviewInvoice(base({ form: { lineItems: [line({ productName: ' ' })] } })).blockers.some((m) => /description/i.test(m)));
  assert.ok(reviewInvoice(base({ form: { lineItems: [line({ quantity: 0 })] } })).blockers.some((m) => /quantity/i.test(m)));
  assert.ok(reviewInvoice(base({ form: { lineItems: [line({ rate: '' })] } })).blockers.some((m) => /valid rate/i.test(m)));
  assert.ok(reviewInvoice(base({ form: { lineItems: [line({ rate: -5 })] } })).blockers.some((m) => /valid rate/i.test(m)));
});

test('a saved service needs no typed description', async () => {
  const { reviewInvoice } = await load();
  assert.deepEqual(reviewInvoice(base({ form: { lineItems: [line({ productId: 'p1', productName: '' })] } })).blockers, []);
});

test('zero rate is allowed but flagged; a zero total is called out as auto-paid', async () => {
  const { reviewInvoice } = await load();
  const r = reviewInvoice(base({ form: { lineItems: [line({ rate: 0 })] }, totals: { grand: 0 } }));
  assert.deepEqual(r.blockers, []);
  assert.ok(r.warnings.some((m) => /rate of ₹0/.test(m)));
  assert.ok(r.warnings.some((m) => /total is ₹0.*paid/i.test(m)));
});

test('due date before issue date blocks; same day is fine', async () => {
  const { reviewInvoice } = await load();
  assert.ok(reviewInvoice(base({ form: { invoiceDate: '2026-10-08', dueDate: '2026-10-07' } })).blockers.some((m) => /due date/i.test(m)));
  assert.deepEqual(reviewInvoice(base({ form: { invoiceDate: '2026-10-08', dueDate: '2026-10-08' } })).blockers, []);
});

test('discounts that exceed the amount are caught', async () => {
  const { reviewInvoice } = await load();
  assert.ok(reviewInvoice(base({ form: { lineItems: [line({ discountType: 'percent', discountValue: 120 })] } })).blockers.some((m) => /100%/.test(m)));
  assert.ok(reviewInvoice(base({ form: { lineItems: [line({ discountType: 'amount', discountValue: 20000 })] } })).blockers.some((m) => /more than the item amount/.test(m)));
  assert.deepEqual(reviewInvoice(base({ form: { lineItems: [line({ discountType: 'amount', discountValue: 500 })] } })).blockers, []);
});

test('partial payment must be above zero and below the total', async () => {
  const { reviewInvoice } = await load();
  const partial = (amount) => reviewInvoice(base({ form: { paymentMode: 'partial', upfrontPaymentAmount: amount } }));
  assert.ok(partial('').blockers.some((m) => /partial/i.test(m)));
  assert.ok(partial(17700).blockers.some((m) => /partial/i.test(m)));
  assert.deepEqual(partial(5000).blockers, []);
  // editing an existing invoice does not take a payment
  assert.deepEqual(reviewInvoice({ ...base({ form: { paymentMode: 'partial', upfrontPaymentAmount: '' } }), editing: true }).blockers, []);
});

test('warnings for no GST, no GSTIN, no place of supply, no email when sending, estimated GST', async () => {
  const { reviewInvoice } = await load();
  const r = reviewInvoice({ ...base({ form: { placeOfSupplyCode: '', lineItems: [line({ taxRate: 0 })] }, customer: { _id: 'c1', name: 'X', gstNumber: '', email: '' } }), sending: true, gstEstimated: true });
  assert.deepEqual(r.blockers, []);
  for (const re of [/No item has GST/, /no GSTIN/, /Place of supply is not set/, /no email/, /estimate/]) {
    assert.ok(r.warnings.some((m) => re.test(m)), String(re));
  }
});

test('Goldhawk (non-GST) invoices are not nagged about GST or place of supply', async () => {
  const { reviewInvoice } = await load();
  const r = reviewInvoice(base({ business: { billingEntityCode: 'GOLDHAWK' }, form: { placeOfSupplyCode: '', lineItems: [line({ taxRate: 0 })] }, customer: { ...customer, stateCode: '' } }));
  assert.ok(!r.warnings.some((m) => /GST\b|Place of supply/.test(m) && !/GSTIN/.test(m)));
  assert.deepEqual(r.blockers, []);
});

test('amount in words uses Indian numbering like the issued invoice', async () => {
  const { amountInWords } = await load();
  assert.equal(amountInWords(0), 'Zero Rupees');
  assert.equal(amountInWords(35400), 'Thirty Five Thousand Four Hundred Rupees');
  assert.equal(amountInWords(17700), 'Seventeen Thousand Seven Hundred Rupees');
  assert.equal(amountInWords(100000), 'One Lakh Rupees');
  assert.equal(amountInWords(12345678), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Rupees');
  assert.equal(amountInWords(1.5), 'One Rupees and Fifty Paise');
  assert.equal(amountInWords(105), 'One Hundred Five Rupees');
  assert.equal(amountInWords(NaN), '');
});
