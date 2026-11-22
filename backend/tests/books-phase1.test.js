// Books phase 1 (21 Nov 2026): purchases, supplier / landlord payments, refunds,
// credit notes, sales returns and expense heads reach the journal; expenses edit
// and cancel with it; centres give profit by location; the backfill posts history.
// Needs a replica-set MongoDB, like the phase4-9 tests:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_books_phase1_test?replicaSet=rs0&directConnection=true" node --test tests/books-phase1.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Supplier = require("../src/models/Supplier");
const Product = require("../src/models/Product");
const Invoice = require("../src/models/Invoice");
const Purchase = require("../src/models/Purchase");
const Payment = require("../src/models/Payment");
const Expense = require("../src/models/Expense");
const JournalEntry = require("../src/models/JournalEntry");
const accounting = require("../src/services/accounting.service");
const payments = require("../src/services/payment.service");
const expenses = require("../src/services/expense.service");
const lifecycle = require("../src/services/sales-lifecycle.service");
const reports = require("../src/services/accounting-reports.service");
const { runHistoricalBackfill } = require("../src/services/accounting-backfill.service");
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

const setup = async ({ gst = true } = {}) => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `TOOR ${uid}`,
    slug: `toor-${uid}`,
    deploymentMode: "SELF_HOSTED",
    billingEntityCode: "",
    gstTaxId: gst ? "23CGZPB7175E1Z5" : "",
    gstConfiguration: { enabled: gst, gstin: gst ? "23CGZPB7175E1Z5" : "", stateCode: gst ? "23" : "" },
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const user = await User.create({ businessId: business._id, name: `U ${uid}`, email: `u-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  const customer = await Customer.create({ businessId: business._id, name: `Tenant ${uid}`, phone: "9876543210" });
  const supplier = await Supplier.create({ businessId: business._id, supplierName: `Landlord ${uid}`, phone: "9876543212" });
  const product = await Product.create({ businessId: business._id, name: "Meeting room chairs", trackInventory: true, currentStock: 10 });
  return { business, user, customer, supplier, product };
};

// Net debit minus credit for one account code, optionally only one centre's lines.
const balance = async (businessId, code, centre) => {
  const entries = await JournalEntry.find({ businessId });
  let net = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.accountCode !== code) continue;
      if (centre !== undefined && (line.centre || "") !== centre) continue;
      net += line.debitMinor - line.creditMinor;
    }
  }
  return net;
};

const purchaseDoc = ({ business, supplier, product, gst = true, centre = "" }) =>
  Purchase.create({
    businessId: business._id,
    supplierId: supplier._id,
    productsPurchased: [{ productId: product._id, productName: product.name, quantity: 10, purchasePrice: 100, tax: gst ? 180 : 0, taxRate: gst ? 18 : 0, discount: 0, lineTotal: gst ? 1180 : 1000 }],
    totalAmount: gst ? 1180 : 1000,
    gstSnapshot: gst ? { cgst: 90, sgst: 90, igst: 0, utgst: 0, taxableValue: 1000 } : null,
    gstBreakup: gst ? { cgst: 90, sgst: 90, utgst: 0, igst: 0, taxableValue: 1000, inputTaxCreditEligible: true } : undefined,
    paidAmount: 0,
    paymentStatus: "unpaid",
    purchaseDate: new Date("2026-10-05T00:00:00Z"),
    centre,
    createdBy: new mongoose.Types.ObjectId(),
  });

const gstInvoice = async ({ business, customer, product, centre = "" }) => {
  const invoice = await Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber: `INV-${crypto.randomBytes(3).toString("hex")}`,
    invoiceDate: new Date("2026-10-01T00:00:00Z"),
    dueDate: new Date("2026-10-01T00:00:00Z"),
    customerDetails: { name: customer.name },
    businessDetails: { name: business.name },
    lineItems: [{ productId: product._id, productName: "Meeting room chairs", quantity: 2, rate: 5000, taxRate: 18, taxableAmount: 10000, taxAmount: 1800, tax: 1800, itemTotal: 11800 }],
    subtotal: 10000,
    totalTax: 1800,
    gstBreakup: { cgst: 900, sgst: 900, igst: 0, taxableValue: 10000 },
    grandTotal: 11800,
    amountPaid: 0,
    balanceDue: 11800,
    paymentStatus: "unpaid",
    status: "issued",
    centre,
    createdBy: new mongoose.Types.ObjectId(),
  });
  await createCustomerLedgerEntryOnce({ businessId: business._id, customerId: customer._id, eventType: "INVOICE", amount: invoice.grandTotal, direction: "DEBIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:DEBIT`, createdBy: invoice.createdBy });
  await accounting.postInvoiceJournalEntry({ invoice, business, userId: invoice.createdBy });
  return invoice;
};

