const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/features/dashboard/invoicePreview.js');
const valid = () => ({ customerId: 'crm-customer', lineItems: [{ productName: 'Office service', quantity: 1, rate: 250, taxRate: 0 }] });
test('CRM customer-only handoff must not send the initial blank line to tax preview', async () => {
  const { isInvoicePreviewReady } = await load();
  assert.equal(isInvoicePreviewReady({customerId:'crm-customer',lineItems:[{productId:'',productName:'',quantity:1,rate:'',taxRate:0}]}), false);
  assert.equal(isInvoicePreviewReady(valid()), true);
});
test('waits for all rows and complete numeric input, but permits explicit zero rate', async () => {
  const { isInvoicePreviewReady } = await load();
  for (const change of [{productName:' '},{productName:'A'},{rate:''},{rate:-1},{rate:'invalid'},{quantity:0},{quantity:''},{taxRate:101},{discountValue:-1}]) {
    const form=valid();Object.assign(form.lineItems[0],change);assert.equal(isInvoicePreviewReady(form),false,JSON.stringify(change));
  }
  const zero=valid();zero.lineItems[0].rate=0;assert.equal(isInvoicePreviewReady(zero),true);
  const multiple=valid();multiple.lineItems.push({productName:'',quantity:1,rate:''});assert.equal(isInvoicePreviewReady(multiple),false);
  assert.equal(isInvoicePreviewReady({customerId:'crm-customer'}),false);
  assert.equal(isInvoicePreviewReady({...valid(),customerId:''}),false);
  const product=valid();product.lineItems[0].productName='';product.lineItems[0].productId='product';assert.equal(isInvoicePreviewReady(product),true);
});
