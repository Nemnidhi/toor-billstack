// Real-database checks for the 20 Nov 2026 audit fixes that touch the books.
// Needs a replica-set MongoDB, like the phase4-9 tests:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_audit_fixes_test?replicaSet=rs0&directConnection=true" node --test tests/audit-fixes-books.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Product = require("../src/models/Product");
const Invoice = require("../src/models/Invoice");
const JournalEntry = require("../src/models/JournalEntry");
const CustomerLedger = require("../src/models/CustomerLedger");
const RecurringBillingProfile = require("../src/models/RecurringBillingProfile");
const AuditLog = require("../src/models/AuditLog");
const accounting = require("../src/services/accounting.service");
const { rebookInvoiceReceivable, netInvoiceReceivables, createCustomerLedgerEntryOnce } = require("../src/services/ledger.service");
const { processDueRecurringProfiles } = require("../src/services/workflow.service");

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
  const customerA = await Customer.create({ businessId: business._id, name: `Tenant A ${uid}`, phone: "9876543210" });
  const customerB = await Customer.create({ businessId: business._id, name: `Tenant B ${uid}`, phone: "9876543211" });
  return { business, user, customerA, customerB };
};

const invoiceDoc = async ({ business, customer, total, tax = 0, date = new Date("2026-10-01T00:00:00Z") }) =>
  Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber: `INV-${crypto.randomBytes(3).toString("hex")}`,
    invoiceDate: date,
    dueDate: date,
    customerDetails: { name: customer.name },
    businessDetails: { name: business.name },
    lineItems: [{ productName: "Coworking desk rent", quantity: 1, rate: total - tax, taxRate: 0, itemTotal: total - tax }],
    subtotal: total - tax,
    totalTax: tax,
    gstBreakup: tax ? { cgst: tax / 2, sgst: tax / 2, igst: 0, taxableValue: total - tax } : undefined,
    grandTotal: total,
    amountPaid: 0,
    balanceDue: total,
    paymentStatus: "unpaid",
    status: "issued",
    createdBy: new mongoose.Types.ObjectId(),
  });

// What the general ledger says for one account code, from every posted entry.
const accountBalance = async (businessId, code) => {
  const entries = await JournalEntry.find({ businessId });
  let net = 0;
  for (const entry of entries) for (const line of entry.lines) if (line.accountCode === code) net += line.debitMinor - line.creditMinor;
  return net;
};

