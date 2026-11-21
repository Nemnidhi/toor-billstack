// Books phase 2 (21 Nov 2026): TDS. Customers who deduct TDS from what they pay us (TDS
// receivable, 26AS matching, certificates) and TDS we deduct from landlords, contractors,
// professionals and brokers (TDS payable, challans, Form 140 lines, Form 131 register).
// Needs a replica-set MongoDB:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_books_phase2_test?replicaSet=rs0&directConnection=true" node --test tests/books-phase2-tds.test.js
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
const Expense = require("../src/models/Expense");
const JournalEntry = require("../src/models/JournalEntry");
const TdsReceivable = require("../src/models/TdsReceivable");
const accounting = require("../src/services/accounting.service");
const payments = require("../src/services/payment.service");
const expenses = require("../src/services/expense.service");
const tds = require("../src/services/tds.service");
const { createCustomerLedgerEntryOnce } = require("../src/services/ledger.service");

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
  const customer = await Customer.create({ businessId: business._id, name: `Tenant ${uid}`, phone: "9876543210", tan: "BPLA12345B" });
  const landlord = await Supplier.create({ businessId: business._id, supplierName: `Landlord ${uid}`, phone: "9876543212", pan: "ABCPL1234K", tdsKind: "RENT_BUILDING" });
  return { business, user, customer, landlord };
};

const balance = async (businessId, code) => {
  const entries = await JournalEntry.find({ businessId });
  let net = 0;
  for (const entry of entries) for (const line of entry.lines) if (line.accountCode === code) net += line.debitMinor - line.creditMinor;
  return net;
};

