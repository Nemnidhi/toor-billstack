const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Invoice = require("../src/models/Invoice");
const Payment = require("../src/models/Payment");
const PaymentAllocation = require("../src/models/PaymentAllocation");
const Expense = require("../src/models/Expense");
const Account = require("../src/models/Account");
const JournalEntry = require("../src/models/JournalEntry");
const BankAccount = require("../src/models/BankAccount");
const BankStatementTransaction = require("../src/models/BankStatementTransaction");

const { ensureDefaultAccounts } = require("../src/services/accounting.service");
const {
  runHistoricalBackfill,
  postOpeningBalances,
} = require("../src/services/accounting-backfill.service");
const {
  importBankStatementCsv,
  generateMatchSuggestions,
  confirmMatch,
  unmatchTransaction,
  getReconciliationSummary,
} = require("../src/services/bank-reconciliation.service");
const { getProfitAndLossReport, getBalanceSheetReport } = require("../src/services/accounting-reports.service");

const MONGO_URI = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27018/billstack_phase6_test?replicaSet=rs0&directConnection=true";

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

const setupTestEntities = async () => {
  const uid = crypto.randomBytes(6).toString("hex");

  const toor = await Business.create({
    name: "TOOR " + uid,
    slug: "toor-" + uid,
    deploymentMode: "SELF_HOSTED",
    billingEntityCode: "",
    gstTaxId: "23CGZPB7175E1Z5",
    gstConfiguration: { enabled: true, gstin: "23CGZPB7175E1Z5", stateCode: "23" },
  });

  const goldhawk = await Business.create({
    name: "Goldhawk " + uid,
    slug: "gh-" + uid,
    deploymentMode: "SELF_HOSTED",
    billingParentId: toor._id,
    billingEntityCode: "GOLDHAWK",
    gstTaxId: "",
    gstConfiguration: { enabled: false },
  });

  const owner = await User.create({
    businessId: toor._id,
    name: "Owner " + uid,
    email: "owner-" + uid + "@example.com",
    role: "owner",
    password: "hashedPassword123",
  });

  const toorCustomer = await Customer.create({
    businessId: toor._id,
    name: "TOOR Cust " + uid,
    phone: "9876543210",
  });

  const ghCustomer = await Customer.create({
    businessId: goldhawk._id,
    name: "GH Cust " + uid,
    phone: "9123456780",
  });

  const toorBank = await BankAccount.create({
    businessId: toor._id,
    accountName: "HDFC Primary",
    bankName: "HDFC Bank",
    accountNumber: "50200011223344",
    openingBalance: 100000,
  });

  const ghBank = await BankAccount.create({
    businessId: goldhawk._id,
    accountName: "ICICI Primary",
    bankName: "ICICI Bank",
    accountNumber: "000105009988",
    openingBalance: 50000,
  });

  return { toor, goldhawk, owner, toorCustomer, ghCustomer, toorBank, ghBank };
};

// ---------------------------------------------------------------------------
// A. HISTORICAL ACCOUNTING BACKFILL TESTS
// ---------------------------------------------------------------------------

test("Dry Run writes nothing and reports accurate candidate counts", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  // Create an invoice without journal entry
  await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "LEGACY-INV-DRY-1",
    invoiceDate: new Date("2026-03-10"),
    dueDate: new Date("2026-03-25"),
    taxableAmount: 20000,
    subtotal: 20000,
    totalTax: 3600,
    grandTotal: 23600,
    amountPaid: 0,
    balanceDue: 23600,
    status: "issued",
    gstBreakup: { cgst: 1800, sgst: 1800 },
    lineItems: [{ productName: "Coworking Space", quantity: 1, rate: 20000, itemTotal: 20000 }],
  });

  const beforeCount = await JournalEntry.countDocuments({ businessId: toor._id });
  assert.equal(beforeCount, 0);

  const dryRun = await runHistoricalBackfill({
    businessId: toor._id,
    userId: owner._id,
    mode: "DRY_RUN",
  });

  assert.equal(dryRun.mode, "DRY_RUN");
  assert.equal(dryRun.summary.totalCandidates, 1);
  assert.equal(dryRun.summary.wouldPost, 1);
  assert.equal(dryRun.summary.posted, 0);

  const afterCount = await JournalEntry.countDocuments({ businessId: toor._id });
  assert.equal(afterCount, 0, "Dry run must never write to database");
});