const issue = async ({ business, user, invoice }) => {
  await createCustomerLedgerEntryOnce({ businessId: business._id, customerId: invoice.customerId, eventType: "INVOICE", amount: invoice.grandTotal, direction: "DEBIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:DEBIT`, createdBy: user._id });
  await accounting.postInvoiceJournalEntry({ invoice, business, userId: user._id });
};

test("editing an issued invoice moves the journal and the customer ledger to the new amount", async () => {
  const { business, user, customerA } = await setup();
  const invoice = await invoiceDoc({ business, customer: customerA, total: 11800, tax: 1800 });
  await issue({ business, user, invoice });
  assert.equal(await accountBalance(business._id, "1100"), 1180000);

  const previousInvoiceDate = invoice.invoiceDate;
  invoice.grandTotal = 23600;
  invoice.subtotal = 20000;
  invoice.totalTax = 3600;
  invoice.gstBreakup = { cgst: 1800, sgst: 1800, igst: 0, taxableValue: 20000 };
  invoice.lineItems[0].rate = 20000;
  invoice.lineItems[0].itemTotal = 20000;
  await invoice.save();
  const editKey = new mongoose.Types.ObjectId().toString();
  await rebookInvoiceReceivable({ businessId: business._id, invoiceId: invoice._id, targetCustomerId: customerA._id, targetAmount: invoice.grandTotal, keyPrefix: `INVOICE:${invoice._id}:EDIT:${editKey}`, createdBy: user._id });
  await accounting.repostEditedInvoiceJournalEntry({ invoice, business, previousInvoiceDate, editKey, userId: user._id });

  assert.equal(await accountBalance(business._id, "1100"), 2360000, "receivable follows the edit");
  assert.equal(await accountBalance(business._id, "2210"), -180000, "CGST output follows the edit");
  const owed = await netInvoiceReceivables({ businessId: business._id, invoiceId: invoice._id });
  assert.deepEqual(owed.map((row) => row.netPaise), [2360000]);

  // Saving again with nothing changed writes nothing new.
  const before = await JournalEntry.countDocuments({ businessId: business._id });
  const again = new mongoose.Types.ObjectId().toString();
  await rebookInvoiceReceivable({ businessId: business._id, invoiceId: invoice._id, targetCustomerId: customerA._id, targetAmount: invoice.grandTotal, keyPrefix: `INVOICE:${invoice._id}:EDIT:${again}`, createdBy: user._id });
  await accounting.repostEditedInvoiceJournalEntry({ invoice, business, previousInvoiceDate: invoice.invoiceDate, editKey: again, userId: user._id });
  assert.equal(await JournalEntry.countDocuments({ businessId: business._id }), before);

  // Cancelling the edited invoice clears exactly what the books hold.
  await rebookInvoiceReceivable({ businessId: business._id, invoiceId: invoice._id, targetCustomerId: null, keyPrefix: `INVOICE:${invoice._id}:CANCEL`, singleCreditKey: `INVOICE:${invoice._id}:CANCEL`, createdBy: user._id });
  await accounting.postInvoiceCancellationJournalEntry({ invoice, userId: user._id });
  for (const code of ["1100", "2210", "2220", "4020"]) assert.equal(await accountBalance(business._id, code), 0, `account ${code} is clear after cancel`);
  assert.deepEqual(await netInvoiceReceivables({ businessId: business._id, invoiceId: invoice._id }), []);
  assert.ok(await CustomerLedger.findOne({ businessId: business._id, sourceKey: `INVOICE:${invoice._id}:CANCEL` }), "cancellation keeps its usual ledger key");
});

test("moving an invoice to another customer moves the receivable with it", async () => {
  const { business, user, customerA, customerB } = await setup({ gst: false });
  const invoice = await invoiceDoc({ business, customer: customerA, total: 5000 });
  await issue({ business, user, invoice });
  invoice.customerId = customerB._id;
  await invoice.save();
  await rebookInvoiceReceivable({ businessId: business._id, invoiceId: invoice._id, targetCustomerId: customerB._id, targetAmount: 5000, keyPrefix: `INVOICE:${invoice._id}:EDIT:x1`, createdBy: user._id });
  const owed = await netInvoiceReceivables({ businessId: business._id, invoiceId: invoice._id });
  assert.equal(owed.length, 1);
  assert.equal(String(owed[0].customerId), String(customerB._id));
  assert.equal(owed[0].netPaise, 500000);
});

test("an invoice that was never posted gets its normal issue posting when edited", async () => {
  const { business, user, customerA } = await setup({ gst: false });
  const invoice = await invoiceDoc({ business, customer: customerA, total: 7000 });
  await accounting.repostEditedInvoiceJournalEntry({ invoice, business, previousInvoiceDate: invoice.invoiceDate, editKey: "e1", userId: user._id });
  assert.ok(await JournalEntry.findOne({ businessId: business._id, sourceKey: `INVOICE:${invoice._id}:ISSUED` }));
  assert.equal(await accountBalance(business._id, "1100"), 700000);
});

test("one recurring profile that cannot bill is paused; the others still bill and are posted to the books", async () => {
  const { business, user, customerA, customerB } = await setup({ gst: false });
  const product = await Product.create({ businessId: business._id, name: "Dedicated desk", trackInventory: false });
  const item = { productId: product._id, productName: "Dedicated desk", quantity: 1, rate: 9000, taxRate: 0, itemTotal: 9000 };
  const due = new Date("2026-01-31T00:00:00Z");
  const base = { businessId: business._id, name: "Desk rent", lineItems: [item], subtotal: 9000, grandTotal: 9000, frequency: "MONTHLY", interval: 1, startDate: due, nextBillingDate: due, status: "ACTIVE", autoGenerateInvoice: true, createdBy: user._id };
  const broken = await RecurringBillingProfile.create({ ...base, name: "Broken", customerId: new mongoose.Types.ObjectId() });
  const good = await RecurringBillingProfile.create({ ...base, name: "Good", customerId: customerA._id, nextBillingDate: new Date(due.getTime() + 1000) });
  const ended = await RecurringBillingProfile.create({ ...base, name: "Ended", customerId: customerB._id, endDate: new Date("2025-12-31T00:00:00Z") });

  const results = await processDueRecurringProfiles({ businessId: business._id, userId: user._id, now: new Date("2026-02-01T00:00:00Z") });
  assert.equal(results.length, 1, "the good profile billed");

  const goodAfter = await RecurringBillingProfile.findById(good._id);
  assert.equal(goodAfter.nextBillingDate.toISOString(), "2026-02-28T00:00:01.000Z", "31 Jan + 1 month = 28 Feb, not 3 Mar");
  assert.equal((await RecurringBillingProfile.findById(broken._id)).status, "PAUSED");
  assert.equal((await RecurringBillingProfile.findById(ended._id)).status, "COMPLETED");
  assert.ok(await AuditLog.findOne({ businessId: business._id, action: "RECURRING_PROFILE_PAUSED", "entity.id": broken._id }));

  const invoice = await Invoice.findOne({ businessId: business._id, sourceRecurringProfileId: good._id });
  assert.ok(await JournalEntry.findOne({ businessId: business._id, sourceKey: `INVOICE:${invoice._id}:ISSUED` }), "recurring invoice is in the journal");
});