test("a purchase bill is a cost plus input GST owed to the supplier; paying, allocating and reversing move the payable and the bank", async () => {
  const { business, user, supplier, product } = await setup();
  const purchase = await purchaseDoc({ business, supplier, product, centre: "Vijay Nagar" });
  await accounting.postPurchaseJournalEntry({ purchase, business, userId: user._id });
  assert.equal(await balance(business._id, "5100", "Vijay Nagar"), 100000, "cost, booked to the centre");
  assert.equal(await balance(business._id, "1310"), 9000, "CGST input credit");
  assert.equal(await balance(business._id, "1320"), 9000, "SGST input credit");
  assert.equal(await balance(business._id, "2010"), -118000, "owed to the supplier");

  const payment = await payments.createPayment({ businessId: business._id, userId: user._id, payload: { direction: "PAID", supplierId: supplier._id, amount: 1180, paymentMethod: "BANK_TRANSFER", paymentDate: "2026-10-10" } });
  assert.equal(await balance(business._id, "1020"), -118000, "money left the bank");
  assert.equal(await balance(business._id, "1150"), 118000, "held as an advance until set against a bill");

  const allocation = await payments.allocatePayment({ businessId: business._id, userId: user._id, paymentId: payment._id, payload: { purchaseId: purchase._id, allocatedAmount: 1180 } });
  assert.equal(await balance(business._id, "2010"), 0, "bill settled");
  assert.equal(await balance(business._id, "1150"), 0);
  assert.equal((await Purchase.findById(purchase._id)).paymentStatus, "paid");

  await payments.reverseAllocation({ businessId: business._id, userId: user._id, allocationId: allocation._id, reason: "wrong bill" });
  const reopened = await Purchase.findById(purchase._id);
  assert.equal(reopened.paidAmount, 0, "the bill is owed again");
  assert.equal(reopened.paymentStatus, "unpaid");
  assert.equal(await balance(business._id, "2010"), -118000);
  assert.equal(await balance(business._id, "1150"), 118000);

  await payments.reversePayment({ businessId: business._id, userId: user._id, paymentId: payment._id, reason: "landlord returned it" });
  assert.equal(await balance(business._id, "1020"), 0, "refund back in the bank");
  assert.equal(await balance(business._id, "1150"), 0);
});

test("a purchase for a business without GST is all cost, no input credit", async () => {
  const { business, user, supplier, product } = await setup({ gst: false });
  const purchase = await purchaseDoc({ business, supplier, product, gst: false });
  await accounting.postPurchaseJournalEntry({ purchase, business, userId: user._id });
  assert.equal(await balance(business._id, "5100"), 100000);
  assert.equal(await balance(business._id, "1310"), 0);
  assert.equal(await balance(business._id, "2010"), -100000);
});

test("a credit note and a sales return take back income and output GST in proportion, on the invoice's centre", async () => {
  const { business, user, customer, product } = await setup();
  const invoice = await gstInvoice({ business, customer, product, centre: "AB Road" });
  assert.equal(await balance(business._id, "2210"), -90000);

  await lifecycle.createCreditNote({ businessId: business._id, userId: user._id, payload: { invoiceId: invoice._id, creditNoteNumber: "CN-1", lineItems: [{ invoiceLineIndex: 0, productId: product._id, quantity: 1, amount: 5900 }] } });
  assert.equal(await balance(business._id, "4090", "AB Road"), 500000, "income reduced by the part before tax");
  assert.equal(await balance(business._id, "2210"), -45000, "half the CGST taken back");
  assert.equal(await balance(business._id, "2220"), -45000);
  assert.equal(await balance(business._id, "1100"), 590000, "customer owes 5,900 less");

  await lifecycle.createSalesReturn({ businessId: business._id, userId: user._id, payload: { invoiceId: invoice._id, returnNumber: "RET-1", lineItems: [{ invoiceLineIndex: 0, productId: product._id, quantity: 1 }] } });
  assert.equal(await balance(business._id, "4090"), 1000000);
  assert.equal(await balance(business._id, "2210"), 0);
  assert.equal(await balance(business._id, "1100"), 0);

  const pl = await reports.getProfitAndLossReport({ businessId: business._id, query: { from: "2026-04-01", to: "2027-03-31" } });
  const abRoad = pl.byCentre.find((row) => row.centre === "AB Road");
  assert.equal(abRoad.income, 0, "sold 10,000 and took all of it back");

  // Moving the invoice to another centre takes its credit note and return with it.
  invoice.centre = "Vijay Nagar";
  await invoice.save();
  await accounting.repostEditedInvoiceJournalEntry({ invoice, business, previousInvoiceDate: invoice.invoiceDate, editKey: "move1", userId: user._id });
  await accounting.resyncInvoiceCredits({ invoice, business, editKey: "move1", userId: user._id });
  assert.equal(await balance(business._id, "4020", "AB Road"), 0);
  assert.equal(await balance(business._id, "4090", "AB Road"), 0, "credits left AB Road with the invoice");
  assert.equal(await balance(business._id, "4090", "Vijay Nagar"), 1000000);
  assert.equal(await balance(business._id, "1100"), 0, "receivable unchanged by a centre move");
});

