const test = require("node:test");
const assert = require("node:assert/strict");
const Business = require("../src/models/Business");
const Invoice = require("../src/models/Invoice");
const CreditNote = require("../src/models/CreditNote");
const { buildGstr1, parseMonth, parsePeriod, posLabel } = require("../src/services/gstr1.service");
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
  assert.equal(parsePeriod({ from: "2026-10-01", to: "2026-12-31" }).title, "Q3 FY 2026-27 (Oct 2026 – Dec 2026)");
  assert.equal(parsePeriod({ from: "2026-04-01", to: "2026-09-30" }).label, "H1_FY2026-27");
  assert.equal(parsePeriod({ from: "2026-04-01", to: "2027-03-31" }).type, "year");
  assert.equal(parsePeriod({ from: "2026-10-05", to: "2026-10-20" }).title, "05-10-2026 to 20-10-2026");
  assert.equal(parsePeriod({ from: "2026-10-01", to: "2026-10-31" }).label, "OCT-2026");
  assert.throws(() => parsePeriod({ from: "2026-10-20", to: "2026-10-05" }));
  assert.throws(() => parsePeriod({ from: "2025-01-01", to: "2026-10-05" }));
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

  // Every issued invoice is in the register with the GSTR-1 table it belongs to.
  assert.deepEqual(data.register.map((r) => [r.invoiceNumber, r.table]), [["TOOR/0901", "4A"], ["TOOR/0902", "4A"], ["TOOR/0903", "7"], ["TOOR/0904", "5"]]);

  const report = new ExcelJS.Workbook();
  await report.xlsx.load(await buildGstr1Report(data));
  // No credit notes / nil-rated supplies this month, so those sheets are left out.
  assert.deepEqual(report.worksheets.map((ws) => ws.name), ["Summary", "Invoices", "HSN-SAC"]);
  const invoices = report.getWorksheet("Invoices");
  assert.equal(invoices.getCell("C5").value, "GSTIN of Recipient");
  assert.equal(invoices.getCell("C6").value, "27AAACR5055K1Z5");
  assert.equal(invoices.getCell("A10").value, "Total – 4 invoices");
  assert.equal(invoices.getCell("J10").value, 232000);
  const summary = report.getWorksheet("Summary");
  assert.equal(summary.getCell("B10").value, "Net tax liability");
  assert.equal(summary.getCell("D10").value, 232000);
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

test("GSTR-1: invoices issued while GST was off are rebuilt from their lines", async () => {
  const old = (number, gstin, stateCode) => ({
    invoiceNumber: number, invoiceDate: new Date("2026-10-05T06:00:00Z"), status: "issued", grandTotal: 11800, gstSnapshot: null,
    customerDetails: { gstNumber: gstin, name: "Client" }, customerId: { gstNumber: gstin, stateCode },
    lineItems: [{ productName: "Cabin", hsnSac: "9985", quantity: 1, rate: 10000, taxRate: 18, taxableAmount: 10000, tax: 1800, itemTotal: 11800 }],
  });
  const noSac = old("INV-3", "", "");
  noSac.lineItems[0].hsnSac = "";
  stub([old("INV-1", "27AAACR5055K1Z5", ""), old("INV-2", "", "23"), noSac]);
  const data = await buildGstr1({ businessId: "507f1f77bcf86cd799439011", month: "2026-10" });
  assert.equal(data.b2b.length, 1);
  assert.equal(data.b2b[0].igst, 1800);
  assert.equal(data.b2cs[0].taxableValue, 20000);
  assert.equal(data.b2cs[0].cgst, 1800);
  assert.equal(data.issues.filter((i) => i.level === "error").length, 0);
  assert.ok(data.issues.some((i) => /GST was off/.test(i.message) && /INV-1, INV-2, INV-3/.test(i.message)));
  assert.ok(data.issues.some((i) => /INV-3/.test(i.message) && /place of supply/.test(i.message) && !/INV-2/.test(i.message)));
  // Missing SAC falls back to the code printed on the invoice (9985 for a cabin).
  assert.ok(data.issues.some((i) => /SAC was not saved/.test(i.message) && /INV-3/.test(i.message) && /9985/.test(i.message)));
  assert.equal(data.hsnB2C[0].hsn, "9985");
});

test("GSTR-1: register lists every issued invoice, including ₹0 and nil-rated ones", async () => {
  const zero = invoice("TOOR/0950", { gstin: "27AAACR5055K1Z5", pos: "27", taxable: 0 });
  const nil = invoice("TOOR/0952", { pos: "23", taxable: 30000 });
  nil.gstSnapshot.lines = [{ taxableValue: 30000, rate: 0, hsnSac: "9985", gstClassification: "TAXABLE", igst: 0, cgst: 0, sgst: 0 }];
  stub([zero, invoice("TOOR/0951", { gstin: "27AAACR5055K1Z5", pos: "27", taxable: 1000 }), nil]);
  const data = await buildGstr1({ businessId: "507f1f77bcf86cd799439011", month: "2026-09" });
  assert.deepEqual(data.register.map((r) => [r.invoiceNumber, r.table]), [["TOOR/0950", "4A"], ["TOOR/0951", "4A"], ["TOOR/0952", "8"]]);
  assert.equal(new Set(data.register.map((r) => r.invoiceNumber)).size, data.docs[0].total - data.docs[0].cancelled);
  assert.equal(data.exemp.intraUnregistered.nil, 30000);

  const report = new ExcelJS.Workbook();
  await report.xlsx.load(await buildGstr1Report(data));
  assert.equal(report.getWorksheet("Invoices").getCell("A9").value, "Total – 3 invoices");
});
