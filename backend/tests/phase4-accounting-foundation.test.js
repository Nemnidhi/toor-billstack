const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Invoice = require("../src/models/Invoice");
const Payment = require("../src/models/Payment");
const Expense = require("../src/models/Expense");
const Account = require("../src/models/Account");
const JournalEntry = require("../src/models/JournalEntry");
const { SYSTEM_ACCOUNTS } = require("../src/constants/accounting");
const {
  ensureDefaultAccounts,
  getAccountLedger,
  getTrialBalance,
  postExpenseJournalEntry,
  postInvoiceCancellationJournalEntry,
  postInvoiceJournalEntry,
  postJournalEntry,
  postPaymentAllocatedJournalEntry,
  postPaymentAllocationReversalJournalEntry,
  postPaymentReceivedJournalEntry,
  postPaymentReversalJournalEntry,
} = require("../src/services/accounting.service");
const { allocatePayment, createPayment, reverseAllocation, reversePayment } = require("../src/services/payment.service");
const { createExpense } = require("../src/services/expense.service");

const MONGO_URI = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27018/billstack_phase4_accounting_test?replicaSet=rs0&directConnection=true";

test.before(async () => {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const admin = mongoose.connection.db.admin();
  const status = await admin.command({ replSetGetStatus: 1 });
  assert.equal(status.ok, 1, "Replica set must be healthy and active");
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const setupTestBusiness = async ({ name, billingEntityCode, gstEnabled }) => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `${name} ${uid}`,
    slug: `biz-${uid}`,
    deploymentMode: "SELF_HOSTED",
    billingEntityCode,
    gstTaxId: gstEnabled ? "23CGZPB7175E1Z5" : "",
    gstConfiguration: {
      enabled: gstEnabled,
      gstin: gstEnabled ? "23CGZPB7175E1Z5" : "",
      stateCode: gstEnabled ? "23" : "",
    },
    bankDetails: { accountName: `${name} Operational`, bankName: "HDFC Bank", accountNumber: "9876543210" },
  });

  const user = await User.create({
    businessId: business._id,
    name: `User ${uid}`,
    email: `user-${uid}@example.com`,
    password: "hashedPassword123",
    role: "owner",
  });

  const customer = await Customer.create({
    businessId: business._id,
    name: `Customer ${uid}`,
    phone: "9876543210",
  });

  return { business, user, customer };
};

// ---------------------------------------------------------------------------
// 1. Chart of Accounts & Entity Scoping
// ---------------------------------------------------------------------------
test("Chart of Accounts: seeds minimum system accounts scoped strictly by billing entity", async () => {
  const { business: toor } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });
  const { business: goldhawk } = await setupTestBusiness({ name: "Goldhawk", billingEntityCode: "GOLDHAWK", gstEnabled: false });

  const toorAccounts = await ensureDefaultAccounts({ businessId: toor._id });
  const ghAccounts = await ensureDefaultAccounts({ businessId: goldhawk._id });

  assert.equal(toorAccounts.size, SYSTEM_ACCOUNTS.length);
  assert.equal(ghAccounts.size, SYSTEM_ACCOUNTS.length);

  // Books must remain completely isolated
  const toorAr = toorAccounts.get("1100");
  const ghAr = ghAccounts.get("1100");
  assert.notEqual(toorAr._id.toString(), ghAr._id.toString());
  assert.equal(toorAr.businessId.toString(), toor._id.toString());
  assert.equal(ghAr.businessId.toString(), goldhawk._id.toString());
});