const invoiceOf = async ({ business, customer, total = 11800 }) => {
  const invoice = await Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber: `INV-${crypto.randomBytes(3).toString("hex")}`,
    invoiceDate: new Date("2026-10-01T00:00:00Z"),
    dueDate: new Date("2026-10-01T00:00:00Z"),
    customerDetails: { name: customer.name },
    businessDetails: { name: business.name },
    lineItems: [{ productName: "Cabin rent October", quantity: 1, rate: 10000, taxRate: 18, taxableAmount: 10000, taxAmount: 1800, tax: 1800, itemTotal: total }],
    subtotal: 10000,
    totalTax: 1800,
    gstBreakup: { cgst: 900, sgst: 900, igst: 0, taxableValue: 10000 },
    grandTotal: total,
    amountPaid: 0,
    balanceDue: total,
    paymentStatus: "unpaid",
    status: "issued",
    createdBy: new mongoose.Types.ObjectId(),
  });
  await createCustomerLedgerEntryOnce({ businessId: business._id, customerId: customer._id, eventType: "INVOICE", amount: invoice.grandTotal, direction: "DEBIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:DEBIT`, createdBy: invoice.createdBy });
  await accounting.postInvoiceJournalEntry({ invoice, business, userId: invoice.createdBy });
  return invoice;
};

test("a customer who deducts TDS settles the invoice with money plus TDS; the TDS waits as a receivable", async () => {
  const { business, user, customer } = await setup();
  const invoice = await invoiceOf({ business, customer });
  // 10% TDS on the rent before GST: the tenant pays 10,800 and deducts 1,000
  const payment = await payments.createPayment({ businessId: business._id, userId: user._id, payload: { direction: "RECEIVED", customerId: customer._id, amount: 10800, tdsAmount: 1000, tdsKind: "RENT_BUILDING", paymentMethod: "BANK_TRANSFER", paymentDate: "2026-10-12" } });
  assert.equal(await balance(business._id, "1020"), 1080000);
  assert.equal(await balance(business._id, "1410"), 100000);
  assert.equal(await balance(business._id, "2100"), -1180000);

  await payments.allocatePayment({ businessId: business._id, userId: user._id, paymentId: payment._id, payload: { invoiceId: invoice._id, allocatedAmount: 11800 } });
  const paid = await Invoice.findById(invoice._id);
  assert.equal(paid.balanceDue, 0);
  assert.equal(await balance(business._id, "1100"), 0);
  assert.equal(await balance(business._id, "2100"), 0);

  const register = await tds.receivableRegister({ businessId: business._id, fy: "2026-27" });
  assert.equal(register.rows.length, 1);
  assert.equal(register.rows[0].quarter, "Q3");
  assert.equal(register.rows[0].deductorTan, "BPLA12345B");
  assert.equal(register.summary.deducted, 1000);
  assert.equal(register.summary.certificatesPending, 1);

  await tds.updateReceivable({ businessId: business._id, id: register.rows[0]._id, certificateNumber: "ABCD123" });
  const after = await tds.receivableRegister({ businessId: business._id, fy: "2026-27" });
  assert.equal(after.summary.certificatesReceived, 1);
  assert.ok(after.rows[0].certificateReceivedAt);
});

test("reversing a receipt with TDS takes the TDS receivable back too", async () => {
  const { business, user, customer } = await setup();
  const payment = await payments.createPayment({ businessId: business._id, userId: user._id, payload: { direction: "RECEIVED", customerId: customer._id, amount: 9000, tdsAmount: 1000, tdsKind: "PROFESSIONAL", paymentMethod: "BANK_TRANSFER", paymentDate: "2026-10-12" } });
  await payments.reversePayment({ businessId: business._id, userId: user._id, paymentId: payment._id, reason: "bounced" });
  assert.equal(await balance(business._id, "1020"), 0);
  assert.equal(await balance(business._id, "1410"), 0);
  assert.equal(await balance(business._id, "2100"), 0);
  const row = await TdsReceivable.findOne({ paymentId: payment._id });
  assert.equal(row.status, "REVERSED");
});

test("a landlord's rent bill keeps back 10% TDS: the landlord is owed the rest and TDS payable holds it", async () => {
  const { business, user, landlord } = await setup();
  const bill = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 60000, paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2026-10-03" } });
  assert.equal(bill.tdsKind, "RENT_BUILDING");
  assert.equal(bill.tdsRate, 10);
  assert.equal(bill.tdsAmount, 6000);
  assert.equal(bill.paidAmount, 54000);
  assert.equal(bill.paymentStatus, "PAID");
  assert.equal(await balance(business._id, "5020"), 6000000);
  assert.equal(await balance(business._id, "2310"), -600000);
  assert.equal(await balance(business._id, "1020"), -5400000);

  // a payee without PAN: at least 20%
  const noPan = await Supplier.create({ businessId: business._id, supplierName: "Contractor no PAN", tdsKind: "CONTRACTOR_OTHER" });
  const contract = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Repairs & Maintenance", supplierId: noPan._id, amountBeforeTax: 40000, expenseDate: "2026-10-05" } });
  assert.equal(contract.tdsRate, 20);
  assert.equal(contract.tdsAmount, 8000);
  assert.equal(contract.balanceAmount, 32000);
  assert.equal(contract.paymentStatus, "UNPAID");

  // the amount can be typed in, and TDS can be switched off on a bill
  const typed = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 60000, tdsAmount: 5999, expenseDate: "2026-10-06" } });
  assert.equal(typed.tdsAmount, 5999);
  const none = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 10000, tdsKind: "", expenseDate: "2026-10-07" } });
  assert.equal(none.tdsAmount, 0);

  // editing the bill moves the TDS with it
  await expenses.updateExpense({ businessId: business._id, userId: user._id, expenseId: bill._id, payload: { amountBeforeTax: 70000, paymentStatus: "PARTIAL" } });
  const edited = await Expense.findById(bill._id);
  assert.equal(edited.tdsAmount, 7000);
  assert.equal(edited.paidAmount, 54000);
  assert.equal(edited.paymentStatus, "PARTIAL");
});

test("a challan deposits the TDS: TDS payable clears, interest is an expense, and the bills are locked to it until it is cancelled", async () => {
  const { business, user, landlord } = await setup();
  const bill = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 60000, paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2026-10-03" } });
  await assert.rejects(tds.recordChallan({ businessId: business._id, userId: user._id, payload: { challanDate: "2026-11-09", expenseIds: [bill._id], taxAmount: 5000 } }), /6000/);
  const challan = await tds.recordChallan({ businessId: business._id, userId: user._id, payload: { challanDate: "2026-11-09", expenseIds: [bill._id], interestAmount: 90, bsrCode: "0510308", challanSerial: "12345" } });
  assert.equal(challan.taxAmount, 6000);
  assert.equal(challan.period, "2026-10");
  assert.equal(await balance(business._id, "2310"), 0);
  assert.equal(await balance(business._id, "5180"), 9000);
  assert.equal(await balance(business._id, "1020"), -5400000 - 609000);

  await assert.rejects(expenses.updateExpense({ businessId: business._id, userId: user._id, expenseId: bill._id, payload: { amountBeforeTax: 70000 } }), /challan/);
  await assert.rejects(expenses.cancelExpense({ businessId: business._id, userId: user._id, expenseId: bill._id, reason: "x" }), /challan/);
  await assert.rejects(tds.recordChallan({ businessId: business._id, userId: user._id, payload: { challanDate: "2026-11-09", expenseIds: [bill._id] } }), /already/);

  const register = await tds.payableRegister({ businessId: business._id, fy: "2026-27", now: new Date("2026-11-20") });
  assert.equal(register.months[0].deposited, 6000);
  assert.equal(register.months[0].overdue, false);

  await tds.cancelChallan({ businessId: business._id, userId: user._id, id: challan._id, reason: "wrong BSR" });
  assert.equal(await balance(business._id, "2310"), -600000);
  assert.equal(await balance(business._id, "5180"), 0);
  assert.equal((await Expense.findById(bill._id)).tdsChallanId, null);
  const late = await tds.payableRegister({ businessId: business._id, fy: "2026-27", now: new Date("2026-11-20") });
  assert.equal(late.months[0].pending, 6000);
  assert.equal(late.months[0].overdue, true);
});

