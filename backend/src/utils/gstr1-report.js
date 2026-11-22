const ExcelJS = require("exceljs");

/**
 * GSTR-1 workbook for the CA, kept to what is actually needed to file:
 *   Summary      – table-wise totals (4A, 5, 7, 9B, 8), Table 7 by place of supply,
 *                  Table 13 documents and a checklist
 *   Invoices     – every issued invoice in one register, tagged with its GSTR-1 table
 *   HSN-SAC      – Table 12, B2B and B2C
 *   Credit Notes – Table 9B, only when there are any
 *   Nil-Exempt   – Table 8, only when there are any
 */

const COLORS = { brand: "1F3A5F", brandSoft: "E8EEF6", header: "24476B", section: "1F3A5F", zebra: "F7F9FC", border: "D5DCE6", total: "FFF4D6", muted: "667085", red: "B42318", amber: "B54708" };
const MONEY = '#,##0.00;[Red]-#,##0.00;"-"';
const DATE = "dd-mm-yyyy";
const RATE = '0.##"%"';
const TABLE_NAMES = { "4A": "B2B", "5": "B2C Large", "7": "B2C Others", "8": "Nil / Exempt" };

const thin = { style: "thin", color: { argb: `FF${COLORS.border}` } };
const borders = { top: thin, left: thin, bottom: thin, right: thin };
const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: `FF${hex}` } });
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const sum = (rows, key) => round2(rows.reduce((total, row) => total + Number(row[key] || 0), 0));
const periodText = (period) => period.title || period.label || "";

// Column definitions: { header, value(row, index), type, width }
const col = (header, value, type = "text", width = 16) => ({ header, value: typeof value === "function" ? value : (row) => row[value], type, width });
const TAX_COLS = [col("IGST", "igst", "money", 14), col("CGST", "cgst", "money", 14), col("SGST/UTGST", "sgst", "money", 14)];
const TAX_KEYS = ["taxableValue", "igst", "cgst", "sgst"];

const formatCell = (cell, type) => {
  cell.border = borders;
  cell.font = { size: 10 };
  const align = { money: "right", count: "right", date: "center", rate: "center", center: "center" }[type] || "left";
  cell.alignment = { horizontal: align, vertical: "middle" };
  if (type === "money") cell.numFmt = MONEY;
  if (type === "date") cell.numFmt = DATE;
  if (type === "rate") cell.numFmt = RATE;
  if (type === "count") cell.numFmt = "#,##0";
};

const newSheet = (workbook, name, data, subtitle, width, landscape = true) => {
  const ws = workbook.addWorksheet(name, {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: landscape ? "landscape" : "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    headerFooter: { oddFooter: `&L${data.businessName || ""} – GSTR-1 ${periodText(data.period)}&RPage &P of &N` },
  });
  [[data.businessName || "", 15, true, COLORS.brand], [subtitle, 11, true, COLORS.header], [`GSTIN: ${data.gstin || "—"}     |     Tax period: ${periodText(data.period)}     |     Return: GSTR-1`, 10, false, COLORS.muted]]
    .forEach(([value, size, bold, color], i) => {
      ws.mergeCells(i + 1, 1, i + 1, width);
      const cell = ws.getCell(i + 1, 1);
      cell.value = value;
      cell.font = { size, bold, color: { argb: `FF${color}` } };
      cell.alignment = { vertical: "middle", indent: 1 };
      if (i === 0) for (let c = 1; c <= width; c += 1) ws.getCell(1, c).fill = fill(COLORS.brandSoft);
      ws.getRow(i + 1).height = i === 0 ? 24 : 18;
    });
  return ws;
};

const sectionTitle = (ws, row, text, width) => {
  ws.mergeCells(row, 1, row, width);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = { bold: true, size: 11, color: { argb: `FF${COLORS.section}` } };
  ws.getRow(row).height = 20;
  return row + 1;
};

