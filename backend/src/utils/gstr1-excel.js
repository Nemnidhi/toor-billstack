const XLSX = require("xlsx");

/**
 * Writes GSTR-1 data as the same workbook TallyPrime exports for the GST offline tool:
 * identical sheet names, titles in row 1, column headers in row 4, data from row 5.
 * Amendment / export / advance sheets are included with headers only.
 */

const SHEETS = [
  { name: "b2b,sez,de", title: ["Summary For B2B(4)"], headers: ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"], key: "b2b",
    row: (r) => [r.gstin, r.name || null, r.invoiceNumber, r.invoiceDate, r.invoiceValue, r.pos, r.reverseCharge, null, r.invoiceType, null, r.rate, r.taxableValue, 0] },
  { name: "b2ba", title: ["Summary For B2BA", "Original details ", null, null, "Revised Details "], merges: ["E1:N1"], headers: ["GSTIN/UIN of Recipient", "Receiver Name", "Original Invoice Number", "Original Invoice date", "Revised Invoice Number", "Revised Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"] },
  { name: "b2cl", title: ["Summary For B2CL(5)"], headers: ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"], key: "b2cl",
    row: (r) => [r.invoiceNumber, r.invoiceDate, r.invoiceValue, r.pos, null, r.rate, r.taxableValue, 0, null] },
  { name: "b2cla", title: ["Summary For B2CLA", "Original details ", null, null, "Revised Details "], merges: ["E1:J1"], headers: ["Original Invoice Number", "Original Invoice date", "Original Place Of Supply", "Revised Invoice Number", "Revised Invoice date", "Invoice Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"] },
  { name: "b2cs", title: ["Summary For B2CS(7)"], headers: ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"], key: "b2cs",
    row: (r) => [r.type, r.pos, null, r.rate, r.taxableValue, 0, null] },
  { name: "b2csa", title: ["Summary For B2CSA", "Original details ", "Revised details"], merges: ["C1:H1"], headers: ["Financial Year", "Original Month", "Place Of Supply", "Type", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"] },
  { name: "cdnr", title: ["Summary For CDNR(9B)"], headers: ["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"], key: "cdnr",
    row: (r) => [r.gstin, r.name || null, r.noteNumber, r.noteDate, r.noteType, r.pos, r.reverseCharge, r.noteSupplyType, r.noteValue, null, r.rate, r.taxableValue, 0] },
  { name: "cdnra", title: ["Summary For CDNRA", "Original details ", null, null, "Revised details"], merges: ["B1:D1", "E1:N1"], headers: ["GSTIN/UIN of Recipient", "Receiver Name", "Original Note Number", "Original Note Date", "Revised Note Number", "Revised Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"] },
  { name: "cdnur", title: ["Summary For CDNUR(9B)"], headers: ["UR Type", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"], key: "cdnur",
    row: (r) => [r.urType, r.noteNumber, r.noteDate, r.noteType, r.pos, r.noteValue, null, r.rate, r.taxableValue, 0] },
  { name: "cdnura", title: ["Summary For CDNURA", "Original details ", null, "Revised details"], merges: ["B1:C1", "D1:K1"], headers: ["UR Type", "Original Note Number", "Original Note Date", "Revised Note Number", "Revised Note Date", "Note Type", "Place Of Supply", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"] },
  { name: "exp", title: ["Summary For EXP(6)"], headers: ["Export Type", "Invoice Number", "Invoice date", "Invoice Value", "Port Code", "Shipping Bill Number", "Shipping Bill Date", "Rate", "Taxable Value", "Cess Amount"] },
  { name: "expa", title: ["Summary For EXPA", "Original details ", null, "Revised details"], merges: ["D1:K1"], headers: ["Export Type", "Original Invoice Number", "Original Invoice date", "Revised Invoice Number", "Revised Invoice date", "Invoice Value", "Port Code", "Shipping Bill Number", "Shipping Bill Date", "Rate", "Taxable Value", "Cess Amount"] },
  { name: "at", title: ["Summary For Advance Received (11B) "], headers: ["Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Received", "Cess Amount"] },
  { name: "ata", title: ["Summary For Amended Tax Liability(Advance Received) ", "Original details ", null, "Revised details"], merges: ["B1:C1", "D1:F1"], headers: ["Financial Year", "Original Month", "Original Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Received", "Cess Amount"] },
  { name: "atadj", title: ["Summary For Advance Adjusted (11B) "], headers: ["Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Adjusted", "Cess Amount"] },
  { name: "atadja", title: ["Summary For Amendement Of Adjustment Advances", "Original details ", null, "Revised details"], merges: ["B1:C1", "D1:F1"], headers: ["Financial Year", "Original Month", "Original Place Of Supply", "Applicable % of Tax Rate", "Rate", "Gross Advance Adjusted", "Cess Amount"] },
  { name: "exemp", title: ["Summary For Nil rated, exempted and non GST outward supplies (8)"], headers: ["Description", "Nil Rated Supplies", "Exempted (other than nil rated/non GST supply )", "Non-GST supplies"], key: "exemp" },
  { name: "hsn(b2b)", title: ["Summary For HSN(12)"], headers: ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"], key: "hsnB2B",
    row: (r) => [r.hsn, r.description || null, r.uqc, r.quantity, r.totalValue, r.rate, r.taxableValue, r.igst, r.cgst, r.sgst, 0] },
  { name: "hsn(b2c)", title: ["Summary For HSN(12)"], headers: ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"], key: "hsnB2C",
    row: (r) => [r.hsn, r.description || null, r.uqc, r.quantity, r.totalValue, r.rate, r.taxableValue, r.igst, r.cgst, r.sgst, 0] },
  { name: "docs", title: ["Summary of documents issued during the tax period (13)"], row2: [null, null, null, "Total Number", "Total Cancelled"], headers: ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"], key: "docs",
    row: (r) => [r.nature, r.from, r.to, r.total, r.cancelled] },
];

const DATE_FORMAT = "dd-mmm-yyyy";

const exempRows = (exemp) => [
  ["Inter-State supplies to registered persons", exemp.interRegistered],
  ["Intra-State supplies to registered persons", exemp.intraRegistered],
  ["Inter-State supplies to unregistered persons", exemp.interUnregistered],
  ["Intra-State supplies to unregistered persons", exemp.intraUnregistered],
].map(([label, v]) => [label, v.nil, v.exempt, v.nonGst]);

const buildSheet = (spec, data) => {
  const width = spec.headers.length;
  const pad = (row) => [...row, ...Array(Math.max(0, width - row.length)).fill(null)];
  const rows = [pad(spec.title), pad(spec.row2 || []), pad([]), spec.headers];
  if (spec.key === "exemp") rows.push(...exempRows(data.exemp));
  else if (spec.key) rows.push(...(data[spec.key] || []).map(spec.row));

  const sheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  // Real dates shown the way the offline tool expects.
  Object.keys(sheet).forEach((ref) => {
    if (ref[0] === "!") return;
    const cell = sheet[ref];
    if (cell.v instanceof Date) { cell.t = "d"; cell.z = DATE_FORMAT; }
  });
  if (spec.merges) sheet["!merges"] = spec.merges.map((range) => XLSX.utils.decode_range(range));
  sheet["!cols"] = spec.headers.map((header) => ({ wch: Math.max(12, Math.min(40, String(header).length + 2)) }));
  return sheet;
};

const helpSheet = (data) => XLSX.utils.aoa_to_sheet([
  [`GSTR-1 for ${data.businessName || ""} (${data.gstin || "GSTIN missing"})`],
  [`Tax period: ${data.period.label}`],
  ["Generated by BillStack from issued invoices and credit notes."],
  [],
  ["Help Instructions"],
  ["1. The offline tool for generating the JSON file will not take the data available in the sheets exemp and docs."],
  ["2. The values in these sheets are in the same order as in the portal."],
  ["3. You can manually enter the data from these sheets directly into the GSTN portal."],
]);

const buildGstr1Workbook = (data) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, helpSheet(data), "Help Instruction");
  SHEETS.forEach((spec) => XLSX.utils.book_append_sheet(workbook, buildSheet(spec, data), spec.name));
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellDates: true });
};

module.exports = { buildGstr1Workbook, SHEETS };
