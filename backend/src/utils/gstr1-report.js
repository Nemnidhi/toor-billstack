const ExcelJS = require("exceljs");

/**
 * GSTR-1 workbook for the accountant / CA: one formatted sheet per GSTR-1 table
 * (standard portal table numbers and column names), a summary of tax liability on
 * the first sheet, totals on every sheet, and print-ready page setup.
 */

const COLORS = {
  brand: "1F3A5F",
  brandSoft: "E8EEF6",
  header: "24476B",
  zebra: "F7F9FC",
  border: "D5DCE6",
  total: "FFF4D6",
  muted: "667085",
  red: "B42318",
  amber: "B54708",
};
const MONEY = '#,##0.00;[Red]-#,##0.00;"-"';
const DATE = "dd-mm-yyyy";
const RATE = '0.##"%"';
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const border = { style: "thin", color: { argb: `FF${COLORS.border}` } };
const allBorders = { top: border, left: border, bottom: border, right: border };
const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: `FF${hex}` } });
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const sum = (rows, key) => round2(rows.reduce((total, row) => total + Number(row[key] || 0), 0));

const periodText = (period) => {
  const [year, month] = String(period.month).split("-").map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
};

// Column helpers: [header, key or getter, width, type]
const money = (header, key, width = 15) => ({ header, key, width, type: "money" });
const text = (header, key, width = 18) => ({ header, key, width, type: "text" });
const date = (header, key) => ({ header, key, width: 13, type: "date" });
const rate = (header = "Rate", key = "rate") => ({ header, key, width: 8, type: "rate" });
const count = (header, key, width = 12) => ({ header, key, width, type: "count" });
const TAX = [money("Integrated Tax (IGST)", "igst"), money("Central Tax (CGST)", "cgst"), money("State/UT Tax (SGST)", "sgst"), money("Cess", "cess", 10)];

const SECTIONS = [
  {
    key: "b2b", sheet: "4A B2B", table: "4A, 4B, 6B, 6C",
    title: "B2B Invoices – supplies to registered persons",
    columns: [text("GSTIN/UIN of Recipient", "gstin", 19), text("Receiver Name", "name", 30), text("Invoice Number", "invoiceNumber", 15), date("Invoice Date", "invoiceDate"), money("Invoice Value", "invoiceValue"), text("Place of Supply", "pos", 20), text("Reverse Charge", "reverseCharge", 9), text("Invoice Type", "invoiceType", 13), rate(), money("Taxable Value", "taxableValue"), ...TAX],
    totals: ["taxableValue", "igst", "cgst", "sgst", "cess"], invoiceValueOnce: true,
  },
  {
    key: "b2cl", sheet: "5 B2CL", table: "5A, 5B",
    title: "B2C (Large) – inter-state invoices to unregistered persons above ₹1,00,000",
    columns: [text("Invoice Number", "invoiceNumber", 15), date("Invoice Date", "invoiceDate"), money("Invoice Value", "invoiceValue"), text("Place of Supply", "pos", 20), rate(), money("Taxable Value", "taxableValue"), ...TAX],
    totals: ["taxableValue", "igst", "cgst", "sgst", "cess"], invoiceValueOnce: true,
  },
  {
    key: "b2cs", sheet: "7 B2CS", table: "7",
    title: "B2C (Others) – supplies to unregistered persons, by place of supply and rate",
    columns: [text("Type", "type", 8), text("Place of Supply", "pos", 22), rate(), money("Taxable Value", "taxableValue"), ...TAX],
    totals: ["taxableValue", "igst", "cgst", "sgst", "cess"],
  },
  {
    key: "cdnr", sheet: "9B CDNR", table: "9B",
    title: "Credit / Debit Notes – registered persons",
    columns: [text("GSTIN/UIN of Recipient", "gstin", 19), text("Receiver Name", "name", 28), text("Note Number", "noteNumber", 15), date("Note Date", "noteDate"), text("Note Type", (r) => (r.noteType === "D" ? "Debit" : "Credit"), 9), text("Against Invoice", "invoiceNumber", 15), text("Place of Supply", "pos", 20), money("Note Value", "noteValue"), rate(), money("Taxable Value", "taxableValue"), ...TAX],
    totals: ["taxableValue", "igst", "cgst", "sgst", "cess"],
  },
  {
    key: "cdnur", sheet: "9B CDNUR", table: "9B",
    title: "Credit / Debit Notes – unregistered persons (B2C Large)",
    columns: [text("UR Type", "urType", 9), text("Note Number", "noteNumber", 15), date("Note Date", "noteDate"), text("Note Type", (r) => (r.noteType === "D" ? "Debit" : "Credit"), 9), text("Against Invoice", "invoiceNumber", 15), text("Place of Supply", "pos", 20), money("Note Value", "noteValue"), rate(), money("Taxable Value", "taxableValue"), ...TAX],
    totals: ["taxableValue", "igst", "cgst", "sgst", "cess"],
  },
  {
    key: "exemp", sheet: "8 Nil-Exempt", table: "8A, 8B, 8C, 8D",
    title: "Nil rated, exempted and non-GST outward supplies",
    columns: [text("Description", "description", 46), money("Nil Rated Supplies", "nil", 18), money("Exempted (other than nil rated / non-GST)", "exempt", 22), money("Non-GST Supplies", "nonGst", 18)],
    totals: ["nil", "exempt", "nonGst"], keepEmptyRows: true,
  },
  {
    key: "hsnB2B", sheet: "12 HSN B2B", table: "12 (B2B)",
    title: "HSN/SAC-wise summary of outward supplies – B2B",
    columns: [text("HSN/SAC", "hsn", 11), text("Description", "description", 26), text("UQC", "uqc", 7), count("Total Quantity", "quantity"), money("Total Value", "totalValue"), rate(), money("Taxable Value", "taxableValue"), ...TAX],
    totals: ["totalValue", "taxableValue", "igst", "cgst", "sgst", "cess"],
  },
  {
    key: "hsnB2C", sheet: "12 HSN B2C", table: "12 (B2C)",
    title: "HSN/SAC-wise summary of outward supplies – B2C",
    columns: [text("HSN/SAC", "hsn", 11), text("Description", "description", 26), text("UQC", "uqc", 7), count("Total Quantity", "quantity"), money("Total Value", "totalValue"), rate(), money("Taxable Value", "taxableValue"), ...TAX],
    totals: ["totalValue", "taxableValue", "igst", "cgst", "sgst", "cess"],
  },
  {
    key: "docs", sheet: "13 Documents", table: "13",
    title: "Documents issued during the tax period",
    columns: [text("Nature of Document", "nature", 32), text("Sr. No. From", "from", 16), text("Sr. No. To", "to", 16), count("Total Number", "total"), count("Cancelled", "cancelled"), count("Net Issued", (r) => Number(r.total || 0) - Number(r.cancelled || 0))],
    totals: [],
  },
];