/** Writes header + rows (+ total row) starting at `row`; returns the next free row. */
const writeTable = (ws, row, columns, rows, { totals = [], totalLabel = "Total", empty = "No records for this tax period", totalOverrides = {}, filter = false } = {}) => {
  const header = ws.getRow(row);
  header.height = 30;
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill = fill(COLORS.header);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = borders;
  });
  const headerRow = row;
  row += 1;
  if (!rows.length) {
    ws.mergeCells(row, 1, row, columns.length);
    const cell = ws.getCell(row, 1);
    cell.value = empty;
    cell.font = { italic: true, size: 10, color: { argb: `FF${COLORS.muted}` } };
    cell.alignment = { horizontal: "center" };
    cell.border = borders;
    return row + 1;
  }
  rows.forEach((data, index) => {
    const excelRow = ws.getRow(row);
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      let value = c.value(data, index);
      if (c.type === "date" && value) value = new Date(value);
      cell.value = value === undefined || value === "" ? null : value;
      formatCell(cell, c.type);
      if (index % 2 === 1) cell.fill = fill(COLORS.zebra);
    });
    row += 1;
  });
  if (totals.length || Object.keys(totalOverrides).length) {
    const excelRow = ws.getRow(row);
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      const key = c.key || c.header;
      if (i === 0) cell.value = totalLabel;
      else if (key in totalOverrides) cell.value = totalOverrides[key];
      else if (totals.includes(c.key)) cell.value = sum(rows, c.key);
      formatCell(cell, i === 0 ? "text" : c.type);
      cell.font = { bold: true, size: 10 };
      cell.fill = fill(COLORS.total);
    });
    excelRow.height = 20;
    row += 1;
  }
  if (filter) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + rows.length, column: columns.length } };
  return row;
};
const keyed = (key, c) => ({ ...c, key });

const exempRows = (exemp = {}) => [
  ["Inter-State supplies to registered persons", exemp.interRegistered],
  ["Intra-State supplies to registered persons", exemp.intraRegistered],
  ["Inter-State supplies to unregistered persons", exemp.interUnregistered],
  ["Intra-State supplies to unregistered persons", exemp.intraUnregistered],
].map(([description, v]) => ({ description, nil: v?.nil || 0, exempt: v?.exempt || 0, nonGst: v?.nonGst || 0 }));

const uniqueInvoiceValue = (rows) => round2([...new Map(rows.map((r) => [r.invoiceNumber, r.invoiceValue])).values()].reduce((a, b) => a + Number(b || 0), 0));
const totalsOf = (rows) => Object.fromEntries(TAX_KEYS.map((k) => [k, sum(rows, k)]));