test("Form 140 lines, the Form 131 register and the limit watch", async () => {
  const { business, user, landlord } = await setup();
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 60000, paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2026-10-03" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 60000, paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2026-11-03" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 60000, expenseDate: "2026-07-03" } }); // Q2
  const { csv, rows } = await tds.form140Csv({ businessId: business._id, fy: "2026-27", quarter: "Q3" });
  assert.equal(rows, 2);
  assert.match(csv, /194-I\(b\)/);
  assert.match(csv, /ABCPL1234K/);
  const certificates = await tds.form131Register({ businessId: business._id, fy: "2026-27", quarter: "Q3" });
  assert.equal(certificates.length, 1);
  assert.equal(certificates[0].tdsDeducted, 12000);
  assert.equal(certificates[0].allDeposited, false);

  // a contractor marked for TDS whose bills crossed the yearly limit with no TDS taken
  const contractor = await Supplier.create({ businessId: business._id, supplierName: "Painter", pan: "ABCPP1234K", tdsKind: "CONTRACTOR_INDIVIDUAL" });
  for (const day of ["2026-06-01", "2026-08-01", "2026-10-01", "2026-11-01"]) {
    await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Repairs & Maintenance", supplierId: contractor._id, amountBeforeTax: 28000, tdsKind: "", expenseDate: day } });
  }
  const watch = await tds.limitWatch({ businessId: business._id, fy: "2026-27" });
  assert.equal(watch.length, 1);
  assert.equal(watch[0].supplierName, "Painter");
  assert.match(watch[0].reasons[0], /yearly limit/);
});

test("26AS import is read and matched by deductor TAN and quarter", async () => {
  const { business, user, customer } = await setup();
  await payments.createPayment({ businessId: business._id, userId: user._id, payload: { direction: "RECEIVED", customerId: customer._id, amount: 10800, tdsAmount: 1000, tdsKind: "RENT_BUILDING", paymentMethod: "BANK_TRANSFER", paymentDate: "2026-10-12" } });
  await payments.createPayment({ businessId: business._id, userId: user._id, payload: { direction: "RECEIVED", customerId: customer._id, amount: 10800, tdsAmount: 1000, tdsKind: "RENT_BUILDING", paymentMethod: "BANK_TRANSFER", paymentDate: "2026-07-12" } });
  // the 26AS layout: a deductor line, then its credit lines
  const csvText = [
    "Part-I - Details of Tax Deducted at Source",
    "Sr. No.,Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid / Credited,Tax Deducted,TDS Deposited",
    `1,${customer.name},BPLA12345B,,,20000,2000,2000`,
    ",,,194I,12-Oct-2026,10000,1000,1000",
    "2,Other Co,DELO99999Z,,,5000,500,500",
    ",,,194J,15-Nov-2026,5000,500,500",
  ].join("\n");
  const imported = await tds.import26as({ businessId: business._id, userId: user._id, fy: "2026-27", csvText, fileName: "26as.csv" });
  assert.equal(imported.rows, 2);
  const match = await tds.match26as({ businessId: business._id, fy: "2026-27" });
  const byKey = Object.fromEntries(match.rows.map((r) => [`${r.deductorTan}|${r.quarter}`, r.status]));
  assert.equal(byKey["BPLA12345B|Q3"], "MATCHED");
  assert.equal(byKey["BPLA12345B|Q2"], "MISSING_IN_26AS");
  assert.equal(byKey["DELO99999Z|Q3"], "NOT_IN_BOOKS");
  const register = await tds.receivableRegister({ businessId: business._id, fy: "2026-27" });
  assert.deepEqual(register.rows.map((r) => r.in26as).sort(), ["MATCHED", "MISSING_IN_26AS"]);
});