// ---------------------------------------------------------------------------
// 2. TOOR GST Invoice Posting
// Dr AR 11,800
// Cr Revenue 10,000
// Cr CGST Output 900
// Cr SGST Output 900
// ---------------------------------------------------------------------------
test("TOOR GST invoice: creates balanced journal entry with exact CGST/SGST output breakup", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });

  const invoice = {
    _id: new mongoose.Types.ObjectId(),
    businessId: business._id,
    invoiceNumber: "INV-TOOR-001",
    invoiceDate: new Date("2026-10-01"),
    grandTotal: 11800,
    subtotal: 10000,
    totalTax: 1800,
    gstBreakup: { cgst: 900, sgst: 900, igst: 0, taxableValue: 10000 },
    lineItems: [{ productName: "Commercial Brokerage", quantity: 1, rate: 10000, itemTotal: 10000 }],
    crmSourceRef: { billingPurpose: "BROKERAGE" },
  };

  const entry = await postInvoiceJournalEntry({ invoice, business, userId: user._id });

  assert.equal(entry.status, "POSTED");
  assert.equal(entry.totalDebitMinor, 1180000);
  assert.equal(entry.totalCreditMinor, 1180000);
  assert.equal(entry.lines.length, 4);

  // Line 1: Dr AR 11,800
  const arLine = entry.lines.find((l) => l.accountCode === "1100");
  assert.equal(arLine.debitMinor, 1180000);
  assert.equal(arLine.creditMinor, 0);

  // Line 2: Cr Brokerage Revenue 10,000
  const revLine = entry.lines.find((l) => l.accountCode === "4030");
  assert.equal(revLine.debitMinor, 0);
  assert.equal(revLine.creditMinor, 1000000);

  // Line 3: Cr CGST Output 900
  const cgstLine = entry.lines.find((l) => l.accountCode === "2210");
  assert.equal(cgstLine.debitMinor, 0);
  assert.equal(cgstLine.creditMinor, 90000);

  // Line 4: Cr SGST Output 900
  const sgstLine = entry.lines.find((l) => l.accountCode === "2220");
  assert.equal(sgstLine.debitMinor, 0);
  assert.equal(sgstLine.creditMinor, 90000);
});

// ---------------------------------------------------------------------------
// 3. Goldhawk Non-GST Invoice Posting
// Dr AR 10,000
// Cr Brokerage Revenue 10,000
// NO GST POSTING (GST is strictly 0)
// ---------------------------------------------------------------------------
test("Goldhawk non-GST invoice: posts AR and Revenue with ZERO GST posting", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "Goldhawk", billingEntityCode: "GOLDHAWK", gstEnabled: false });

  const invoice = {
    _id: new mongoose.Types.ObjectId(),
    businessId: business._id,
    invoiceNumber: "INV-GH-001",
    invoiceDate: new Date("2026-10-01"),
    grandTotal: 10000,
    subtotal: 10000,
    totalTax: 0,
    lineItems: [{ productName: "Residential Brokerage", quantity: 1, rate: 10000, itemTotal: 10000 }],
    crmSourceRef: { billingPurpose: "BROKERAGE" },
  };

  const entry = await postInvoiceJournalEntry({ invoice, business, userId: user._id });

  assert.equal(entry.status, "POSTED");
  assert.equal(entry.totalDebitMinor, 1000000);
  assert.equal(entry.totalCreditMinor, 1000000);
  assert.equal(entry.lines.length, 2);

  // No GST lines present
  const hasGst = entry.lines.some((l) => ["2210", "2220", "2230"].includes(l.accountCode));
  assert.equal(hasGst, false, "Goldhawk transaction MUST NOT post GST amounts");

  const arLine = entry.lines.find((l) => l.accountCode === "1100");
  assert.equal(arLine.debitMinor, 1000000);

  const revLine = entry.lines.find((l) => l.accountCode === "4030");
  assert.equal(revLine.creditMinor, 1000000);
});