const writeSummary = (workbook, data, exemp) => {
  const width = 8;
  const ws = newSheet(workbook, "Summary", data, "GSTR-1 – Summary of outward supplies", width);
  ws.columns = [10, 34, 12, 18, 16, 16, 16, 17].map((w) => ({ width: w }));
  const register = data.register || [];
  const notes = [...(data.cdnr || []), ...(data.cdnur || [])];
  const exempTotal = round2(sum(exemp, "nil") + sum(exemp, "exempt") + sum(exemp, "nonGst"));

  const lines = [
    { table: "4A", label: "B2B – clients with GSTIN", rows: register.filter((r) => r.table === "4A"), count: "invoices" },
    { table: "5", label: "B2C Large – inter-state, above ₹1 lakh", rows: register.filter((r) => r.table === "5"), count: "invoices" },
    { table: "7", label: "B2C Others – clients without GSTIN", rows: register.filter((r) => r.table === "7"), count: "invoices" },
  ].map((l) => ({ ...l, records: new Set(l.rows.map((r) => r.invoiceNumber)).size, ...totalsOf(l.rows), sign: 1 }));
  if (notes.length) lines.push({ table: "9B", label: "Credit notes (less)", records: new Set(notes.map((n) => n.noteNumber)).size, ...totalsOf(notes), sign: -1 });
  if (exempTotal) lines.push({ table: "8", label: "Nil rated / exempt / non-GST", records: new Set(register.filter((r) => r.table === "8").map((r) => r.invoiceNumber)).size, taxableValue: exempTotal, igst: 0, cgst: 0, sgst: 0, sign: 0 });

  const net = Object.fromEntries(TAX_KEYS.map((k) => [k, round2(lines.reduce((t, l) => t + (l.sign || 0) * l[k], 0))]));
  const columns = [
    col("Table", "table", "center"), col("Section", "label"), col("Records", "records", "count"),
    keyed("taxableValue", col("Taxable Value", (l) => (l.sign < 0 ? -l.taxableValue : l.taxableValue), "money")),
    keyed("igst", col("IGST", (l) => (l.sign < 0 ? -l.igst : l.igst), "money")),
    keyed("cgst", col("CGST", (l) => (l.sign < 0 ? -l.cgst : l.cgst), "money")),
    keyed("sgst", col("SGST/UTGST", (l) => (l.sign < 0 ? -l.sgst : l.sgst), "money")),
    keyed("tax", col("Total Tax", (l) => (l.sign < 0 ? -1 : 1) * round2(l.igst + l.cgst + l.sgst), "money")),
  ];
  let row = sectionTitle(ws, 5, "Tax liability by GSTR-1 table", width);
  row = writeTable(ws, row, columns, lines, { totalLabel: "", totalOverrides: { Section: "Net tax liability", ...net, tax: round2(net.igst + net.cgst + net.sgst) } });

  // Table 7 is filed by place of supply and rate.
  if ((data.b2cs || []).length) {
    row = sectionTitle(ws, row + 1, "Table 7 – B2C Others by place of supply", width);
    row = writeTable(ws, row, [col("Rate", "rate", "rate"), col("Place of Supply", "pos"), col("Type", "type", "center"), keyed("taxableValue", col("Taxable Value", "taxableValue", "money")), keyed("igst", TAX_COLS[0]), keyed("cgst", TAX_COLS[1]), keyed("sgst", TAX_COLS[2])], data.b2cs, { totals: TAX_KEYS });
  }

  // Table 13.
  row = sectionTitle(ws, row + 1, "Table 13 – Documents issued", width);
  row = writeTable(ws, row, [col("Sr.", (_r, i) => i + 1, "center"), col("Nature of Document", "nature"), col("From", "from", "center"), col("To", "to", "center"), col("Total Number", "total", "count"), col("Cancelled", "cancelled", "count"), col("Net Issued", (r) => r.total - r.cancelled, "count")], data.docs || [], { empty: "No documents issued in this period" });

  // Checklist.
  row = sectionTitle(ws, row + 1, "Checks", width);
  const issues = (data.issues || []).length ? data.issues : [{ level: "ok", message: "All invoices have GSTIN / place of supply, SAC code and tax split." }];
  issues.forEach((item) => {
    ws.mergeCells(row, 1, row, width);
    const cell = ws.getCell(row, 1);
    const tag = { error: "Fix", warning: "Check", info: "Note" }[item.level] || "OK";
    cell.value = `${tag}:  ${item.invoiceNumber ? `${item.invoiceNumber} – ` : ""}${item.message}`;
    cell.font = { size: 10, color: { argb: `FF${item.level === "error" ? COLORS.red : item.level === "warning" ? COLORS.amber : COLORS.muted}` } };
    cell.alignment = { wrapText: true, vertical: "top" };
    ws.getRow(row).height = String(cell.value).length > 120 ? 30 : 16;
    row += 1;
  });
  ws.mergeCells(row + 1, 1, row + 1, width);
  const foot = ws.getCell(row + 1, 1);
  foot.value = `Generated by BillStack on ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} from issued invoices and credit notes. Cancelled invoices are counted only in Table 13.`;
  foot.font = { italic: true, size: 9, color: { argb: `FF${COLORS.muted}` } };
};

const writeInvoices = (workbook, data) => {
  const rows = data.register || [];
  const columns = [
    col("Sr.", (_r, i) => i + 1, "center", 5), col("GSTR-1 Table", (r) => `${r.table} ${TABLE_NAMES[r.table]}`, "text", 13),
    col("GSTIN of Recipient", (r) => r.gstin || "Unregistered", "text", 19), col("Receiver Name", "name", "text", 30),
    col("Invoice No.", "invoiceNumber", "text", 14), col("Invoice Date", "invoiceDate", "date", 12),
    keyed("invoiceValue", col("Invoice Value", "invoiceValue", "money", 15)), col("Place of Supply", "pos", "text", 20),
    col("Rate", "rate", "rate", 7), keyed("taxableValue", col("Taxable Value", "taxableValue", "money", 15)),
    keyed("igst", TAX_COLS[0]), keyed("cgst", TAX_COLS[1]), keyed("sgst", TAX_COLS[2]),
  ];
  const ws = newSheet(workbook, "Invoices", data, "Invoice register – every invoice issued in the period, with its GSTR-1 table", columns.length);
  ws.columns = columns.map((c) => ({ width: c.width }));
  ws.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];
  ws.pageSetup.printTitlesRow = "5:5";
  const invoiceCount = new Set(rows.map((r) => r.invoiceNumber)).size;
  writeTable(ws, 5, columns, rows, { totals: TAX_KEYS, totalLabel: `Total – ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}`, totalOverrides: { invoiceValue: uniqueInvoiceValue(rows) }, empty: "No invoices issued in this tax period", filter: true });
};

