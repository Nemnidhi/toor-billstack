// Pre-issue review of an invoice: pure functions, no network, no side effects.
//
// `reviewInvoice` returns
//   blockers - problems that make issuing wrong or impossible (the Confirm button stays disabled)
//   warnings - things that are legitimate but worth a second look (the user may still confirm)
// The backend remains the authority and re-validates everything when the invoice is issued.

const num = (value) => (value === "" || value == null ? NaN : Number(value));
const present = (value) => Number.isFinite(num(value));
const dayKey = (value) => String(value || "").slice(0, 10);

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`);
const below1000 = (n) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${below100(n % 100)}` : ""}` : below100(n));

// Indian numbering (lakh / crore), matching the wording printed on the issued invoice.
export function amountInWords(amount) {
  const value = Math.abs(Number(amount));
  if (!Number.isFinite(value)) return "";
  const minor = Math.round(value * 100);
  const rupees = Math.floor(minor / 100);
  const paise = minor % 100;
  if (rupees === 0 && paise === 0) return "Zero Rupees";
  const parts = [];
  let rest = rupees;
  for (const [size, label] of [[10000000, "Crore"], [100000, "Lakh"], [1000, "Thousand"]]) {
    const chunk = Math.floor(rest / size);
    if (chunk) parts.push(`${below1000(chunk)} ${label}`);
    rest %= size;
  }
  if (rest) parts.push(below1000(rest));
  const words = parts.length ? `${parts.join(" ")} Rupees` : "";
  const paiseWords = paise ? `${below100(paise)} Paise` : "";
  return [words, paiseWords].filter(Boolean).join(" and ");
}

export function reviewInvoice({ form, totals, customer, business, sending = false, gstEstimated = false, editing = false }) {
  const blockers = [];
  const warnings = [];
  const lines = Array.isArray(form?.lineItems) ? form.lineItems : [];
  const goldhawk = business?.billingEntityCode === "GOLDHAWK";

  if (!form?.customerId || !customer) blockers.push("Select the customer to bill.");
  if (!lines.length) blockers.push("Add at least one item.");

  lines.forEach((line, index) => {
    const label = `Item ${index + 1}`;
    if (!line.productId && String(line.productName || "").trim().length < 2) blockers.push(`${label}: add a description.`);
    if (!(num(line.quantity) > 0)) blockers.push(`${label}: quantity must be greater than zero.`);
    if (!present(line.rate) || num(line.rate) < 0) blockers.push(`${label}: enter a valid rate (zero is allowed).`);
    else if (num(line.rate) === 0) warnings.push(`${label} has a rate of ₹0.`);
    const tax = num(line.taxRate ?? 0);
    if (!goldhawk && (!Number.isFinite(tax) || tax < 0 || tax > 100)) blockers.push(`${label}: GST % must be between 0 and 100.`);
    const discount = num(line.discountValue ?? 0);
    if (!Number.isFinite(discount) || discount < 0) blockers.push(`${label}: discount cannot be negative.`);
    else if (line.discountType === "percent" && discount > 100) blockers.push(`${label}: discount cannot be more than 100%.`);
    else if (line.discountType === "amount" && present(line.rate) && discount > num(line.quantity) * num(line.rate)) {
      blockers.push(`${label}: discount is more than the item amount.`);
    }
  });

  if (!form?.invoiceDate) blockers.push("Set the issue date.");
  if (form?.invoiceDate && form?.dueDate && dayKey(form.dueDate) < dayKey(form.invoiceDate)) {
    blockers.push("The due date is before the issue date.");
  }
  if (!editing && form?.paymentMode === "partial") {
    const paid = num(form.upfrontPaymentAmount);
    if (!(paid > 0) || paid >= totals.grand) blockers.push("Partial payment must be more than ₹0 and less than the invoice total.");
  }
  if (!Number.isFinite(totals?.grand)) blockers.push("The invoice total could not be calculated.");

  if (Number.isFinite(totals?.grand) && lines.length) {
    if (totals.grand === 0) warnings.push("The invoice total is ₹0, so it will be issued as already paid.");
    else if (totals.grand < 0) blockers.push("The invoice total is negative.");
  }
  if (!goldhawk && lines.length && lines.every((line) => !(num(line.taxRate ?? 0) > 0))) {
    warnings.push("No item has GST. Check that this invoice really is tax-free.");
  }
  if (!goldhawk && !form?.placeOfSupplyCode && !customer?.placeOfSupplyCode && !customer?.stateCode) {
    warnings.push("Place of supply is not set, so the tax split (CGST/SGST or IGST) may not be what you expect.");
  }
  if (customer && !String(customer.gstNumber || "").trim()) warnings.push("The customer has no GSTIN. The invoice will be issued without one.");
  if (sending && customer && !String(customer.email || "").trim()) warnings.push("The customer has no email address, so the invoice cannot be emailed.");
  if (gstEstimated) warnings.push("GST shown here is an estimate. The final tax is calculated when the invoice is issued.");

  return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}