const exempRows = (exemp) => [
  ["Inter-State supplies to registered persons", exemp.interRegistered],
  ["Intra-State supplies to registered persons", exemp.intraRegistered],
  ["Inter-State supplies to unregistered persons", exemp.interUnregistered],
  ["Intra-State supplies to unregistered persons", exemp.intraUnregistered],
].map(([description, v]) => ({ description, nil: v?.nil || 0, exempt: v?.exempt || 0, nonGst: v?.nonGst || 0 }));

const rowsFor = (section, data) => (section.key === "exemp" ? exempRows(data.exemp || {}) : data[section.key] || []);
const valueOf = (column, row) => (typeof column.key === "function" ? column.key(row) : row[column.key]);

// Rows 1-3: company, report name, GSTIN + period. Shared by every sheet.
const writeBand = (ws, data, width, subtitle) => {
  const lastCol = Math.max(width, 6);
  [[data.businessName || "", 15, true, COLORS.brand], [subtitle, 11, true, COLORS.header], [`GSTIN: ${data.gstin || "—"}     |     Tax period: ${periodText(data.period)}     |     Return: GSTR-1`, 10, false, COLORS.muted]]
    .forEach(([value, size, bold, color], index) => {
      const row = ws.getRow(index + 1);
      ws.mergeCells(index + 1, 1, index + 1, lastCol);
      const cell = row.getCell(1);
      cell.value = value;
      cell.font = { name: "Calibri", size, bold, color: { argb: `FF${color}` } };
      cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      row.height = index === 0 ? 24 : 18;
      for (let c = 1; c <= lastCol; c += 1) row.getCell(c).fill = fill(index === 0 ? COLORS.brandSoft : "FFFFFF");
    });
};

const styleHeader = (row) => {
  row.height = 32;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = fill(COLORS.header);
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = allBorders;
  });
};

const formatCell = (cell, type) => {
  cell.border = allBorders;
  cell.font = { size: 10 };
  if (type === "money") { cell.numFmt = MONEY; cell.alignment = { horizontal: "right" }; }
  else if (type === "date") { cell.numFmt = DATE; cell.alignment = { horizontal: "center" }; }
  else if (type === "rate") { cell.numFmt = RATE; cell.alignment = { horizontal: "center" }; }
  else if (type === "count") { cell.numFmt = "#,##0"; cell.alignment = { horizontal: "right" }; }
  else if (type === "sr") { cell.alignment = { horizontal: "center" }; }
  else cell.alignment = { horizontal: "left" };
};