test("expenses post to their head and centre, and edits and cancellations move the books", async () => {
  const { business, user } = await setup({ gst: false });
  const expense = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", amountBeforeTax: 50000, paymentStatus: "PAID", paidAmount: 50000, paymentMethod: "BANK_TRANSFER", expenseDate: "2026-10-03", centre: "Vijay Nagar", description: "October rent" } });
  assert.equal(await balance(business._id, "5020", "Vijay Nagar"), 5000000, "rent paid head, Vijay Nagar centre");
  assert.equal(await balance(business._id, "5010"), 0, "not in general expenses");
  assert.equal(await balance(business._id, "1020"), -5000000);

  await expenses.updateExpense({ businessId: business._id, expenseId: expense._id, userId: user._id, payload: { amountBeforeTax: 55000, paidAmount: 55000, centre: "AB Road" } });
  assert.equal(await balance(business._id, "5020", "Vijay Nagar"), 0, "moved off the old centre");
  assert.equal(await balance(business._id, "5020", "AB Road"), 5500000);
  assert.equal(await balance(business._id, "1020"), -5500000);

  const unchanged = await JournalEntry.countDocuments({ businessId: business._id });
  await expenses.updateExpense({ businessId: business._id, expenseId: expense._id, userId: user._id, payload: { notes: "receipt filed" } });
  assert.equal(await JournalEntry.countDocuments({ businessId: business._id }), unchanged, "a note-only edit writes nothing");

  await expenses.cancelExpense({ businessId: business._id, expenseId: expense._id, userId: user._id, reason: "duplicate" });
  assert.equal(await balance(business._id, "5020"), 0, "cancelled expense is out of the P&L");
  assert.equal(await balance(business._id, "1020"), 0);
});

test("profit and loss by centre, and narrowed to one centre", async () => {
  const { business, user, customer, product } = await setup({ gst: false });
  const invoice = await Invoice.create({
    businessId: business._id, customerId: customer._id, invoiceNumber: "INV-C1", invoiceDate: new Date("2026-10-01T00:00:00Z"), dueDate: new Date("2026-10-01T00:00:00Z"),
    customerDetails: { name: customer.name }, businessDetails: { name: business.name },
    lineItems: [{ productId: product._id, productName: "Coworking desk rent", quantity: 1, rate: 30000, taxRate: 0, itemTotal: 30000 }],
    subtotal: 30000, totalTax: 0, grandTotal: 30000, amountPaid: 0, balanceDue: 30000, paymentStatus: "unpaid", status: "issued", centre: "Vijay Nagar", createdBy: user._id,
  });
  await accounting.postInvoiceJournalEntry({ invoice, business, userId: user._id });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Housekeeping & Security", amountBeforeTax: 8000, expenseDate: "2026-10-04", centre: "Vijay Nagar" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Internet & Communication", amountBeforeTax: 2000, expenseDate: "2026-10-04" } });

  const all = await reports.getProfitAndLossReport({ businessId: business._id, query: { from: "2026-04-01", to: "2027-03-31" } });
  assert.equal(all.netProfit, 20000);
  const vn = all.byCentre.find((row) => row.centre === "Vijay Nagar");
  assert.deepEqual([vn.income, vn.expenses, vn.netProfit], [30000, 8000, 22000]);
  const none = all.byCentre.find((row) => row.centre === "__unassigned__");
  assert.deepEqual([none.label, none.expenses], ["Not assigned", 2000]);

  const onlyVn = await reports.getProfitAndLossReport({ businessId: business._id, query: { from: "2026-04-01", to: "2027-03-31", centre: "Vijay Nagar" } });
  assert.equal(onlyVn.netProfit, 22000);
  assert.deepEqual(await reports.listCentres({ businessId: business._id }), ["Vijay Nagar"]);
});

