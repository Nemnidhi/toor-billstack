const { buildInvoiceTotals } = require("./invoice");
const { buildGstSnapshot } = require("./gst");
const AppError = require("./appError");
const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const buildTaxDocument = ({ business, counterparty, products = [], placeOfSupplyCode, ...input }) => {
  if (business.billingEntityCode === "GOLDHAWK") input.lineItems = input.lineItems.map(line => ({ ...line, taxRate: 0, gstClassification: "EXEMPT" }));
  const totals = buildInvoiceTotals(input);
  if (business.billingEntityCode === "GOLDHAWK" || !business.gstConfiguration?.enabled) return { totals, gstSnapshot: null };
  if (business.defaultTaxSettings?.taxMode === "inclusive") throw new AppError("Tax Inclusive is not supported. Select Tax Exclusive in GST & Tax settings before issuing.", 400);
  const gstSnapshot = buildGstSnapshot({ business, counterparty, products, placeOfSupplyCode, lineItems: totals.lineItems });
  totals.lineItems = totals.lineItems.map((line, index) => ({ ...line, taxableAmount: gstSnapshot.lines[index].taxableValue, tax: gstSnapshot.lines[index].totalTax, taxAmount: gstSnapshot.lines[index].totalTax, itemTotal: round(gstSnapshot.lines[index].taxableValue + gstSnapshot.lines[index].totalTax) }));
  totals.totalTax = gstSnapshot.totalTax;
  totals.subtotal = round(totals.subtotal); totals.totalDiscount = round(totals.totalDiscount);
  totals.grandTotal = round(totals.lineItems.reduce((sum, line) => sum + line.itemTotal, 0) + totals.shippingCharges + totals.roundOff);
  totals.balanceDue = round(Math.max(totals.grandTotal - totals.amountPaid, 0));
  totals.paymentStatus = totals.amountPaid >= totals.grandTotal ? "paid" : totals.amountPaid > 0 ? "partial" : "unpaid";
  return { totals, gstSnapshot };
};
module.exports = { buildTaxDocument };