test("Execute creates balanced journal entries; second execution creates zero duplicates (idempotency)", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  const invoice = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "LEGACY-INV-EXEC-1",
    invoiceDate: new Date("2026-03-12"),
    dueDate: new Date("2026-03-27"),
    taxableAmount: 30000,
    subtotal: 30000,
    totalTax: 5400,
    grandTotal: 35400,
    amountPaid: 0,
    balanceDue: 35400,
    status: "issued",
    gstBreakup: { cgst: 2700, sgst: 2700 },
    lineItems: [{ productName: "Office Suite", quantity: 1, rate: 30000, itemTotal: 30000 }],
  });

  // First Execution
  const exec1 = await runHistoricalBackfill({
    businessId: toor._id,
    userId: owner._id,
    mode: "EXECUTE",
  });

  assert.equal(exec1.summary.posted, 1);
  assert.equal(exec1.summary.alreadyPosted, 0);

  const postedJe = await JournalEntry.findOne({ businessId: toor._id, sourceKey: "INVOICE:" + invoice._id + ":ISSUED" });
  assert.ok(postedJe);
  assert.equal(postedJe.totalDebitMinor, 3540000);
  assert.equal(postedJe.totalCreditMinor, 3540000);

  // Second Execution (Idempotency test)
  const exec2 = await runHistoricalBackfill({
    businessId: toor._id,
    userId: owner._id,
    mode: "EXECUTE",
  });

  assert.equal(exec2.summary.posted, 0, "Second execution must post zero new entries");
  assert.equal(exec2.summary.alreadyPosted, 1, "Must detect already posted journal record");

  const totalJeCount = await JournalEntry.countDocuments({ businessId: toor._id });
  assert.equal(totalJeCount, 1, "Total journal entries count must remain exactly 1");
});

test("Goldhawk historical invoice backfill: posts AR and Revenue with ZERO GST", async () => {
  const { goldhawk, owner, ghCustomer } = await setupTestEntities();

  const ghInvoice = await Invoice.create({
    businessId: goldhawk._id,
    customerId: ghCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "LEGACY-GH-001",
    invoiceDate: new Date("2026-03-15"),
    dueDate: new Date("2026-03-30"),
    sellerSnapshot: { billingEntityCode: "GOLDHAWK" },
    taxableAmount: 50000,
    subtotal: 50000,
    totalTax: 0,
    grandTotal: 50000,
    amountPaid: 0,
    balanceDue: 50000,
    status: "issued",
    lineItems: [{ productName: "Advisory Brokerage", quantity: 1, rate: 50000, itemTotal: 50000 }],
  });

  const exec = await runHistoricalBackfill({
    businessId: goldhawk._id,
    userId: owner._id,
    mode: "EXECUTE",
  });

  assert.equal(exec.summary.posted, 1);

  const ghJe = await JournalEntry.findOne({ businessId: goldhawk._id, sourceKey: "INVOICE:" + ghInvoice._id + ":ISSUED" });
  assert.ok(ghJe);
  // Verify lines: AR (1100) and Revenue (4010/4030). NO GST lines!
  const gstLines = ghJe.lines.filter((l) => ["2210", "2220", "2230"].includes(l.accountCode));
  assert.equal(gstLines.length, 0, "Goldhawk journal entry must have zero GST lines");
  assert.equal(ghJe.totalDebitMinor, 5000000);
});

