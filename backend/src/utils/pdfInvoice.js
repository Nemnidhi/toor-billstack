const fs = require("fs");
const path = require("path");
const pdfMake = require("pdfmake/build/pdfmake");
const pdfFonts = require("pdfmake/build/vfs_fonts");
const { states } = require("../../../shared/gst-policy.cjs");

pdfMake.vfs = pdfFonts;

const compact = (value) => String(value || "").trim();
const numeric = (value) => Number(value || 0);
const money = (value) => numeric(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-GB") : "");
const mimeByExtension = { ".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp", ".gif": "gif" };

const loadUploadedImage = (url) => {
  if (!url) return null;
  const absolutePath = path.resolve(process.cwd(), String(url).replace(/^\/+/, ""));
  const uploadRoot = path.resolve(process.cwd(), "uploads");
  if (!absolutePath.startsWith(`${uploadRoot}${path.sep}`) || !fs.existsSync(absolutePath)) return null;
  const mime = mimeByExtension[path.extname(absolutePath).toLowerCase()];
  return mime ? `data:image/${mime};base64,${fs.readFileSync(absolutePath).toString("base64")}` : null;
};

const belowThousand = (value) => {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (!value) return "";
  if (value < 20) return ones[value];
  if (value < 100) return `${tens[Math.floor(value / 10)]}${value % 10 ? ` ${ones[value % 10]}` : ""}`;
  return `${ones[Math.floor(value / 100)]} Hundred${value % 100 ? ` ${belowThousand(value % 100)}` : ""}`;
};

const indianWords = (value) => {
  const amount = Math.floor(numeric(value));
  if (!amount) return "Zero";
  return [
    [Math.floor(amount / 10000000), "Crore"],
    [Math.floor((amount % 10000000) / 100000), "Lakh"],
    [Math.floor((amount % 100000) / 1000), "Thousand"],
    [amount % 1000, ""],
  ].filter(([part]) => part).map(([part, suffix]) => `${belowThousand(part)}${suffix ? ` ${suffix}` : ""}`).join(" ");
};

const amountInWords = (value) => {
  const amount = numeric(value);
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  return `${indianWords(rupees)} Rupees${paise ? ` and ${indianWords(paise)} Paise` : ""}`;
};

const optionalLine = (label, value) => value ? { text: [{ text: `${label}: `, bold: true }, compact(value)], margin: [0, 1, 0, 1] } : null;
const labelledLine = (label, value) => ({ text: [{ text: `${label}: `, bold: true }, compact(value)], margin: [0, 1, 0, 1] });
const cell = (text = "", options = {}) => ({ text, ...options });
const borderLayout = {
  hLineColor: () => "#111827", vLineColor: () => "#111827",
  hLineWidth: () => 0.75, vLineWidth: () => 0.75,
  paddingLeft: () => 5, paddingRight: () => 5, paddingTop: () => 5, paddingBottom: () => 5,
};

const buildInvoicePdfDefinition = ({ invoice, business }) => {
  business = invoice.sellerSnapshot || require("../services/seller-snapshot.service").legacySellerSnapshot(business, invoice);
  const snapshot = invoice.gstSnapshot || {};
  const customer = invoice.customerDetails || {};
  const businessGstin = compact(invoice.sellerSnapshot ? business.gstTaxId : snapshot.gstin || invoice.businessDetails?.gstNumber || business.gstTaxId);
  const customerGstin = compact(customer.gstNumber);
  const placeOfSupply = compact(snapshot.placeOfSupply || states[snapshot.placeOfSupplyCode] || customer.state);
  const logo = loadUploadedImage(business.logoUrl);
  const signature = loadUploadedImage(business.signatureUrl);
  const cgst = numeric(snapshot.cgst);
  const sgst = numeric(snapshot.sgst);
  const igst = numeric(snapshot.igst);
  const totalTax = numeric(invoice.totalTax ?? snapshot.totalTax ?? cgst + sgst + igst);
  const taxableValue = numeric(snapshot.taxableValue ?? invoice.subtotal) - numeric(invoice.totalDiscount);
  const taxRate = numeric(snapshot.taxRate ?? invoice.lineItems?.[0]?.taxRate);
  const taxRows = [...(cgst ? [["CGST", cgst]] : []), ...(sgst ? [["SGST", sgst]] : []), ...(igst ? [["IGST", igst]] : [])];
  const lineItems = invoice.lineItems || [];
  const paymentHistory = invoice.paymentHistory || [];
  const activePayments = paymentHistory.filter((row) => !row.reversal);
  const itemBottomSpace = lineItems.length > 0 && lineItems.length <= 4 ? Math.floor((paymentHistory.length ? 100 : 180) / lineItems.length) : 7;
  const items = lineItems.map((item, index) => {
    const discount = item.discountType === "amount" ? money(item.discountAmount ?? item.discount) : `${numeric(item.discountValue)}%`;
    const itemCell = (text = "", options = {}) => cell(text, { margin: [0, 0, 0, itemBottomSpace], ...options });
    return [
      itemCell(String(index + 1), { alignment: "center" }),
      { stack: [{ text: compact(item.productName), bold: true }, ...(compact(item.description) ? [{ text: compact(item.description), fontSize: 8, margin: [0, 3, 0, 0] }] : [])], margin: [0, 0, 0, itemBottomSpace] },
      itemCell(compact(item.hsnSacCode || item.hsnSac), { alignment: "center" }),
      itemCell(money(item.rate), { alignment: "right" }),
      itemCell(discount, { alignment: "right" }),
      itemCell(money(item.itemTotal), { alignment: "right" }),
    ];
  });
  const blueCell = (text, options = {}) => cell(text, { fillColor: "#d9effb", ...options });
  const isNonGst = (invoice.sellerSnapshot?.billingEntityCode === "GOLDHAWK") || (business.billingEntityCode === "GOLDHAWK") || (!businessGstin && !totalTax);
  const invoiceTitle = isNonGst ? "INVOICE" : "TAX INVOICE";

  return {
    info: {
      title: `${isNonGst ? "Invoice" : "Tax Invoice"} ${compact(invoice.invoiceNumber)}`,
      subject: `Invoice total ${numeric(invoice.grandTotal).toFixed(2)}`,
    },
    pageSize: "A4",
    pageMargins: [28, 24, 28, 26],
    content: [
      { columns: [{ text: invoiceTitle, fontSize: 13, bold: true }, { text: "ORIGINAL FOR RECIPIENT", fontSize: 10, color: "#667085", alignment: "right" }], margin: [0, 0, 0, 14] },
      {
        table: { widths: ["*", "*"], body: [[
          { stack: [
            ...(logo ? [{ image: logo, fit: [92, 38], alignment: "left", margin: [0, 0, 0, 4] }] : []),
            { text: compact(business.name), fontSize: 14, bold: true, color: "#0369a1", margin: [0, 0, 0, 3] },
            optionalLine("Address", business.address), optionalLine("GSTIN", businessGstin), optionalLine("Mobile", business.phone), optionalLine("Email", business.email || business.billingEmail),
          ].filter(Boolean) },
          { table: { widths: ["*", "*", "*"], body: [[
            { stack: [{ text: "Invoice No.", bold: true }, { text: compact(invoice.invoiceNumber), margin: [0, 4, 0, 0] }] },
            { stack: [{ text: "Invoice Date", bold: true }, { text: formatDate(invoice.invoiceDate), margin: [0, 4, 0, 0] }] },
            { stack: [{ text: "Due Date", bold: true }, { text: formatDate(invoice.dueDate), margin: [0, 4, 0, 0] }] },
          ]] }, layout: "noBorders", margin: [5, 20, 0, 0] },
        ]] }, layout: borderLayout,
      },
      {
        table: { widths: ["*"], body: [[{ stack: [
          { text: "BILL TO", fontSize: 9, margin: [0, 0, 0, 5] },
          ...(compact(customer.name) ? [{ text: compact(customer.name), bold: true, margin: [0, 0, 0, 4] }] : []),
          optionalLine("Address", customer.address), optionalLine("GSTIN", customerGstin), optionalLine("Place of Supply", placeOfSupply), labelledLine("Mobile", customer.phone), optionalLine("Email", customer.email),
        ].filter(Boolean), margin: [1, 2, 1, 6] }]] }, layout: borderLayout,
      },
      {
        table: { headerRows: 1, widths: [25, "*", 58, 64, 60, 68], body: [
          ["No.", "SERVICES", "HSN/SAC", "RATE", "Discount", "Total"].map((text) => blueCell(text, { alignment: "center", bold: true })),
          ...items,
          ...taxRows.map(([label, value]) => [cell(""), cell(label, { italics: true, alignment: "right" }), cell(""), cell(""), cell(""), cell(`₹ ${money(value)}`, { alignment: "right" })]),
          [blueCell(""), blueCell("TOTAL", { bold: true, alignment: "right" }), blueCell(""), blueCell(""), blueCell(`₹ ${money(invoice.totalDiscount)}`, { bold: true, alignment: "right" }), blueCell(`₹ ${money(invoice.grandTotal)}`, { bold: true, alignment: "right" })],
        ] }, layout: borderLayout,
      },
      ...((businessGstin || customerGstin || totalTax) && !isNonGst ? [{
        margin: [0, 7, 0, 0],
        table: { headerRows: 1, widths: [58, "*", 40, 58, 48, 62, 68], body: [
          ["HSN/SAC", "Taxable Value", "CGST Rate", "CGST Amount", "SGST/IGST Rate", "SGST/IGST Amount", "Total Tax"].map((text) => blueCell(text, { alignment: "center", fontSize: 7.5 })),
          [cell(compact(invoice.lineItems?.[0]?.hsnSacCode || invoice.lineItems?.[0]?.hsnSac), { alignment: "center" }), cell(money(taxableValue), { alignment: "right" }), cell(cgst ? `${taxRate / 2}%` : "", { alignment: "right" }), cell(cgst ? money(cgst) : "", { alignment: "right" }), cell((sgst || igst) ? `${igst ? taxRate : taxRate / 2}%` : "", { alignment: "right" }), cell((sgst || igst) ? money(igst || sgst) : "", { alignment: "right" }), cell(`₹ ${money(totalTax)}`, { alignment: "right" })],
          [cell("Total", { bold: true, alignment: "right" }), cell(money(taxableValue), { bold: true, alignment: "right" }), cell(""), cell(cgst ? money(cgst) : "", { bold: true, alignment: "right" }), cell(""), cell((sgst || igst) ? money(igst || sgst) : "", { bold: true, alignment: "right" }), cell(`₹ ${money(totalTax)}`, { bold: true, alignment: "right" })],
        ] }, layout: borderLayout,
      }] : []),
      {
        margin: [0, 8, 0, 0],
        table: { widths: ["*", 105], body: [
          [cell("Invoice total", { bold: true }), cell(`₹ ${money(invoice.grandTotal)}`, { bold: true, alignment: "right" })],
          [cell("Amount received", { color: "#047857" }), cell(`₹ ${money(invoice.amountPaid)}`, { color: "#047857", bold: true, alignment: "right" })],
          [blueCell("Balance due", { bold: true }), blueCell(`₹ ${money(invoice.balanceDue)}`, { bold: true, alignment: "right" })],
          [cell("Payment status"), cell(compact(invoice.paymentStatus || "unpaid").replaceAll("_", " ").toUpperCase(), { bold: true, alignment: "right" })],
        ] }, layout: borderLayout,
      },
      ...(paymentHistory.length ? [{
        margin: [0, 8, 0, 0],
        table: { headerRows: 1, widths: [72, 72, "*", 75, 58], body: [
          ["Payment date", "Mode", "Reference", "Amount", "Status"].map((text) => blueCell(text, { bold: true, alignment: "center", fontSize: 8 })),
          ...paymentHistory.map((row) => [
            cell(formatDate(row.payment?.paymentDate || row.createdAt), { alignment: "center" }),
            cell(compact(row.payment?.paymentMethod).replaceAll("_", " "), { alignment: "center" }),
            cell(compact(row.payment?.referenceNumber) || "—"),
            cell(`₹ ${money(row.allocatedAmount)}`, { alignment: "right" }),
            cell(row.reversal ? "REVERSED" : "RECEIVED", { alignment: "center", color: row.reversal ? "#be123c" : "#047857" }),
          ]),
          ...(activePayments.length > 1 ? [[cell("Total received", { bold: true, colSpan: 3, alignment: "right" }), {}, {}, cell(`₹ ${money(invoice.amountPaid)}`, { bold: true, alignment: "right" }), cell("")]] : []),
        ] }, layout: borderLayout,
      }] : []),
      {
        margin: [0, 12, 0, 0],
        table: { widths: ["*"], body: [
          [{ stack: [{ text: "Total Amount (in words)", fontSize: 9 }, { text: amountInWords(invoice.grandTotal), margin: [0, 4, 0, 0] }] }],
          [{ stack: [
            ...(signature ? [{ image: signature, fit: [105, 48], alignment: "center", margin: [0, 4, 0, 3] }] : [{ text: "", margin: [0, 28, 0, 0] }]),
            { text: "Authorised Signatory For", alignment: "center", fontSize: 9 }, { text: compact(business.name), alignment: "center", fontSize: 9, bold: true, margin: [0, 2, 0, 0] },
          ] }],
        ] }, layout: borderLayout,
      },
      ...(business.bankDetails?.accountNumber || business.bankDetails?.upiId ? [{ margin: [0, 10, 0, 0], stack: [
        { text: "Payment details", bold: true },
        optionalLine("Account holder", business.bankDetails.accountName), optionalLine("Bank", business.bankDetails.bankName),
        optionalLine("Account number", business.bankDetails.accountNumber), optionalLine("IFSC", business.bankDetails.ifscCode), optionalLine("UPI", business.bankDetails.upiId),
      ].filter(Boolean) }] : []),
      ...((compact(invoice.termsAndConditions) || compact(business.invoiceTerms)) ? [{ text: "Terms & Conditions", bold: true, margin: [0, 10, 0, 3] }, { text: compact(invoice.termsAndConditions) || compact(business.invoiceTerms), fontSize: 8.5 }] : []),
    ],
    defaultStyle: { fontSize: 9, color: "#111827" },
  };
};

const generateInvoicePdfBuffer = ({ invoice, business }) => new Promise((resolve) => {
  const pdfDoc = pdfMake.createPdf(buildInvoicePdfDefinition({ invoice, business }));
  pdfDoc.getBuffer((buffer) => resolve(Buffer.from(buffer)));
  pdfDoc.getBase64(() => {});
});

module.exports = { buildInvoicePdfDefinition, generateInvoicePdfBuffer, loadUploadedImage };