const writeSection = (workbook, section, data) => {
  const columns = [{ header: "Sr.", key: (_r, i) => i + 1, width: 5, type: "sr" }, ...section.columns];
  const ws = workbook.addWorksheet(section.sheet, {
    properties: { tabColor: { argb: `FF${COLORS.header}` } },
    views: [{ state: "frozen", ySplit: 5, xSplit: 0 }],
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: `&L${data.businessName || ""} – GSTR-1 ${periodText(data.period)}&RPage &P of &N` },
  });
  ws.columns = columns.map((c) => ({ width: c.width }));
  writeBand(ws, data, columns.length, `Table ${section.table}: ${section.title}`);

  const header = ws.getRow(5);
  columns.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
  styleHeader(header);
  ws.pageSetup.printTitlesRow = "5:5";

  const rows = rowsFor(section, data);
  let r = 6;
  rows.forEach((row, index) => {
    const excelRow = ws.getRow(r);
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      let value = c.type === "sr" ? index + 1 : valueOf(c, row);
      if (c.key === "cess") value = Number(row.cess || 0);
      if (c.type === "date" && value) value = new Date(value);
      cell.value = value === undefined || value === "" ? null : value;
      formatCell(cell, c.type);
      if (index % 2 === 1) cell.fill = fill(COLORS.zebra);
    });
    r += 1;
  });

  if (!rows.length) {
    ws.mergeCells(r, 1, r, columns.length);
    const cell = ws.getCell(r, 1);
    cell.value = "No records for this tax period";
    cell.font = { italic: true, color: { argb: `FF${COLORS.muted}` }, size: 10 };
    cell.alignment = { horizontal: "center" };
    cell.border = allBorders;
    r += 1;
  } else if (section.totals.length || section.invoiceValueOnce) {
    const totalRow = ws.getRow(r);
    totalRow.getCell(1).value = "Total";
    columns.forEach((c, i) => {
      const cell = totalRow.getCell(i + 1);
      if (section.totals.includes(c.key)) cell.value = sum(rows, c.key);
      // Invoice value counted once per invoice even when an invoice has several tax rates.
      if (section.invoiceValueOnce && c.key === "invoiceValue") {
        const seen = new Map(rows.map((x) => [x.invoiceNumber, x.invoiceValue]));
        cell.value = round2([...seen.values()].reduce((a, b) => a + Number(b || 0), 0));
      }
      formatCell(cell, i === 0 ? "text" : c.type);
      cell.font = { bold: true, size: 10 };
      cell.fill = fill(COLORS.total);
    });
    if (section.invoiceValueOnce) {
      const invoiceCount = new Set(rows.map((x) => x.invoiceNumber)).size;
      totalRow.getCell(2).value = `${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}`;
    }
    totalRow.height = 20;
    r += 1;
  }
  if (rows.length) ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + rows.length, column: columns.length } };
  return ws;
};

const sectionTotals = (rows) => ({ records: rows.length, taxableValue: sum(rows, "taxableValue"), igst: sum(rows, "igst"), cgst: sum(rows, "cgst"), sgst: sum(rows, "sgst"), cess: sum(rows, "cess") });

