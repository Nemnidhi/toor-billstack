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
  if (typeof url === "string" && url.startsWith("data:image/")) return url;

  const cleanUrl = String(url).replace(/^\/+/, "");
  const filename = path.basename(cleanUrl);

  const candidatePaths = [
    path.resolve(process.cwd(), cleanUrl),
    path.resolve(process.cwd(), "uploads", "logos", filename),
    path.resolve(process.cwd(), "uploads", "signatures", filename),
    path.resolve(__dirname, "../../uploads/logos", filename),
    path.resolve(__dirname, "../../uploads/signatures", filename),
    path.resolve("C:/Users/asus/Desktop/Nemnidhi/toor-billstack/backend/uploads/logos", filename),
    path.resolve("C:/Users/asus/Desktop/Nemnidhi/toor-billstack/backend/uploads/signatures", filename),
    path.resolve("C:/Users/asus/Desktop/Nemnidhi/billstack/backend/uploads/logos", filename),
    path.resolve("C:/Users/asus/Desktop/Nemnidhi/billstack/backend/uploads/signatures", filename),
    path.resolve("C:/Users/asus/Desktop/Nemnidhi/billstack/uploads/logos", filename),
  ];

  for (const absPath of candidatePaths) {
    if (fs.existsSync(absPath)) {
      const mime = mimeByExtension[path.extname(absPath).toLowerCase()] || "png";
      return `data:image/${mime};base64,${fs.readFileSync(absPath).toString("base64")}`;
    }
  }
  return null;
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

const resolveItemHsnSac = (item = {}, context = {}) => {
  const explicit = compact(item?.hsnSacCode || item?.hsnSac);
  if (explicit) return explicit;

  const name = compact(item?.productName || item?.description || item?.name).toLowerCase();
  const purpose = compact(context.billingPurpose || context.purpose).toLowerCase();
  const isResidential = name.includes("residential") || context.billingType === "RESIDENTIAL";

  // Coworking / Managed Spaces / Shared Offices
  if (name.includes("coworking") || name.includes("co-working") || name.includes("desk") || name.includes("cabin") || name.includes("workstation") || name.includes("meeting room") || name.includes("flex space") || name.includes("workspace")) {
    return "997212";
  }

  // Virtual Office / Support Services
  if (name.includes("virtual office") || name.includes("mail handling") || name.includes("business address")) {
    return "998599";
  }

  // Brokerage / Agency / Commission (Commercial or Residential Sale / Purchase / Resale / Rent facilitation)
  if (name.includes("brokerage") || name.includes("commission") || name.includes("facilitat") || name.includes("sale") || name.includes("purchase") || name.includes("resale") || name.includes("agency") || purpose.includes("brokerage")) {
    return "997222";
  }

  // Rent / Lease of Real Estate
  if (name.includes("rent") || name.includes("lease") || name.includes("tenant") || purpose.includes("rent")) {
    return isResidential ? "997211" : "997212";
  }

  // Maintenance / CAM / Amenities
  if (name.includes("maintenance") || name.includes("cam") || name.includes("amenit")) {
    return "997212";
  }

  // Consulting / Professional
  if (name.includes("consult") || name.includes("advis")) {
    return "998311";
  }

  // Fallback for THE OFFICE ON RENT / TOOR
  if (context.isToorEntity || context.billingEntityCode === "TOOR") {
    return name.includes("broker") ? "997222" : "997212";
  }

  return "";
};