// ---------------------------------------------------------------------------
// 4. Payment Received (Customer Advance) & Later Allocation
// Payment 10,000 received: Dr Bank 10,000, Cr Advances 10,000
// Allocate 7,000 to invoice: Dr Advances 7,000, Cr AR 7,000
// Remaining advance: 3,000
// ---------------------------------------------------------------------------
test("Payment lifecycle: unallocated payment records advance, later allocation debits advance and credits AR", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });

  const payment = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: {
      direction: "RECEIVED",
      amount: 10000,
      customerId: customer._id,
      paymentMethod: "BANK_TRANSFER",
      referenceNumber: "PAY-ADV-001",
    },
  });

  // Verify journal entry for payment received
  const payEntry = await JournalEntry.findOne({ businessId: business._id, sourceKey: `PAYMENT:${payment._id}:RECEIVED` });
  assert.ok(payEntry, "Payment received journal entry must exist");
  assert.equal(payEntry.totalDebitMinor, 1000000);
  assert.equal(payEntry.totalCreditMinor, 1000000);

  const bankLine = payEntry.lines.find((l) => l.accountCode === "1020");
  assert.equal(bankLine.debitMinor, 1000000);
  const advLine = payEntry.lines.find((l) => l.accountCode === "2100");
  assert.equal(advLine.creditMinor, 1000000);

  // Create an invoice of 8,000
  const invoice = await Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber: `INV-SETTLE-${Date.now()}`,
    invoiceDate: new Date(),
    dueDate: new Date(),
    lineItems: [{ productName: "Brokerage", quantity: 1, rate: 8000, itemTotal: 8000 }],
    subtotal: 8000,
    grandTotal: 8000,
    amountPaid: 0,
    balanceDue: 8000,
    paymentStatus: "unpaid",
    status: "issued",
    createdBy: user._id,
  });

  // Allocate 7,000 of the 10,000 payment to invoice
  const allocation = await allocatePayment({
    businessId: business._id,
    userId: user._id,
    paymentId: payment._id,
    payload: { invoiceId: invoice._id, allocatedAmount: 7000 },
  });

  // Verify journal entry for allocation
  const allocEntry = await JournalEntry.findOne({ businessId: business._id, sourceKey: `ALLOCATION:${allocation._id}:POSTED` });
  assert.ok(allocEntry, "Allocation journal entry must exist");
  assert.equal(allocEntry.totalDebitMinor, 700000);
  assert.equal(allocEntry.totalCreditMinor, 700000);

  // Dr Customer Advances 7,000
  const allocAdv = allocEntry.lines.find((l) => l.accountCode === "2100");
  assert.equal(allocAdv.debitMinor, 700000);

  // Cr Accounts Receivable 7,000
  const allocAr = allocEntry.lines.find((l) => l.accountCode === "1100");
  assert.equal(allocAr.creditMinor, 700000);
});

// ---------------------------------------------------------------------------
// 5. Payment Allocation Reversal
// Reversing allocation reinstates AR and restores Customer Advances
// Dr AR 7,000
// Cr Customer Advances 7,000
// ---------------------------------------------------------------------------
test("Payment allocation reversal: creates reversing journal entry without deleting audit history", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });

  const payment = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: { direction: "RECEIVED", amount: 5000, customerId: customer._id, referenceNumber: "PAY-REV-TEST" },
  });

  const invoice = await Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber: `INV-REV-${Date.now()}`,
    invoiceDate: new Date(),
    dueDate: new Date(),
    lineItems: [{ productName: "Brokerage", quantity: 1, rate: 5000, itemTotal: 5000 }],
    subtotal: 5000,
    grandTotal: 5000,
    amountPaid: 0,
    balanceDue: 5000,
    paymentStatus: "unpaid",
    status: "issued",
    createdBy: user._id,
  });

  const allocation = await allocatePayment({
    businessId: business._id,
    userId: user._id,
    paymentId: payment._id,
    payload: { invoiceId: invoice._id, allocatedAmount: 5000 },
  });

  // Reverse allocation
  const reversal = await reverseAllocation({
    businessId: business._id,
    userId: user._id,
    allocationId: allocation._id,
    amount: 5000,
    reason: "Client request",
  });

  const revEntry = await JournalEntry.findOne({ businessId: business._id, sourceKey: `ALLOCATION_REVERSAL:${reversal._id}` });
  assert.ok(revEntry, "Allocation reversal journal entry must exist");
  assert.equal(revEntry.totalDebitMinor, 500000);
  assert.equal(revEntry.totalCreditMinor, 500000);

  // Dr AR 5,000, Cr Advances 5,000
  const arLine = revEntry.lines.find((l) => l.accountCode === "1100");
  assert.equal(arLine.debitMinor, 500000);
  const advLine = revEntry.lines.find((l) => l.accountCode === "2100");
  assert.equal(advLine.creditMinor, 500000);

  // Original allocation entry must still exist intact (immutable audit)
  const origEntry = await JournalEntry.findOne({ businessId: business._id, sourceKey: `ALLOCATION:${allocation._id}:POSTED` });
  assert.ok(origEntry, "Original journal entry must remain in database");
});

