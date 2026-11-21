// Books phase 3 (21 Nov 2026): GST on the buying side. Reverse charge on rent from an unregistered
// landlord (self-invoice, payment voucher, tax payable and the same as credit), blocked credit,
// the input-credit register, GSTR-2B import and match with IMS decisions, GSTR-3B tables with the
// credit set-off, and the GSTR-1 JSON.
// Needs a replica-set MongoDB:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_books_phase3_test?replicaSet=rs0&directConnection=true" node --test tests/books-phase3-gst.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Supplier = require("../src/models/Supplier");
const Invoice = require("../src/models/Invoice");
const JournalEntry = require("../src/models/JournalEntry");
const expenses = require("../src/services/expense.service");
const gstIn = require("../src/services/gst-input.service");

const MONGO_URI = process.env.TEST_MONGO_URI;

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const setup = async () => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `TOOR ${uid}`,
    slug: `toor-${uid}`,
    deploymentMode: "SELF_HOSTED",
    billingEntityCode: "",
    gstTaxId: "23CGZPB7175E1Z5",
    gstConfiguration: { enabled: true, gstin: "23CGZPB7175E1Z5", stateCode: "23" },
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const user = await User.create({ businessId: business._id, name: `U ${uid}`, email: `u-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  const landlord = await Supplier.create({ businessId: business._id, supplierName: `Landlord ${uid}`, phone: "9876543212" }); // unregistered
  const vendor = await Supplier.create({ businessId: business._id, supplierName: `Housekeeping Co ${uid}`, gstNumber: "23AAACH1234K1Z5", stateCode: "23" });
  return { business, user, landlord, vendor };
};

const balance = async (businessId, code) => {
  const entries = await JournalEntry.find({ businessId });
  let net = 0;
  for (const entry of entries) for (const line of entry.lines) if (line.accountCode === code) net += line.debitMinor - line.creditMinor;
  return net;
};

const b2bInvoice = async ({ business, taxable = 10000 }) => {
  const customer = await Customer.create({ businessId: business._id, name: "Tenant Pvt Ltd", phone: "9876500000", gstNumber: "23AABCT1234C1Z5", stateCode: "23" });
  const half = Math.round(taxable * 0.09 * 100) / 100;
  return Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber: `INV-${crypto.randomBytes(3).toString("hex")}`,
    invoiceDate: new Date("2026-10-05T00:00:00Z"),
    dueDate: new Date("2026-10-05T00:00:00Z"),
    customerDetails: { name: customer.name, gstNumber: customer.gstNumber },
    businessDetails: { name: business.name },
    lineItems: [{ productName: "Cabin rent October", hsnSac: "997212", quantity: 1, rate: taxable, taxRate: 18, taxableAmount: taxable, taxAmount: half * 2, tax: half * 2, itemTotal: taxable + half * 2 }],
    subtotal: taxable,
    totalTax: half * 2,
    gstSnapshot: { placeOfSupplyCode: "23", cgst: half, sgst: half, igst: 0, taxableValue: taxable, lines: [{ taxableValue: taxable, rate: 18, cgst: half, sgst: half, igst: 0, hsnSac: "997212" }] },
    gstBreakup: { cgst: half, sgst: half, igst: 0, taxableValue: taxable },
    grandTotal: taxable + half * 2,
    amountPaid: 0,
    balanceDue: taxable + half * 2,
    paymentStatus: "unpaid",
    status: "issued",
    createdBy: new mongoose.Types.ObjectId(),
  });
};

test("rent from an unregistered landlord under reverse charge: self-invoice, GST payable in cash and the same as credit", async () => {
  const { business, user, landlord } = await setup();
  const rent = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 100000, gstType: "REVERSE_CHARGE", paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2026-10-03" } });
  assert.equal(rent.gstType, "REVERSE_CHARGE");
  assert.equal(rent.selfInvoiceNumber, "RCM/26-27/0001");
  assert.equal(rent.taxAmount, 0);
  assert.equal(rent.totalAmount, 100000);
  assert.equal(rent.gstSnapshot.cgst, 9000);
  assert.equal(await balance(business._id, "5020"), 10000000);
  assert.equal(await balance(business._id, "1310"), 900000);
  assert.equal(await balance(business._id, "1320"), 900000);
  assert.equal(await balance(business._id, "2240"), -900000);
  assert.equal(await balance(business._id, "2250"), -900000);
  assert.equal(await balance(business._id, "1020"), -10000000);

  const second = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 50000, gstType: "REVERSE_CHARGE", expenseDate: "2026-11-03" } });
  assert.equal(second.selfInvoiceNumber, "RCM/26-27/0002");

  const docs = await gstIn.rcmDocuments({ businessId: business._id, expenseId: rent._id });
  assert.equal(docs.selfInvoice.number, "RCM/26-27/0001");
  assert.equal(docs.selfInvoice.totalTax, 18000);
  assert.match(docs.selfInvoice.totalInWords, /Eighteen Thousand/);
  assert.equal(docs.paymentVoucher.amountPaid, 100000);
  assert.match(docs.paymentVoucher.amountInWords, /One Lakh/);

  // a company without GST cannot use reverse charge
  const plain = await Business.create({ name: "Goldhawk", slug: `gh-${crypto.randomBytes(4).toString("hex")}`, deploymentMode: "SELF_HOSTED", gstConfiguration: { enabled: false } });
  await assert.rejects(expenses.createExpense({ businessId: plain._id, userId: user._id, payload: { category: "Rent", amountBeforeTax: 1000, gstType: "REVERSE_CHARGE", expenseDate: "2026-10-03" } }), /GST-registered/);
});

test("blocked credit stays in the cost; an eligible bill goes to input credit", async () => {
  const { business, user, vendor } = await setup();
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Office Supplies", supplierId: vendor._id, amountBeforeTax: 10000, gstEnabled: true, gstRate: 18, itcEligible: false, expenseDate: "2026-10-04" } });
  assert.equal(await balance(business._id, "5080"), 1180000);
  assert.equal(await balance(business._id, "1310"), 0);
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Housekeeping & Security", supplierId: vendor._id, amountBeforeTax: 10000, gstEnabled: true, gstRate: 18, supplierInvoiceNumber: "HK/101", expenseDate: "2026-10-04" } });
  assert.equal(await balance(business._id, "1310"), 90000);
  const register = await gstIn.itcRegister({ businessId: business._id, month: "2026-10" });
  assert.equal(register.rows.length, 2);
  assert.equal(register.totals.eligible.cgst, 900);
  assert.equal(register.totals.blocked.cgst, 900);
  assert.equal(register.rows.find((r) => r.supplierInvoiceNumber === "HK/101").supplierGstin, "23AAACH1234K1Z5");
});

const twoB = (vendorGstin) => JSON.stringify({
  data: {
    gstin: "23CGZPB7175E1Z5",
    rtnprd: "102026",
    docdata: {
      b2b: [
        { ctin: vendorGstin, trdnm: "Housekeeping Co", inv: [
          { inum: "HK/0101", dt: "04-10-2026", val: 11800, pos: "23", rev: "N", itcavl: "Y", typ: "R", items: [{ rt: 18, txval: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0 }] },
          { inum: "HK/0102", dt: "06-10-2026", val: 5900, pos: "23", rev: "N", itcavl: "Y", typ: "R", txval: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0 },
        ] },
        { ctin: "27AAACX9999X1Z5", trdnm: "Unknown Co", inv: [{ inum: "X-1", dt: "07-10-2026", val: 1180, pos: "23", rev: "N", itcavl: "Y", typ: "R", txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 }] },
      ],
      cdnr: [],
    },
  },
});

test("GSTR-2B is matched to our bills by supplier GSTIN and bill number; IMS decisions decide the credit and survive a re-import", async () => {
  const { business, user, vendor } = await setup();
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Housekeeping & Security", supplierId: vendor._id, amountBeforeTax: 10000, gstEnabled: true, gstRate: 18, supplierInvoiceNumber: "HK/101", expenseDate: "2026-10-04" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Housekeeping & Security", supplierId: vendor._id, amountBeforeTax: 6000, gstEnabled: true, gstRate: 18, supplierInvoiceNumber: "HK/102", expenseDate: "2026-10-06" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Housekeeping & Security", supplierId: vendor._id, amountBeforeTax: 2000, gstEnabled: true, gstRate: 18, supplierInvoiceNumber: "HK/103", expenseDate: "2026-10-08" } });

  const imported = await gstIn.import2b({ businessId: business._id, userId: user._id, month: "2026-10", jsonText: twoB(vendor.gstNumber), fileName: "2b.json" });
  assert.equal(imported.rows, 3);
  const match = await gstIn.match2b({ businessId: business._id, month: "2026-10" });
  const byNumber = Object.fromEntries(match.statement.map((r) => [r.invoiceNumber, r.status]));
  assert.equal(byNumber["HK/0101"], "MATCHED");
  assert.equal(byNumber["HK/0102"], "VALUE_MISMATCH");
  assert.equal(byNumber["X-1"], "NOT_IN_BOOKS");
  assert.equal(match.books.find((b) => b.supplierInvoiceNumber === "HK/103").status, "NOT_IN_2B");
  assert.equal(match.totals.claimable.cgst, 1350);

  const unknown = match.statement.find((r) => r.invoiceNumber === "X-1");
  await gstIn.setImsAction({ businessId: business._id, month: "2026-10", rowId: unknown._id, action: "REJECTED", note: "not our bill" });
  const after = await gstIn.match2b({ businessId: business._id, month: "2026-10" });
  assert.equal(after.totals.claimable.igst, 0);
  assert.equal(after.totals.rejected.igst, 180);

  await gstIn.import2b({ businessId: business._id, userId: user._id, month: "2026-10", jsonText: twoB(vendor.gstNumber), fileName: "2b-again.json" });
  const again = await gstIn.match2b({ businessId: business._id, month: "2026-10" });
  assert.equal(again.statement.find((r) => r.invoiceNumber === "X-1").imsAction, "REJECTED");

  const register = await gstIn.itcRegister({ businessId: business._id, month: "2026-10" });
  assert.deepEqual(register.rows.map((r) => r.in2b).sort(), ["MATCHED", "NOT_IN_2B", "VALUE_MISMATCH"]);
});

test("GSTR-3B: outward tax, reverse charge, credit from GSTR-2B, set-off and interest", async () => {
  const { business, user, landlord, vendor } = await setup();
  await b2bInvoice({ business, taxable: 100000 }); // CGST 9,000 + SGST 9,000 out
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 50000, gstType: "REVERSE_CHARGE", expenseDate: "2026-10-03" } }); // 4,500 + 4,500 RCM
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Housekeeping & Security", supplierId: vendor._id, amountBeforeTax: 10000, gstEnabled: true, gstRate: 18, supplierInvoiceNumber: "HK/101", expenseDate: "2026-10-04" } });

  const before = await gstIn.gstr3b({ businessId: business._id, month: "2026-10" });
  assert.equal(before.table31.a.taxableValue, 100000);
  assert.equal(before.table31.a.cgst, 9000);
  assert.equal(before.table31.d.cgst, 4500);
  assert.equal(before.table4.a3.cgst, 4500);
  assert.equal(before.table4.a5.source, "books");
  assert.equal(before.table4.a5.cgst, 900);
  assert.ok(before.notes.some((n) => /No GSTR-2B/.test(n)));

  await gstIn.import2b({ businessId: business._id, userId: user._id, month: "2026-10", jsonText: twoB(vendor.gstNumber) });
  const report = await gstIn.gstr3b({ businessId: business._id, month: "2026-10", filingDate: "2026-11-30" });
  assert.equal(report.table4.a5.source, "GSTR-2B");
  // credit: RCM 4,500 + 2B (900 + 450) = 5,850 CGST; IGST 180 from the unknown bill (pending = deemed accepted)
  assert.equal(report.table4.net.cgst, 5850);
  // CGST liability 9,000: IGST credit 180 first, then CGST credit 5,850 -> 2,970 cash; RCM 4,500 always cash
  assert.equal(report.payment.cashFromCredit.cgst, 2970);
  assert.equal(report.payment.cash.cgst, 7470);
  assert.equal(report.payment.cash.sgst, 3150 + 4500);
  assert.equal(report.interest.daysLate, 10);
  assert.equal(report.interest.amount, Math.round(((7470 + 7650) * 0.18 * 10 / 365) * 100) / 100);
});

test("credit set-off follows the law: no CGST against SGST", () => {
  const result = gstIn.setOff({ igst: 0, cgst: 1000, sgst: 1000 }, { igst: 500, cgst: 2000, sgst: 0 });
  assert.equal(result.used.igst.cgst, 500);
  assert.equal(result.cash.cgst, 0);
  assert.equal(result.cash.sgst, 1000);
  assert.equal(result.creditLeft.cgst, 1500);
});

test("GSTR-1 JSON carries B2B invoices by recipient and the HSN summary", async () => {
  const { business } = await setup();
  const invoice = await b2bInvoice({ business, taxable: 10000 });
  const { json, fileName } = await gstIn.gstr1Json({ businessId: business._id, month: "2026-10" });
  assert.equal(json.fp, "102026");
  assert.equal(json.gstin, "23CGZPB7175E1Z5");
  assert.equal(json.b2b[0].ctin, "23AABCT1234C1Z5");
  assert.equal(json.b2b[0].inv[0].inum, invoice.invoiceNumber);
  assert.equal(json.b2b[0].inv[0].pos, "23");
  assert.equal(json.b2b[0].inv[0].itms[0].itm_det.camt, 900);
  assert.equal(json.hsn.hsn_b2b[0].hsn_sc, "997212");
  assert.equal(json.doc_issue.doc_det[0].docs[0].totnum, 1);
  assert.match(fileName, /GSTR1_102026\.json$/);
});

test("GSTR-2B Excel layout: two header rows, B2B lines read", () => {
  const grid = [
    ["Goods and Services Tax - GSTR 2B"],
    [],
    ["GSTIN of supplier", "Trade/Legal name", "Invoice details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "ITC Availability"],
    ["", "", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "", "", "", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", ""],
    ["23AAACH1234K1Z5", "Housekeeping Co", "HK/0101", "Regular", "04/10/2026", "11,800.00", "Madhya Pradesh", "No", "10,000.00", "0", "900.00", "900.00", "0", "Yes"],
  ];
  const rows = gstIn.parse2bGrid(grid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoiceNumber, "HK/0101");
  assert.equal(rows[0].cgst, 900);
  assert.equal(rows[0].taxableValue, 10000);
  assert.equal(rows[0].reverseCharge, false);
  assert.equal(rows[0].itcAvailable, true);
});