test("Historical payment, advance, and allocation backfill", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  // Historical Payment of 50,000 received
  const payment = await Payment.create({
    businessId: toor._id,
    createdBy: owner._id,
    customerId: toorCustomer._id,
    amount: 50000,
    direction: "RECEIVED",
    paymentMethod: "BANK_TRANSFER",
    paymentDate: new Date("2026-02-01"),
    status: "POSTED",
    referenceNumber: "HIST-PAY-01",
    idempotencyKey: "HIST-IDEMP-01",
  });

  // Historical Invoice of 30,000
  const invoice = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "HIST-INV-ALLOC-01",
    invoiceDate: new Date("2026-02-05"),
    dueDate: new Date("2026-02-20"),
    taxableAmount: 30000,
    subtotal: 30000,
    totalTax: 0,
    grandTotal: 30000,
    amountPaid: 30000,
    balanceDue: 0,
    status: "issued", paymentStatus: "paid",
    lineItems: [{ productName: "Consulting", quantity: 1, rate: 30000, itemTotal: 30000 }],
  });

  // Historical Allocation of 30,000 from Payment to Invoice
  const allocation = await PaymentAllocation.create({
    businessId: toor._id,
    paymentId: payment._id,
    invoiceId: invoice._id,
    allocatedAmount: 30000,
    allocatedAt: new Date("2026-02-06"),
    createdBy: owner._id,
  });

  const exec = await runHistoricalBackfill({
    businessId: toor._id,
    userId: owner._id,
    mode: "EXECUTE",
  });

  // Must post: 1 Invoice + 1 Payment Receipt + 1 Payment Allocation = 3 entries
  assert.equal(exec.summary.posted, 3);

  const payJe = await JournalEntry.findOne({ businessId: toor._id, sourceKey: "PAYMENT:" + payment._id + ":RECEIVED" });
  assert.ok(payJe);
  // Bank debit 50k, Customer Advances credit 50k
  const advLine = payJe.lines.find((l) => l.accountCode === "2100");
  assert.equal(advLine.creditMinor, 5000000);

  const allocJe = await JournalEntry.findOne({ businessId: toor._id, sourceKey: "ALLOCATION:" + allocation._id + ":POSTED" });
  assert.ok(allocJe);
  // Customer Advances debit 30k, AR credit 30k
  const allocAdv = allocJe.lines.find((l) => l.accountCode === "2100");
  const allocAr = allocJe.lines.find((l) => l.accountCode === "1100");
  assert.equal(allocAdv.debitMinor, 3000000);
  assert.equal(allocAr.creditMinor, 3000000);
});

test("Unresolved historical data is reported without guessing or inventing numbers", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  // Create an invalid invoice with zero grandTotal
  await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "BROKEN-INV-001",
    invoiceDate: new Date("2026-01-10"),
    dueDate: new Date("2026-01-20"),
    subtotal: 0,
    taxableAmount: 0,
    grandTotal: 0,
    status: "issued",
    lineItems: [{ productName: "Zero item", quantity: 0, rate: 0, itemTotal: 0 }],
  });

  const dryRun = await runHistoricalBackfill({
    businessId: toor._id,
    userId: owner._id,
    mode: "DRY_RUN",
  });

  assert.equal(dryRun.summary.invalid, 1);
  assert.equal(dryRun.unresolvedItems.length, 1);
  assert.equal(dryRun.unresolvedItems[0].type, "INVOICE");
  assert.ok(dryRun.unresolvedItems[0].reason.includes("greater than zero"));
});