test("the backfill posts old purchases, supplier payments and credit notes, moves old expenses to their heads, and is safe to repeat", async () => {
  const { business, user, customer, supplier, product } = await setup();
  // Saved before phase 1: no journal entries for these.
  const purchase = await purchaseDoc({ business, supplier, product });
  const payment = await Payment.create({ businessId: business._id, direction: "PAID", amount: 1180, paymentDate: new Date("2026-10-08T00:00:00Z"), paymentMethod: "UPI", supplierId: supplier._id, createdBy: user._id });
  // An old rent expense posted the old way, to general expenses, then cancelled without a reversal.
  const rent = await Expense.create({ businessId: business._id, expenseNumber: "EXP-OLD-1", expenseDate: new Date("2026-09-01T00:00:00Z"), category: "Rent", amountBeforeTax: 40000, totalAmount: 40000, paidAmount: 0, balanceAmount: 40000, paymentStatus: "UNPAID", createdBy: user._id });
  const accounts = await accounting.ensureDefaultAccounts({ businessId: business._id });
  const ga = accounts.get("5010");
  const ap = accounts.get("2010");
  await accounting.postJournalEntry({ businessId: business._id, userId: user._id, entryDate: rent.expenseDate, sourceType: "EXPENSE", sourceId: rent._id, sourceKey: `EXPENSE:${rent._id}:RECORDED`, description: "old", lines: [
    { accountId: ga._id, accountCode: ga.code, accountName: ga.name, debitMinor: 4000000, creditMinor: 0 },
    { accountId: ap._id, accountCode: ap.code, accountName: ap.name, debitMinor: 0, creditMinor: 4000000 },
  ] });
  const internet = await Expense.create({ businessId: business._id, expenseNumber: "EXP-OLD-2", expenseDate: new Date("2026-09-02T00:00:00Z"), category: "Internet & Communication", amountBeforeTax: 1000, totalAmount: 1000, paidAmount: 0, balanceAmount: 1000, paymentStatus: "UNPAID", status: "CANCELLED", createdBy: user._id });
  await accounting.postJournalEntry({ businessId: business._id, userId: user._id, entryDate: internet.expenseDate, sourceType: "EXPENSE", sourceId: internet._id, sourceKey: `EXPENSE:${internet._id}:RECORDED`, description: "old", lines: [
    { accountId: ga._id, accountCode: ga.code, accountName: ga.name, debitMinor: 100000, creditMinor: 0 },
    { accountId: ap._id, accountCode: ap.code, accountName: ap.name, debitMinor: 0, creditMinor: 100000 },
  ] });

  const warning = await reports.getHistoricalWarning({ businessId: business._id });
  assert.equal(warning.unpostedCounts.purchases, 1);
  assert.equal(warning.unpostedCounts.payments, 1);

  const dry = await runHistoricalBackfill({ businessId: business._id, userId: user._id, mode: "DRY_RUN" });
  assert.equal(dry.breakdown.purchases.wouldPost, 1);
  assert.equal(dry.breakdown.supplierPayments.wouldPost, 1);
  assert.equal(dry.breakdown.expenseCorrections.wouldPost, 2, "rent to its head, the cancelled one reversed");
  assert.equal(await balance(business._id, "5100"), 0, "a dry run posts nothing");

  const run = await runHistoricalBackfill({ businessId: business._id, userId: user._id, mode: "EXECUTE" });
  assert.equal(run.summary.unresolved, 0, JSON.stringify(run.unresolvedItems));
  assert.equal(await balance(business._id, "5100"), 100000);
  assert.equal(await balance(business._id, "1150"), 118000);
  assert.equal(await balance(business._id, "5010"), 0, "nothing left in general expenses");
  assert.equal(await balance(business._id, "5020"), 4000000, "old rent now under Rent Paid");
  assert.equal(await balance(business._id, "5040"), 0, "cancelled expense reversed");
  assert.equal((await reports.getHistoricalWarning({ businessId: business._id })).hasUnpostedLegacyData, false);

  const before = await JournalEntry.countDocuments({ businessId: business._id });
  const again = await runHistoricalBackfill({ businessId: business._id, userId: user._id, mode: "EXECUTE" });
  assert.equal(again.summary.posted, 0, "second run posts nothing");
  assert.equal(await JournalEntry.countDocuments({ businessId: business._id }), before);
  assert.ok(payment && customer);
});