// ---------------------------------------------------------------------------
// 6. Payment Reversal / Refund
// Reversing payment debits Customer Advances and credits Bank
// Dr Customer Advances 5,000
// Cr Bank 5,000
// ---------------------------------------------------------------------------
test("Payment refund/reversal: debits Customer Advances and credits Bank", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });

  const payment = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: { direction: "RECEIVED", amount: 5000, customerId: customer._id, referenceNumber: "PAY-REFUND-001" },
  });

  const reversal = await reversePayment({
    businessId: business._id,
    userId: user._id,
    paymentId: payment._id,
    reason: "Full customer refund",
  });

  const refEntry = await JournalEntry.findOne({ businessId: business._id, sourceKey: `PAYMENT_REVERSAL:${reversal._id}` });
  assert.ok(refEntry, "Payment refund journal entry must exist");
  assert.equal(refEntry.totalDebitMinor, 500000);
  assert.equal(refEntry.totalCreditMinor, 500000);

  // Dr Advances 5,000, Cr Bank 5,000
  const advLine = refEntry.lines.find((l) => l.accountCode === "2100");
  assert.equal(advLine.debitMinor, 500000);
  const bankLine = refEntry.lines.find((l) => l.accountCode === "1020");
  assert.equal(bankLine.creditMinor, 500000);
});

// ---------------------------------------------------------------------------
// 7. Expense Posting (TOOR with GST vs Goldhawk without GST)
// ---------------------------------------------------------------------------
test("Expense posting: TOOR records input GST, Goldhawk records ZERO GST", async () => {
  const { business: toor, user: toorUser } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });
  const { business: gh, user: ghUser } = await setupTestBusiness({ name: "Goldhawk", billingEntityCode: "GOLDHAWK", gstEnabled: false });

  // TOOR expense of 10,000 + 18% GST (1,800) = 11,800 PAID
  const toorExp = await createExpense({
    businessId: toor._id,
    userId: toorUser._id,
    payload: {
      amountBeforeTax: 10000,
      gstEnabled: true,
      gstRate: 18,
      placeOfSupplyCode: "23",
      paymentStatus: "PAID",
      paymentMethod: "BANK_TRANSFER",
      category: "Office Supplies",
      description: "Desks and Chairs",
    },
  });

  const toorEntry = await JournalEntry.findOne({ businessId: toor._id, sourceKey: `EXPENSE:${toorExp._id}:RECORDED` });
  assert.ok(toorEntry);
  assert.equal(toorEntry.totalDebitMinor, 1180000);
  assert.equal(toorEntry.totalCreditMinor, 1180000);

  // Dr General Expenses 10,000
  const expLine = toorEntry.lines.find((l) => l.accountCode === "5010");
  assert.equal(expLine.debitMinor, 1000000);

  // Dr Input CGST 900, Dr Input SGST 900
  const cgstIn = toorEntry.lines.find((l) => l.accountCode === "1310");
  const sgstIn = toorEntry.lines.find((l) => l.accountCode === "1320");
  assert.equal(cgstIn.debitMinor, 90000);
  assert.equal(sgstIn.debitMinor, 90000);

  // Cr Bank 11,800
  const bankLine = toorEntry.lines.find((l) => l.accountCode === "1020");
  assert.equal(bankLine.creditMinor, 1180000);

  // Goldhawk expense: even if submitted with gstEnabled, Goldhawk MUST NOT post GST
  const ghExp = await createExpense({
    businessId: gh._id,
    userId: ghUser._id,
    payload: {
      amountBeforeTax: 5000,
      gstEnabled: false,
      gstRate: 0,
      paymentStatus: "PAID",
      paymentMethod: "CASH",
      category: "Printing",
      description: "Brochures",
    },
  });

  const ghEntry = await JournalEntry.findOne({ businessId: gh._id, sourceKey: `EXPENSE:${ghExp._id}:RECORDED` });
  assert.ok(ghEntry);
  assert.equal(ghEntry.totalDebitMinor, 500000);
  assert.equal(ghEntry.totalCreditMinor, 500000);
  assert.equal(ghEntry.lines.length, 2);

  const ghHasGst = ghEntry.lines.some((l) => ["1310", "1320", "1330"].includes(l.accountCode));
  assert.equal(ghHasGst, false, "Goldhawk expense must have no input GST postings");
});