test("Opening Balances: creates balanced entry; rejects unbalanced entries", async () => {
  const { toor, owner } = await setupTestEntities();
  await ensureDefaultAccounts({ businessId: toor._id });

  const bankAcc = await Account.findOne({ businessId: toor._id, code: "1020" });
  const equityAcc = await Account.findOne({ businessId: toor._id, code: "3010" });

  // 1. Balanced Entry (Debit Bank 100,000, Credit Equity 100,000)
  const entry = await postOpeningBalances({
    businessId: toor._id,
    userId: owner._id,
    effectiveDate: "2026-04-01",
    description: "Opening balances FY 2026-27",
    lines: [
      { accountId: bankAcc._id, debitMinor: 10000000, creditMinor: 0 },
      { accountId: equityAcc._id, debitMinor: 0, creditMinor: 10000000 },
    ],
  });

  assert.ok(entry);
  assert.equal(entry.sourceType, "OPENING_BALANCE");
  assert.equal(entry.totalDebitMinor, 10000000);
  assert.equal(entry.totalCreditMinor, 10000000);

  // 2. Unbalanced Entry (Debit 50,000, Credit 40,000) -> Must Reject
  await assert.rejects(
    postOpeningBalances({
      businessId: toor._id,
      userId: owner._id,
      effectiveDate: "2026-04-01",
      lines: [
        { accountId: bankAcc._id, debitMinor: 5000000, creditMinor: 0 },
        { accountId: equityAcc._id, debitMinor: 0, creditMinor: 4000000 },
      ],
    }),
    /Balanced entry validation failed/
  );
});

// ---------------------------------------------------------------------------
// B. BANK STATEMENT IMPORT & RECONCILIATION TESTS
// ---------------------------------------------------------------------------

test("Bank Statement CSV Import: parses standard rows and skips duplicates idempotently", async () => {
  const { toor, toorBank, owner } = await setupTestEntities();

  const csv = "Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n" +
    "01/05/2026,CLIENT ADVANCE,UTR98765,,50000.00,150000.00\n" +
    "03/05/2026,OFFICE RENT,CHQ1122,15000.00,,135000.00";

  // First Import
  const res1 = await importBankStatementCsv({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    csvText: csv,
    userId: owner._id,
  });

  assert.equal(res1.importedCount, 2);
  assert.equal(res1.duplicateCount, 0);

  // Second Import of the same file (Duplicate protection)
  const res2 = await importBankStatementCsv({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    csvText: csv,
    userId: owner._id,
  });

  assert.equal(res2.importedCount, 0, "Repeated import must import zero new rows");
  assert.equal(res2.duplicateCount, 2, "Must detect exactly 2 duplicate rows");

  const totalRows = await BankStatementTransaction.countDocuments({ bankAccountId: toorBank._id });
  assert.equal(totalRows, 2);
});

test("Bank Reconciliation: exact match, suggested match, confirm match, unmatch and difference calculation", async () => {
  const { toor, toorBank, owner, toorCustomer } = await setupTestEntities();

  // Create a journal entry: Inflow of 50,000 received via Bank
  const payment = await Payment.create({
    businessId: toor._id,
    createdBy: owner._id,
    customerId: toorCustomer._id,
    amount: 50000,
    direction: "RECEIVED",
    paymentMethod: "BANK_TRANSFER",
    paymentDate: new Date("2026-05-01"),
    status: "POSTED",
    referenceNumber: "UTR98765",
  });

  // Run backfill to create the journal entry
  await runHistoricalBackfill({ businessId: toor._id, userId: owner._id, mode: "EXECUTE" });

  const je = await JournalEntry.findOne({ businessId: toor._id, sourceKey: "PAYMENT:" + payment._id + ":RECEIVED" });
  assert.ok(je);

  // Import statement containing the 50,000 deposit with matching reference
  const csv = "Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n" +
    "01/05/2026,CLIENT ADVANCE,UTR98765,,50000.00,150000.00";

  await importBankStatementCsv({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    csvText: csv,
    userId: owner._id,
  });

  const stmt = await BankStatementTransaction.findOne({ bankAccountId: toorBank._id });
  assert.ok(stmt);
  assert.equal(stmt.status, "SUGGESTED_MATCH");
  assert.equal(stmt.suggestedMatches[0].confidence, "EXACT");

  // 1. Confirm Match
  const matched = await confirmMatch({
    businessId: toor._id,
    bankTransactionId: stmt._id,
    journalEntryId: je._id,
    userId: owner._id,
  });

  assert.equal(matched.status, "MATCHED");
  assert.equal(matched.reconciledJournalEntryId.toString(), je._id.toString());

  // Verify same bank row cannot be matched twice
  await assert.rejects(
    confirmMatch({
      businessId: toor._id,
      bankTransactionId: stmt._id,
      journalEntryId: je._id,
      userId: owner._id,
    }),
    /already matched/
  );

  // 2. Check Reconciliation Summary
  const summary = await getReconciliationSummary({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    asOfDate: "2026-05-31",
  });

  assert.equal(summary.statementClosingBalance, 150000);
  assert.equal(summary.metrics.matchedCount, 1);
  assert.equal(summary.metrics.unmatchedStatementCount, 0);

  // 3. Unmatch
  const unmatched = await unmatchTransaction({
    businessId: toor._id,
    bankTransactionId: stmt._id,
    userId: owner._id,
  });

  assert.equal(unmatched.status, "SUGGESTED_MATCH");
  assert.equal(unmatched.reconciledJournalEntryId, null);
});

