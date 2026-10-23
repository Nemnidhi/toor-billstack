const test = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const Business = require("../src/models/Business");
const Invoice = require("../src/models/Invoice");
const CreditNote = require("../src/models/CreditNote");
const { buildGstr1, parseMonth, posLabel } = require("../src/services/gstr1.service");
const { buildGstr1Workbook } = require("../src/utils/gstr1-excel");
const { buildGstr1Report } = require("../src/utils/gstr1-report");
const ExcelJS = require("exceljs");
const { resolveItemHsnSac } = require("../src/utils/pdfInvoice");

const chain = (rows) => { const c = { populate: () => c, sort: () => c, select: () => c, lean: async () => rows }; return c; };
const line = (taxable, intra, hsnSac = "9985") => {
  const tax = Math.round(taxable * 18) / 100;
  return { taxableValue: taxable, rate: 18, hsnSac, gstClassification: "TAXABLE", igst: intra ? 0 : tax, cgst: intra ? tax / 2 : 0, sgst: intra ? tax / 2 : 0, utgst: 0 };
};
const invoice = (number, { gstin = "", pos = "23", taxable = 10000, status = "issued", hsnSac = "9985" } = {}) => ({
  invoiceNumber: number, invoiceDate: new Date("2026-09-10T06:00:00Z"), status, grandTotal: Math.round(taxable * 118) / 100,
  customerDetails: { gstNumber: gstin, name: gstin ? "Acme Pvt Ltd" : "Walk-in" }, customerId: { gstNumber: gstin },
  lineItems: [{ hsnSac, quantity: 1, itemTotal: Math.round(taxable * 118) / 100 }],
  gstSnapshot: status === "cancelled" ? undefined : { placeOfSupplyCode: pos, lines: [line(taxable, pos === "23", hsnSac)] },
});

const stub = (invoices, creditNotes = [], gstEnabled = true) => {
  Business.findById = () => ({ lean: async () => ({ _id: "b", name: "THE OFFICE ON RENT", gstConfiguration: { enabled: gstEnabled, gstin: "23AECPT3239G1ZN", stateCode: "23" } }) });
  Invoice.find = () => chain(invoices);
  CreditNote.find = () => chain(creditNotes);
};

test("GSTR-1: month parsing and place-of-supply labels", () => {
  assert.equal(parseMonth("2026-09").label, "SEP-2026");
  assert.throws(() => parseMonth("2026-13"));
  assert.equal(posLabel("23"), "23-Madhya Pradesh");
});

test("GSTR-1: invoices are split into B2B, B2CS and B2CL with HSN and document summary", async () => {
  stub([
    invoice("TOOR/0901", { gstin: "27AAACR5055K1Z5", pos: "27", taxable: 50000 }),
    invoice("TOOR/0902", { gstin: "23ABCDE1234F1Z5", pos: "23", taxable: 20000 }),
    invoice("TOOR/0903", { pos: "23", taxable: 12000 }),
    invoice("TOOR/0904", { pos: "27", taxable: 150000 }),
    invoice("TOOR/0905", { status: "cancelled" }),
  ]);
  const data = await buildGstr1({ businessId: "507f1f77bcf86cd799439011", month: "2026-09" });
  assert.equal(data.fileName, "23AECPT3239G1ZN_GSTR1_SEP-2026.xlsx");
  assert.deepEqual(data.b2b.map((r) => r.invoiceNumber), ["TOOR/0901", "TOOR/0902"]);
  assert.equal(data.b2b[0].pos, "27-Maharashtra");
  assert.equal(data.b2cl.length, 1);
  assert.equal(data.b2cl[0].invoiceNumber, "TOOR/0904");
  assert.equal(data.b2cs.length, 1);
  assert.equal(data.b2cs[0].taxableValue, 12000);
  assert.equal(data.hsnB2B[0].hsn, "9985");
  assert.equal(data.hsnB2B[0].taxableValue, 70000);
  assert.equal(data.hsnB2C[0].taxableValue, 162000);
  assert.equal(data.docs[0].from, "TOOR/0901");
  assert.equal(data.docs[0].to, "TOOR/0905");
  assert.equal(data.docs[0].total, 5);
  assert.equal(data.docs[0].cancelled, 1);
  assert.equal(data.issues.filter((i) => i.level === "error").length, 0);

  const workbook = XLSX.read(buildGstr1Workbook(data), { type: "buffer" });
  assert.equal(workbook.SheetNames[0], "Help Instruction");
  assert.equal(workbook.SheetNames[1], "b2b,sez,de");
  assert.equal(workbook.SheetNames.length, 21);
  const b2b = XLSX.utils.sheet_to_json(workbook.Sheets["b2b,sez,de"], { header: 1, defval: null });
  assert.equal(b2b[3][0], "GSTIN/UIN of Recipient");
  assert.equal(b2b[4][0], "27AAACR5055K1Z5");
  assert.equal(b2b[4][11], 50000);

  // Formatted report: summary first, then one sheet per GSTR-1 table, with totals.
  const report = new ExcelJS.Workbook();
  await report.xlsx.load(await buildGstr1Report(data));
  assert.deepEqual(report.worksheets.map((ws) => ws.name), ["Summary", "4A B2B", "5 B2CL", "7 B2CS", "9B CDNR", "9B CDNUR", "8 Nil-Exempt", "12 HSN B2B", "12 HSN B2C", "13 Documents"]);
  const sheet = report.getWorksheet("4A B2B");
  assert.equal(sheet.getCell("B5").value, "GSTIN/UIN of Recipient");
  assert.equal(sheet.getCell("B6").value, "27AAACR5055K1Z5");
  assert.equal(sheet.getCell("A8").value, "Total");
  assert.equal(sheet.getCell("K8").value, 70000);
  assert.equal(sheet.getCell("L8").value, 9000);
  const summary = report.getWorksheet("Summary");
  assert.equal(summary.getCell("D12").value, 232000);
  assert.equal(data.hsnB2B[0].description, "Support services");
});

test("GSTR-1: missing SAC and GST-disabled businesses are reported", async () => {
  stub([invoice("TOOR/0910", { gstin: "23ABCDE1234F1Z5", hsnSac: "" })]);
  const data = await buildGstr1({ businessId: "507f1f77bcf86cd799439011", month: "2026-09" });
  assert.ok(data.issues.some((i) => /SAC|HSN/i.test(i.message)));
  stub([], [], false);
  await assert.rejects(() => buildGstr1({ businessId: "507f1f77bcf86cd799439011", month: "2026-09" }));
});

test("SAC default: office and coworking services use 9985", () => {
  assert.equal(resolveItemHsnSac({ productName: "Coworking Space Rental" }), "9985");
  assert.equal(resolveItemHsnSac({ productName: "Private Cabin" }), "9985");
  assert.equal(resolveItemHsnSac({ productName: "Virtual Office" }), "9985");
  assert.equal(resolveItemHsnSac({ productName: "Coworking", hsnSac: "997212" }), "997212");
});