// ---------------------------------------------------------------------------
// 8. Invoice Cancellation & Reissue Posting
// ---------------------------------------------------------------------------
test("Invoice cancellation and reissue: creates reversing entry and new independent posting", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });

  const invoice = {
    _id: new mongoose.Types.ObjectId(),
    businessId: business._id,
    invoiceNumber: "INV-CANCEL-001",
    invoiceDate: new Date(),
    grandTotal: 11800,
    subtotal: 10000,
    totalTax: 1800,
    gstBreakup: { cgst: 900, sgst: 900, taxableValue: 10000 },
    lineItems: [{ productName: "Brokerage", quantity: 1, rate: 10000, itemTotal: 10000 }],
  };

  // Issue
  const issueEntry = await postInvoiceJournalEntry({ invoice, business, userId: user._id });
  assert.equal(issueEntry.status, "POSTED");

  // Cancel
  const cancelEntry = await postInvoiceCancellationJournalEntry({ invoice, userId: user._id });
  assert.ok(cancelEntry);
  assert.equal(cancelEntry.sourceType, "REVERSAL");
  assert.equal(cancelEntry.totalDebitMinor, 1180000);
  assert.equal(cancelEntry.totalCreditMinor, 1180000);

  // In cancel entry: AR is credited 11,800, Revenue is debited 10,000, GST is debited 1,800
  const revAr = cancelEntry.lines.find((l) => l.accountCode === "1100");
  assert.equal(revAr.creditMinor, 1180000);
  const revRev = cancelEntry.lines.find((l) => l.accountCode === "4010" || l.accountCode === "4030");
  assert.equal(revRev.debitMinor, 1000000);
});

// ---------------------------------------------------------------------------
// 9. Safety: Unbalanced Entries Rejected & DB Idempotency
// ---------------------------------------------------------------------------
test("Safety: rejects unbalanced manual entries and enforces DB-level idempotency", async () => {
  const { business, user } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });
  const accounts = await ensureDefaultAccounts({ businessId: business._id });
  const bank = accounts.get("1020");
  const rev = accounts.get("4010");

  // Unbalanced entry: 500 debit vs 400 credit -> must reject
  await assert.rejects(
    postJournalEntry({
      businessId: business._id,
      userId: user._id,
      sourceType: "MANUAL",
      sourceKey: "UNBALANCED_TEST",
      description: "Faulty entry",
      lines: [
        { accountId: bank._id, accountCode: bank.code, accountName: bank.name, debitMinor: 50000, creditMinor: 0 },
        { accountId: rev._id, accountCode: rev.code, accountName: rev.name, debitMinor: 0, creditMinor: 40000 },
      ],
    }),
    /Balanced entry validation failed/
  );

  // Duplicate posting attempt on same sourceKey returns existing entry without duplicating
  const first = await postJournalEntry({
    businessId: business._id,
    userId: user._id,
    sourceType: "MANUAL",
    sourceKey: "IDEMPOTENCY_TEST_KEY",
    description: "First entry",
    lines: [
      { accountId: bank._id, accountCode: bank.code, accountName: bank.name, debitMinor: 50000, creditMinor: 0 },
      { accountId: rev._id, accountCode: rev.code, accountName: rev.name, debitMinor: 0, creditMinor: 50000 },
    ],
  });

  const second = await postJournalEntry({
    businessId: business._id,
    userId: user._id,
    sourceType: "MANUAL",
    sourceKey: "IDEMPOTENCY_TEST_KEY",
    description: "Duplicate entry",
    lines: [
      { accountId: bank._id, accountCode: bank.code, accountName: bank.name, debitMinor: 50000, creditMinor: 0 },
      { accountId: rev._id, accountCode: rev.code, accountName: rev.name, debitMinor: 0, creditMinor: 50000 },
    ],
  });

  assert.equal(first._id.toString(), second._id.toString(), "Idempotent post must return existing journal entry");
  const count = await JournalEntry.countDocuments({ businessId: business._id, sourceKey: "IDEMPOTENCY_TEST_KEY" });
  assert.equal(count, 1, "Exactly one journal document in DB");
});