const writeHsn = (workbook, data) => {
  const rows = [...(data.hsnB2B || []).map((r) => ({ ...r, section: "B2B" })), ...(data.hsnB2C || []).map((r) => ({ ...r, section: "B2C" }))];
  const columns = [
    col("Sr.", (_r, i) => i + 1, "center", 5), col("Section", "section", "center", 9), col("HSN/SAC", "hsn", "center", 10), col("Description", "description", "text", 26),
    col("UQC", "uqc", "center", 7), col("Total Quantity", "quantity", "count", 10), keyed("totalValue", col("Total Value", "totalValue", "money", 15)),
    col("Rate", "rate", "rate", 7), keyed("taxableValue", col("Taxable Value", "taxableValue", "money", 15)),
    keyed("igst", TAX_COLS[0]), keyed("cgst", TAX_COLS[1]), keyed("sgst", TAX_COLS[2]),
  ];
  const ws = newSheet(workbook, "HSN-SAC", data, "Table 12 – HSN/SAC-wise summary (B2B and B2C)", columns.length);
  ws.columns = columns.map((c) => ({ width: c.width }));
  writeTable(ws, 5, columns, rows, { totals: ["totalValue", ...TAX_KEYS], filter: true });
};

const writeCreditNotes = (workbook, data) => {
  const rows = [...(data.cdnr || []).map((r) => ({ ...r, section: "CDNR" })), ...(data.cdnur || []).map((r) => ({ ...r, section: "CDNUR" }))];
  const columns = [
    col("Sr.", (_r, i) => i + 1, "center", 5), col("Section", "section", "center", 9), col("GSTIN of Recipient", (r) => r.gstin || "Unregistered", "text", 19),
    col("Receiver Name", "name", "text", 26), col("Note No.", "noteNumber", "text", 14), col("Note Date", "noteDate", "date", 12),
    col("Against Invoice", "invoiceNumber", "text", 14), col("Place of Supply", "pos", "text", 20), col("Note Value", "noteValue", "money", 14),
    col("Rate", "rate", "rate", 7), keyed("taxableValue", col("Taxable Value", "taxableValue", "money", 15)),
    keyed("igst", TAX_COLS[0]), keyed("cgst", TAX_COLS[1]), keyed("sgst", TAX_COLS[2]),
  ];
  const ws = newSheet(workbook, "Credit Notes", data, "Table 9B – Credit notes", columns.length);
  ws.columns = columns.map((c) => ({ width: c.width }));
  writeTable(ws, 5, columns, rows, { totals: TAX_KEYS, filter: true });
};

const writeExempt = (workbook, data, exemp) => {
  const columns = [col("Description", "description", "text", 46), keyed("nil", col("Nil Rated", "nil", "money", 16)), keyed("exempt", col("Exempted", "exempt", "money", 16)), keyed("nonGst", col("Non-GST", "nonGst", "money", 16))];
  const ws = newSheet(workbook, "Nil-Exempt", data, "Table 8 – Nil rated, exempted and non-GST supplies", columns.length, false);
  ws.columns = columns.map((c) => ({ width: c.width }));
  writeTable(ws, 5, columns, exemp, { totals: ["nil", "exempt", "nonGst"] });
};

const buildGstr1Report = async (data) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "BillStack";
  workbook.created = new Date();
  workbook.title = `GSTR-1 ${periodText(data.period)}`;
  const exemp = exempRows(data.exemp);
  writeSummary(workbook, data, exemp);
  writeInvoices(workbook, data);
  writeHsn(workbook, data);
  if ((data.cdnr || []).length || (data.cdnur || []).length) writeCreditNotes(workbook, data);
  if (exemp.some((e) => e.nil || e.exempt || e.nonGst)) writeExempt(workbook, data, exemp);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

module.exports = { buildGstr1Report };