test("Cross-entity bank reconciliation is strictly blocked", async () => {
  const { toor, goldhawk, toorBank, ghBank, owner, toorCustomer } = await setupTestEntities();

  // Create TOOR payment and journal entry
  const payment = await Payment.create({
    businessId: toor._id,
    createdBy: owner._id,
    customerId: toorCustomer._id,
    amount: 25000,
    direction: "RECEIVED",
    paymentDate: new Date("2026-06-01"),
    status: "POSTED",
  });
  await runHistoricalBackfill({ businessId: toor._id, userId: owner._id, mode: "EXECUTE" });
  const toorJe = await JournalEntry.findOne({ businessId: toor._id });

  // Import statement row into GOLDHAWK's bank account
  const ghCsv = "Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n" +
    "01/06/2026,DEPOSIT,, ,25000.00,75000.00";
  await importBankStatementCsv({
    businessId: goldhawk._id,
    bankAccountId: ghBank._id,
    csvText: ghCsv,
    userId: owner._id,
  });

  const ghStmt = await BankStatementTransaction.findOne({ bankAccountId: ghBank._id });

  // Attempting to match Goldhawk statement transaction against TOOR journal entry must fail
  await assert.rejects(
    confirmMatch({
      businessId: goldhawk._id,
      bankTransactionId: ghStmt._id,
      journalEntryId: toorJe._id, // Belongs to TOOR!
      userId: owner._id,
    }),
    /Journal entry not found/
  );
});

test("Phase 5 reports seamlessly reflect backfilled historical journal entries", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  // Create historical invoice
  await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "BACKFILL-REP-1",
    invoiceDate: new Date("2026-05-10"),
    dueDate: new Date("2026-05-25"),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 18000,
    grandTotal: 118000,
    amountPaid: 0,
    balanceDue: 118000,
    status: "issued",
    gstBreakup: { cgst: 9000, sgst: 9000 },
    lineItems: [{ productName: "Enterprise Dedicated Suite", quantity: 1, rate: 100000, itemTotal: 100000 }],
  });

  // Prior to backfill: P&L revenue should be 0
  const plBefore = await getProfitAndLossReport({ businessId: toor._id, query: { from: "2026-05-01", to: "2026-05-31" } });
  assert.equal(plBefore.income.total, 0);

  // Execute Backfill
  await runHistoricalBackfill({ businessId: toor._id, userId: owner._id, mode: "EXECUTE" });

  // After backfill: P&L revenue automatically picks up the journal entry (taxable 100,000)
  const plAfter = await getProfitAndLossReport({ businessId: toor._id, query: { from: "2026-05-01", to: "2026-05-31" } });
  assert.equal(plAfter.income.total, 100000);
  assert.equal(plAfter.netProfit, 100000);

  // Balance sheet reflects AR and Output GST
  const bsAfter = await getBalanceSheetReport({ businessId: toor._id, query: { to: "2026-05-31" } });
  assert.equal(bsAfter.totals.totalAssets, 118000);
  assert.equal(bsAfter.totals.totalLiabilities, 18000);
  assert.equal(bsAfter.equity.retainedEarnings, 100000);
  assert.equal(bsAfter.totals.isBalanced, true);
});