const writeSummary = (workbook, data) => {
  const ws = workbook.addWorksheet("Summary", {
    properties: { tabColor: { argb: `FF${COLORS.brand}` } },
    views: [{ showGridLines: false }],
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const widths = [9, 34, 13, 17, 16, 16, 16, 11, 17];
  ws.columns = widths.map((width) => ({ width }));
  writeBand(ws, data, widths.length, "GSTR-1 – Details of outward supplies of goods or services");

  const header = ws.getRow(5);
  ["Table", "Section", "Records", "Taxable Value", "IGST", "CGST", "SGST/UTGST", "Cess", "Total Tax"].forEach((h, i) => { header.getCell(i + 1).value = h; });
  styleHeader(header);

  const invoicesIn = (rows) => new Set(rows.map((x) => x.invoiceNumber)).size;
  const lines = [
    ["4A", "B2B Invoices", { ...sectionTotals(data.b2b || []), records: invoicesIn(data.b2b || []) }, 1],
    ["5", "B2C (Large) Invoices", { ...sectionTotals(data.b2cl || []), records: invoicesIn(data.b2cl || []) }, 1],
    ["7", "B2C (Others)", sectionTotals(data.b2cs || []), 1],
    ["9B", "Credit / Debit Notes (Registered)", sectionTotals(data.cdnr || []), -1],
    ["9B", "Credit / Debit Notes (Unregistered)", sectionTotals(data.cdnur || []), -1],
  ];
  const exemp = exempRows(data.exemp || {});
  const exempTotal = round2(sum(exemp, "nil") + sum(exemp, "exempt") + sum(exemp, "nonGst"));

  let r = 6;
  const writeLine = (values, opts = {}) => {
    const row = ws.getRow(r);
    values.forEach((value, i) => {
      const cell = row.getCell(i + 1);
      cell.value = value;
      formatCell(cell, i >= 3 ? "money" : i === 2 ? "count" : i === 0 ? "sr" : "text");
      if (opts.bold) cell.font = { bold: true, size: 10.5 };
      if (opts.fill) cell.fill = fill(opts.fill);
      else if ((r - 6) % 2 === 1) cell.fill = fill(COLORS.zebra);
    });
    row.height = opts.height || 18;
    r += 1;
  };
  lines.forEach(([table, label, t]) => writeLine([table, label, t.records, t.taxableValue, t.igst, t.cgst, t.sgst, t.cess, round2(t.igst + t.cgst + t.sgst + t.cess)]));
  writeLine(["8", "Nil rated / Exempted / Non-GST", exemp.filter((e) => e.nil || e.exempt || e.nonGst).length, exempTotal, 0, 0, 0, 0, 0]);

  // Net liability: supplies minus credit notes.
  const net = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  lines.forEach(([, , t, sign]) => Object.keys(net).forEach((k) => { net[k] = round2(net[k] + sign * t[k]); }));
  writeLine(["", "Net tax liability", "", net.taxableValue, net.igst, net.cgst, net.sgst, net.cess, round2(net.igst + net.cgst + net.sgst + net.cess)], { bold: true, fill: COLORS.total, height: 22 });

  // HSN cross-check and documents.
  r += 1;
  const hsn = [...(data.hsnB2B || []), ...(data.hsnB2C || [])];
  writeLine(["12", "HSN/SAC summary (B2B + B2C)", hsn.length, sum(hsn, "taxableValue"), sum(hsn, "igst"), sum(hsn, "cgst"), sum(hsn, "sgst"), sum(hsn, "cess"), round2(sum(hsn, "igst") + sum(hsn, "cgst") + sum(hsn, "sgst"))]);
  const invoiceDocs = (data.docs || []).find((d) => /invoice/i.test(d.nature));
  const docRow = ws.getRow(r);
  ["13", "Documents issued", invoiceDocs ? `${invoiceDocs.from}  to  ${invoiceDocs.to}   •   ${invoiceDocs.total} issued, ${invoiceDocs.cancelled} cancelled` : "No invoices in this period"].forEach((v, i) => { docRow.getCell(i + 1).value = v; });
  ws.mergeCells(r, 3, r, 9);
  for (let c = 1; c <= 9; c += 1) formatCell(docRow.getCell(c), c === 1 ? "sr" : "text");
  r += 2;

  // Checklist from BillStack so the CA sees anything that needs attention.
  const issues = data.issues || [];
  ws.mergeCells(r, 1, r, 9);
  const head = ws.getCell(r, 1);
  head.value = issues.some((i) => i.level === "error") ? "Points to check before filing" : "Checks";
  head.font = { bold: true, size: 11, color: { argb: `FF${COLORS.brand}` } };
  r += 1;
  const notes = issues.length ? issues : [{ level: "ok", message: "All invoices have GSTIN / place of supply, SAC code and tax split." }];
  notes.forEach((item) => {
    ws.mergeCells(r, 1, r, 9);
    const cell = ws.getCell(r, 1);
    const tag = item.level === "error" ? "Fix" : item.level === "warning" ? "Check" : item.level === "info" ? "Note" : "OK";
    cell.value = `${tag}:  ${item.invoiceNumber ? `${item.invoiceNumber} – ` : ""}${item.message}`;
    cell.font = { size: 10, color: { argb: `FF${item.level === "error" ? COLORS.red : item.level === "warning" ? COLORS.amber : COLORS.muted}` } };
    cell.alignment = { wrapText: true, vertical: "top" };
    ws.getRow(r).height = String(cell.value).length > 120 ? 30 : 16;
    r += 1;
  });
  r += 1;
  ws.mergeCells(r, 1, r, 9);
  const foot = ws.getCell(r, 1);
  foot.value = `Generated by BillStack on ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} from issued invoices and credit notes. Cancelled invoices appear only in Table 13.`;
  foot.font = { italic: true, size: 9, color: { argb: `FF${COLORS.muted}` } };
  return ws;
};

const buildGstr1Report = async (data) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BillStack";
  workbook.created = new Date();
  workbook.title = `GSTR-1 ${periodText(data.period)}`;
  writeSummary(workbook, data);
  SECTIONS.forEach((section) => writeSection(workbook, section, data));
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

module.exports = { buildGstr1Report, SECTIONS };