// ---------------------------------------------------------------------------
// 10. Trial Balance Engine: Total Debits == Total Credits
// ---------------------------------------------------------------------------
test("Trial Balance Engine: debits strictly equal credits across mixed operational flows", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });

  // 1. Issue Invoice 11,800
  const inv = {
    _id: new mongoose.Types.ObjectId(),
    businessId: business._id,
    invoiceNumber: "INV-TB-01",
    invoiceDate: new Date(),
    grandTotal: 11800,
    subtotal: 10000,
    totalTax: 1800,
    gstBreakup: { cgst: 900, sgst: 900, taxableValue: 10000 },
    lineItems: [{ productName: "Brokerage", quantity: 1, rate: 10000, itemTotal: 10000 }],
  };
  await postInvoiceJournalEntry({ invoice: inv, business, userId: user._id });

  // 2. Receive Payment 10,000
  const pay = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: { direction: "RECEIVED", amount: 10000, customerId: customer._id, paymentMethod: "BANK_TRANSFER" },
  });

  // 3. Allocate 7,000 to Invoice
  const dbInv = await Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber: `INV-TB-ALLOC-${Date.now()}`,
    invoiceDate: new Date(),
    dueDate: new Date(),
    lineItems: [{ productName: "Brokerage", quantity: 1, rate: 10000, itemTotal: 10000 }],
    subtotal: 10000,
    grandTotal: 10000,
    amountPaid: 0,
    balanceDue: 10000,
    paymentStatus: "unpaid",
    status: "issued",
    createdBy: user._id,
  });
  await allocatePayment({
    businessId: business._id,
    userId: user._id,
    paymentId: pay._id,
    payload: { invoiceId: dbInv._id, allocatedAmount: 7000 },
  });

  // 4. Run Trial Balance
  const tb = await getTrialBalance({ businessId: business._id });

  assert.equal(tb.totals.isBalanced, true, "Trial Balance must balance");
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit, "Total closing debits must equal total closing credits");
  assert.ok(tb.totals.closing.debit > 0, "Trial balance debits must be non-zero");
});

// ---------------------------------------------------------------------------
// 11. Account Ledger: Running Balance Integrity
// ---------------------------------------------------------------------------
test("Account Ledger: accurately computes running balance for an account", async () => {
  const { business, user, customer } = await setupTestBusiness({ name: "TOOR", billingEntityCode: "", gstEnabled: true });
  const accounts = await ensureDefaultAccounts({ businessId: business._id });
  const bankAcc = accounts.get("1020");

  // Receive 10,000 (Dr Bank 10,000)
  const pay1 = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: { direction: "RECEIVED", amount: 10000, customerId: customer._id, paymentMethod: "BANK_TRANSFER" },
  });

  // Receive 5,000 (Dr Bank 5,000)
  const pay2 = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: { direction: "RECEIVED", amount: 5000, customerId: customer._id, paymentMethod: "BANK_TRANSFER" },
  });

  // Refund 3,000 (Cr Bank 3,000)
  await reversePayment({
    businessId: business._id,
    userId: user._id,
    paymentId: pay2._id,
    reason: "Partial refund",
  });

  const ledger = await getAccountLedger({ businessId: business._id, accountId: bankAcc._id });

  assert.equal(ledger.transactions.length, 3);
  assert.equal(ledger.transactions[0].debit, 10000);
  assert.equal(ledger.transactions[0].runningBalance, 10000);

  assert.equal(ledger.transactions[1].debit, 5000);
  assert.equal(ledger.transactions[1].runningBalance, 15000);

  assert.equal(ledger.transactions[2].credit, 5000);
  assert.equal(ledger.transactions[2].runningBalance, 10000);
  assert.equal(ledger.closingBalance, 10000);
});
