// Wait for a complete editable line before asking the server to calculate tax.
// Issuing an invoice still goes through the authoritative backend validation.
export function isInvoicePreviewReady(form) {
  const number = value => value !== "" && value != null && Number.isFinite(Number(value));
  return Boolean(form.customerId && Array.isArray(form.lineItems) && form.lineItems.length &&
    form.lineItems.every(item => item &&
      (item.productId || String(item.productName || "").trim().length >= 2) &&
      number(item.quantity) && Number(item.quantity) > 0 &&
      number(item.rate) && Number(item.rate) >= 0 &&
      number(item.taxRate ?? 0) && Number(item.taxRate ?? 0) >= 0 && Number(item.taxRate ?? 0) <= 100 &&
      number(item.discountValue ?? 0) && Number(item.discountValue ?? 0) >= 0));
}
