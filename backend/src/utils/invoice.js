const buildInvoiceTotals = ({
  lineItems,
  shippingCharges = 0,
  roundOff = 0,
  amountPaid = 0,
}) => {
  const normalizedItems = lineItems.map((item) => {
    const quantity = Number(item.quantity || 0);
    const rate = Number(item.rate || 0);
    const lineBase = quantity * rate;
    const taxRate = Number(item.taxRate || 0);
    const discountType = item.discountType === "amount" ? "amount" : "percent";
    const discountValue = Number(
      item.discountValue !== undefined ? item.discountValue : item.discount || 0
    );
    const discountAmount =
      discountType === "percent"
        ? Math.min(lineBase, (lineBase * Math.max(discountValue, 0)) / 100)
        : Math.min(lineBase, Math.max(discountValue, 0));
    const taxableAmount = Math.max(lineBase - discountAmount, 0);
    const taxAmount = (taxableAmount * Math.max(taxRate, 0)) / 100;
    const itemTotal = taxableAmount + taxAmount;

    return {
      ...item,
      quantity,
      rate,
      taxRate,
      discountType,
      discountValue,
      lineBase,
      discount: discountAmount,
      discountAmount,
      taxableAmount,
      tax: taxAmount,
      taxAmount,
      itemTotal,
    };
  });

  const subtotal = normalizedItems.reduce((sum, item) => sum + item.lineBase, 0);
  const totalTax = normalizedItems.reduce((sum, item) => sum + item.taxAmount, 0);
  const totalDiscount = normalizedItems.reduce((sum, item) => sum + item.discountAmount, 0);
  const normalizedShipping = Number(shippingCharges || 0);
  const normalizedRoundOff = Number(roundOff || 0);
  const grandTotal =
    subtotal + totalTax - totalDiscount + normalizedShipping + normalizedRoundOff;
  const normalizedAmountPaid = Number(amountPaid || 0);
  const balanceDue = Math.max(grandTotal - normalizedAmountPaid, 0);

  return {
    lineItems: normalizedItems,
    subtotal,
    totalTax,
    totalDiscount,
    shippingCharges: normalizedShipping,
    roundOff: normalizedRoundOff,
    grandTotal,
    amountPaid: normalizedAmountPaid,
    balanceDue,
    paymentStatus:
      normalizedAmountPaid >= grandTotal
        ? "paid"
        : normalizedAmountPaid > 0
          ? "partial"
          : "unpaid",
  };
};

// Indian financial year of a date as "26-27" (April to March, IST).
const fyLabel = (date = new Date()) => {
  const d = new Date(new Date(date).getTime() + 330 * 60 * 1000);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${String(start).slice(2)}-${String((start + 1) % 100).padStart(2, "0")}`;
};

// {YYYY} calendar year, {FY} financial year (26-27), {0001} the running number.
const buildInvoiceNumber = ({ prefix, format, sequence, date = new Date() }) => {
  const year = String(date.getFullYear());
  const paddedSequence = String(sequence).padStart(4, "0");

  return format
    .replaceAll("{YYYY}", year)
    .replaceAll("{FY}", fyLabel(date))
    .replaceAll("{0001}", paddedSequence)
    .replaceAll("INV", prefix || "INV");
};

// The number to use for an invoice dated `date`. A format with {FY} starts again at 1 when the
// financial year changes (GST rule 46(b): a running series, unique within the year).
const invoiceSequenceFor = (numbering = {}, date = new Date()) => {
  const usesFy = /\{FY\}/.test(numbering?.format || "");
  const fy = fyLabel(date);
  if (usesFy && numbering?.sequenceFy && numbering.sequenceFy !== fy) return { sequence: 1, sequenceFy: fy };
  return { sequence: numbering?.nextSequence || 1, sequenceFy: usesFy ? fy : numbering?.sequenceFy || "" };
};

// GST invoices: at most 16 characters, letters, digits, "-" and "/" only.
const GST_INVOICE_NUMBER = /^[A-Za-z0-9/-]{1,16}$/;

module.exports = {
  GST_INVOICE_NUMBER,
  fyLabel,
  invoiceSequenceFor,
  buildInvoiceNumber,
  buildInvoiceTotals,
};