const buildInvoicePdfDefinition = ({ invoice, business = {} }) => {
  const snapshot = invoice.gstSnapshot || {};
  const customer = invoice.customerDetails || {};

  // Standardize Business Name: TOOR -> THE OFFICE ON RENT
  let businessName = compact(business.name || invoice.sellerSnapshot?.name || "THE OFFICE ON RENT");
  if (businessName.toUpperCase() === "TOOR" || invoice.billingEntityCode === "TOOR" || invoice.sellerSnapshot?.billingEntityCode === "TOOR") {
    businessName = "THE OFFICE ON RENT";
  }

  // Seller Details
  const isToorEntity = businessName.toUpperCase().includes("OFFICE ON RENT") || invoice.billingEntityCode === "TOOR" || invoice.sellerSnapshot?.billingEntityCode === "TOOR";
  const businessGstin = compact(
    snapshot.gstin ||
    business.gstTaxId ||
    business.gstConfiguration?.gstin ||
    invoice.businessDetails?.gstNumber ||
    invoice.sellerSnapshot?.gstTaxId ||
    (isToorEntity ? "23CGZPB7175E1Z5" : "")
  );

  const businessAddress = compact(
    business.address ||
    invoice.sellerSnapshot?.address ||
    (isToorEntity ? "Gravity Mall, Vijay Nagar, Indore, Madhya Pradesh - 452010" : "")
  );

  const businessPhone = compact(
    business.phone ||
    invoice.sellerSnapshot?.phone ||
    (isToorEntity ? "83495-23485" : "")
  );

  const businessEmail = compact(
    business.email ||
    business.billingEmail ||
    invoice.sellerSnapshot?.email ||
    invoice.sellerSnapshot?.billingEmail ||
    (isToorEntity ? "info@theofficeonrent.com" : "")
  );

  // Logo & Signature
  const logoUrl = business.logoUrl || invoice.sellerSnapshot?.logoUrl || (isToorEntity ? "/uploads/logos/6ab5011de114ca233484c92e-1791194584876-d1fb73ff55a65b7590585ad4.png" : "");
  const signatureUrl = business.signatureUrl || invoice.sellerSnapshot?.signatureUrl || "";
  const logo = loadUploadedImage(logoUrl);
  const signature = loadUploadedImage(signatureUrl);

  // Customer GSTIN: show '-' or 'Nil' if unregistered/empty
  const rawCustomerGstin = compact(customer.gstNumber || customer.gstin);
  const customerGstinDisplay = rawCustomerGstin || "-";

  // State resolution
  const sellerStateCode = compact(business.gstConfiguration?.stateCode || businessGstin?.slice(0, 2) || (isToorEntity ? "23" : ""));
  const placeOfSupply = compact(
    snapshot.placeOfSupply ||
    states[snapshot.placeOfSupplyCode] ||
    customer.state ||
    (isToorEntity ? "Madhya Pradesh (23)" : "")
  );
  const buyerStateCode = compact(customer.stateCode || rawCustomerGstin?.slice(0, 2) || snapshot.placeOfSupplyCode || sellerStateCode);
  const isInterState = Boolean(buyerStateCode && sellerStateCode && buyerStateCode !== sellerStateCode);

  // Taxes & Breakdown calculation
  let cgst = numeric(snapshot.cgst || invoice.gstBreakup?.cgst);
  let sgst = numeric(snapshot.sgst || invoice.gstBreakup?.sgst);
  let igst = numeric(snapshot.igst || invoice.gstBreakup?.igst);
  const totalTax = numeric(invoice.totalTax ?? snapshot.totalTax ?? (cgst + sgst + igst));
  const subtotal = numeric(snapshot.taxableValue ?? invoice.subtotal);
  const totalDiscount = numeric(invoice.totalDiscount || 0);
  const taxableValue = subtotal - totalDiscount;

  let taxRate = numeric(snapshot.taxRate ?? invoice.lineItems?.[0]?.taxRate);
  if (!taxRate && taxableValue > 0 && totalTax > 0) {
    taxRate = Math.round((totalTax / taxableValue) * 100);
  }
  if (!taxRate && totalTax > 0) taxRate = 18;

  // Fallback calculation if explicit breakup is 0 but totalTax > 0
  if (totalTax > 0 && cgst === 0 && sgst === 0 && igst === 0) {
    if (isInterState) {
      igst = totalTax;
    } else {
      cgst = Math.round((totalTax / 2) * 100) / 100;
      sgst = Math.round((totalTax - cgst) * 100) / 100;
    }
  }

  const cgstRate = cgst > 0 ? (taxRate ? `${taxRate / 2}%` : "9%") : "";
  const sgstRate = sgst > 0 ? (taxRate ? `${taxRate / 2}%` : "9%") : "";
  const igstRate = igst > 0 ? (taxRate ? `${taxRate}%` : "18%") : "";

  const taxRows = [
    ...(cgst > 0 ? [["CGST" + (cgstRate ? ` (${cgstRate})` : ""), cgst]] : []),
    ...(sgst > 0 ? [["SGST" + (sgstRate ? ` (${sgstRate})` : ""), sgst]] : []),
    ...(igst > 0 ? [["IGST" + (igstRate ? ` (${igstRate})` : ""), igst]] : []),
  ];

  const sacContext = {
    isToorEntity,
    billingEntityCode: invoice.billingEntityCode || invoice.sellerSnapshot?.billingEntityCode,
    billingType: invoice.billingType,
    billingPurpose: invoice.sourceRef?.billingPurpose,
  };
  const lineItems = invoice.lineItems || [];
  const paymentHistory = invoice.paymentHistory || [];
  const activePayments = paymentHistory.filter((row) => !row.reversal);
  const itemBottomSpace = lineItems.length > 0 && lineItems.length <= 4 ? Math.floor((paymentHistory.length ? 80 : 130) / lineItems.length) : 7;

  const items = lineItems.map((item, index) => {
    const itemSac = resolveItemHsnSac(item, sacContext);
    const discount = item.discountType === "amount" ? money(item.discountAmount ?? item.discount) : `${numeric(item.discountValue)}%`;
    const discountAmt = item.discountType === "amount" ? numeric(item.discountAmount ?? item.discount) : (numeric(item.rate) * numeric(item.quantity || 1) * numeric(item.discountValue || 0) / 100);
    const itemTaxable = numeric(item.taxableAmount || (numeric(item.rate) * numeric(item.quantity || 1) - discountAmt));
    const itemAmount = (totalTax > 0 && itemTaxable > 0) ? itemTaxable : numeric(item.itemTotal || item.rate);
    const itemCell = (text = "", options = {}) => cell(text, { margin: [0, 0, 0, itemBottomSpace], ...options });
    return [
      itemCell(String(index + 1), { alignment: "center" }),
      { stack: [{ text: compact(item.productName), bold: true }, ...(compact(item.description) ? [{ text: compact(item.description), fontSize: 8, margin: [0, 3, 0, 0] }] : [])], margin: [0, 0, 0, itemBottomSpace] },
      itemCell(itemSac, { alignment: "center" }),
      itemCell(money(item.rate), { alignment: "right" }),
      itemCell(discount, { alignment: "right" }),
      itemCell(money(itemAmount), { alignment: "right" }),
    ];
  });
  const blueCell = (text, options = {}) => cell(text, { fillColor: "#d9effb", ...options });

  const isTaxInvoice = Boolean(totalTax > 0 || businessGstin);
  const invoiceTitle = isTaxInvoice ? "TAX INVOICE" : "INVOICE";
  const firstItemSac = resolveItemHsnSac(lineItems[0], sacContext);

  return {
    info: {
      title: `${invoiceTitle} ${compact(invoice.invoiceNumber)}`,
      subject: `Invoice total ${numeric(invoice.grandTotal).toFixed(2)}`,
    },
    pageSize: "A4",
    pageMargins: [28, 24, 28, 26],
    content: [
      { columns: [{ text: invoiceTitle, fontSize: 13, bold: true }, { text: "ORIGINAL FOR RECIPIENT", fontSize: 10, color: "#667085", alignment: "right" }], margin: [0, 0, 0, 14] },
      {
        table: { widths: ["*", "*"], body: [[
          { stack: [
            ...(logo ? [{ image: logo, fit: [120, 48], alignment: "left", margin: [0, 0, 0, 6] }] : []),
            { text: businessName, fontSize: 14, bold: true, color: "#0369a1", margin: [0, 0, 0, 3] },
            optionalLine("Address", businessAddress),
            optionalLine("GSTIN", businessGstin),
            optionalLine("Mobile", businessPhone),
            optionalLine("Email", businessEmail),
          ].filter(Boolean) },
          { table: { widths: ["*", "*", "*"], body: [[
            { stack: [{ text: "Invoice No.", bold: true }, { text: compact(invoice.invoiceNumber), margin: [0, 4, 0, 0] }] },
            { stack: [{ text: "Invoice Date", bold: true }, { text: formatDate(invoice.invoiceDate), margin: [0, 4, 0, 0] }] },
            { stack: [{ text: "Due Date", bold: true }, { text: formatDate(invoice.dueDate), margin: [0, 4, 0, 0] }] },
          ]] }, layout: "noBorders", margin: [5, 15, 0, 0] },
        ]] }, layout: borderLayout,
      },
      {
        table: { widths: ["*"], body: [[{ stack: [
          { text: "BILL TO", fontSize: 9, bold: true, color: "#475467", margin: [0, 0, 0, 4] },
          ...(compact(customer.name) ? [{ text: compact(customer.name), bold: true, fontSize: 10, margin: [0, 0, 0, 3] }] : []),
          optionalLine("Address", customer.address || customer.billingAddress),
          { text: [{ text: "GSTIN: ", bold: true }, customerGstinDisplay], margin: [0, 1, 0, 1] },
          optionalLine("Place of Supply", placeOfSupply),
          labelledLine("Mobile", customer.phone),
          optionalLine("Email", customer.email),
        ].filter(Boolean), margin: [1, 2, 1, 6] }]] }, layout: borderLayout,
      },
      {
        table: { headerRows: 1, widths: [25, "*", 58, 64, 60, 68], body: [
          ["No.", "SERVICES", "HSN/SAC", "RATE", "Discount", totalTax > 0 ? "Taxable Value" : "Total"].map((text) => blueCell(text, { alignment: "center", bold: true })),
          ...items,
          ...taxRows.map(([label, value]) => [
            cell(""),
            cell(label, { italics: true, alignment: "right" }),
            cell(""), cell(""), cell(""),
            cell(`₹ ${money(value)}`, { alignment: "right" })
          ]),
          [
            blueCell(""),
            blueCell("TOTAL", { bold: true, alignment: "right" }),
            blueCell(""),
            blueCell(""),
            blueCell(totalDiscount > 0 ? `₹ ${money(totalDiscount)}` : "", { bold: true, alignment: "right" }),
            blueCell(`₹ ${money(invoice.grandTotal)}`, { bold: true, alignment: "right" })
          ],
        ] }, layout: borderLayout,
      },
      ...(isTaxInvoice && (businessGstin || rawCustomerGstin || totalTax) ? [{
        margin: [0, 7, 0, 0],
        table: { headerRows: 1, widths: [55, "*", 45, 55, 45, 55, 65], body: [
          ["HSN/SAC", "Taxable Value", "CGST Rate", "CGST Amount", isInterState ? "IGST Rate" : "SGST Rate", isInterState ? "IGST Amount" : "SGST Amount", "Total Tax"].map((text) => blueCell(text, { alignment: "center", fontSize: 7.5, bold: true })),
          [
            cell(firstItemSac, { alignment: "center" }),
            cell(money(taxableValue), { alignment: "right" }),
            cell(cgst > 0 ? cgstRate : "-", { alignment: "center" }),
            cell(cgst > 0 ? money(cgst) : "-", { alignment: "right" }),
            cell(isInterState ? (igst > 0 ? igstRate : "-") : (sgst > 0 ? sgstRate : "-"), { alignment: "center" }),
            cell(isInterState ? (igst > 0 ? money(igst) : "-") : (sgst > 0 ? money(sgst) : "-"), { alignment: "right" }),
            cell(`₹ ${money(totalTax)}`, { alignment: "right", bold: true }),
          ],
          [
            cell("Total", { bold: true, alignment: "right" }),
            cell(money(taxableValue), { bold: true, alignment: "right" }),
            cell(""),
            cell(cgst > 0 ? money(cgst) : "-", { bold: true, alignment: "right" }),
            cell(""),
            cell(isInterState ? (igst > 0 ? money(igst) : "-") : (sgst > 0 ? money(sgst) : "-"), { bold: true, alignment: "right" }),
            cell(`₹ ${money(totalTax)}`, { bold: true, alignment: "right" }),
          ],
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
          [{ stack: [{ text: "Total Amount (in words)", fontSize: 9, bold: true }, { text: amountInWords(invoice.grandTotal), margin: [0, 4, 0, 0] }] }],
          [{ stack: [
            ...(signature ? [{ image: signature, fit: [105, 48], alignment: "center", margin: [0, 4, 0, 3] }] : [{ text: "", margin: [0, 24, 0, 0] }]),
            { text: "Authorised Signatory For", alignment: "center", fontSize: 9 },
            { text: businessName, alignment: "center", fontSize: 10, bold: true, margin: [0, 2, 0, 0] },
          ] }],
        ] }, layout: borderLayout,
      },
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

module.exports = { buildInvoicePdfDefinition, generateInvoicePdfBuffer, loadUploadedImage, resolveItemHsnSac };
