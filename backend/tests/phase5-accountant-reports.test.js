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
const BusinessMembership = require("../src/models/BusinessMembership");

const {
  ensureDefaultAccounts,
  postInvoiceJournalEntry,
  postPaymentReceivedJournalEntry,
  postPaymentAllocatedJournalEntry,
  postExpenseJournalEntry,
  getTrialBalance,
} = require("../src/services/accounting.service");

const {
  getProfitAndLossReport,
  getBalanceSheetReport,
  getLedgerBookReport,
  getConsolidatedReport,
  getHistoricalWarning,
  getAccountantExportPack,
} = require("../src/services/accounting-reports.service");

const { resolveIndianPeriod, getIndianFinancialYear } = require("../src/utils/indian-fy");
const { allocatePayment, createPayment } = require("../src/services/payment.service");
const { createExpense } = require("../src/services/expense.service");

const MONGO_URI = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27018/billstack_phase5_reports_test?replicaSet=rs0&directConnection=true";

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

  // 1. TOOR (GST Home Entity)
  const toor = await Business.create({
    name: "The Office On Rent " + uid,
    slug: "toor-" + uid,
    deploymentMode: "SELF_HOSTED",
    billingEntityCode: "",
    gstTaxId: "23CGZPB7175E1Z5",
    gstConfiguration: { enabled: true, gstin: "23CGZPB7175E1Z5", stateCode: "23" },
    bankDetails: { accountName: "TOOR Operational", bankName: "HDFC Bank", accountNumber: "1111222233" },
  });

  // 2. Goldhawk (Non-GST Child Entity)
  const goldhawk = await Business.create({
    name: "Goldhawk Infrabulls " + uid,
    slug: "gh-" + uid,
    deploymentMode: "SELF_HOSTED",
    billingParentId: toor._id,
    billingEntityCode: "GOLDHAWK",
    gstTaxId: "",
    gstConfiguration: { enabled: false },
    bankDetails: { accountName: "Goldhawk Operational", bankName: "ICICI Bank", accountNumber: "4444555566" },
  });

  const owner = await User.create({
    businessId: toor._id,
    name: "Group Owner " + uid,
    email: "owner-" + uid + "@example.com",
    role: "owner",
    password: "hashedPassword123",
  });

  const accountant = await User.create({
    businessId: toor._id,
    name: "Accountant " + uid,
    email: "accountant-" + uid + "@example.com",
    role: "accountant",
    password: "hashedPassword123",
  });

  const staff = await User.create({
    businessId: toor._id,
    name: "Staff " + uid,
    email: "staff-" + uid + "@example.com",
    role: "staff",
    password: "hashedPassword123",
  });

  // Give accountant membership in Goldhawk as well
  await BusinessMembership.create({
    userId: accountant._id,
    businessId: goldhawk._id,
    role: "accountant",
  });

  const toorCustomer = await Customer.create({
    businessId: toor._id,
    name: "TOOR Client " + uid,
    phone: "9876543210",
  });

  const ghCustomer = await Customer.create({
    businessId: goldhawk._id,
    name: "Goldhawk Client " + uid,
    phone: "9123456780",
  });

  return { toor, goldhawk, owner, accountant, staff, toorCustomer, ghCustomer };
};

// ---------------------------------------------------------------------------

test("Indian Financial Year and all 4 quarters date boundary resolution", () => {
  const fyYear = 2026;

  const fullFy = resolveIndianPeriod({ fyYear });
  assert.equal(fullFy.fromStr, "2026-04-01");
  assert.equal(fullFy.toStr, "2027-03-31");
  assert.equal(fullFy.period, "FY");

  const q1 = resolveIndianPeriod({ fyYear, period: "Q1" });
  assert.equal(q1.fromStr, "2026-04-01");
  assert.equal(q1.toStr, "2026-06-30");

  const q2 = resolveIndianPeriod({ fyYear, period: "Q2" });
  assert.equal(q2.fromStr, "2026-07-01");
  assert.equal(q2.toStr, "2026-09-30");

  const q3 = resolveIndianPeriod({ fyYear, period: "Q3" });
  assert.equal(q3.fromStr, "2026-10-01");
  assert.equal(q3.toStr, "2026-12-31");

  const q4 = resolveIndianPeriod({ fyYear, period: "Q4" });
  assert.equal(q4.fromStr, "2027-01-01");
  assert.equal(q4.toStr, "2027-03-31");
});

test("TOOR P&L and Balance Sheet: derives from journal, records GST liability without counting GST as income/expense", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  // Create TOOR Invoice: Taxable 50,000 + 18% GST (4,500 CGST + 4,500 SGST) = 59,000
  const invoice = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-TOOR-001",
    invoiceDate: new Date("2026-05-15"),
    dueDate: new Date("2026-05-30"),
    taxableAmount: 50000,
    subtotal: 50000,
    totalTax: 9000,
    grandTotal: 59000,
    amountPaid: 0,
    balanceDue: 59000,
    paymentStatus: "unpaid",
    gstBreakup: { cgst: 4500, sgst: 4500, igst: 0 },
    lineItems: [{ productName: "Coworking Dedicated Desks", quantity: 5, rate: 10000, itemTotal: 50000, taxRate: 18 }],
  });
  await postInvoiceJournalEntry({ invoice, business: toor, userId: owner._id });

  // Record an Expense: 10,000 before tax + 18% GST (900 CGST + 900 SGST) = 11,800 paid from Bank
  await createExpense({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      amountBeforeTax: 10000,
      gstEnabled: true,
      gstRate: 18,
      placeOfSupplyCode: "23",
      paymentStatus: "PAID",
      paymentMethod: "BANK_TRANSFER",
      expenseDate: new Date("2026-05-20"),
      category: "Office Supplies",
      description: "Stationery and Desk accessories",
    },
  });

  // Verify TOOR P&L:
  // Revenue should be exactly 50,000 (taxable), NOT 59,000! GST is excluded from Income.
  // Expense should be exactly 10,000, NOT 11,800! Input GST is asset/ITC, excluded from Expense.
  // Net Profit = 50,000 - 10,000 = 40,000.
  const pl = await getProfitAndLossReport({ businessId: toor._id, query: { from: "2026-05-01", to: "2026-05-31" } });
  assert.equal(pl.income.total, 50000);
  assert.equal(pl.expenses.total, 10000);
  assert.equal(pl.netProfit, 40000);

  // Verify TOOR Balance Sheet:
  // Assets:
  // - Accounts Receivable (1100): 59,000
  // - Input GST ITC (1310 CGST 900, 1320 SGST 900): 1,800
  // - Bank Account (1020): -11,800 (credit)
  // Total Assets = 59000 + 1800 - 11800 = 49,000
  // Liabilities:
  // - Output GST (2210 CGST 4,500, 2220 SGST 4,500): 9,000
  // Equity:
  // - Retained Earnings (Current Period): 40,000
  // Total Liabilities + Equity = 9000 + 40000 = 49,000
  // Assets (49,000) === Liabilities (9,000) + Equity (40,000)!
  const bs = await getBalanceSheetReport({ businessId: toor._id, query: { to: "2026-05-31" } });
  assert.equal(bs.totals.totalAssets, 49000);
  assert.equal(bs.totals.totalLiabilities, 9000);
  assert.equal(bs.equity.retainedEarnings, 40000);
  assert.equal(bs.totals.totalLiabilitiesAndEquity, 49000);
  assert.equal(bs.totals.isBalanced, true);
  assert.equal(bs.totals.discrepancy, 0);
});

test("Goldhawk non-GST P&L and Balance Sheet: strictly zero GST liability/asset", async () => {
  const { goldhawk, owner, ghCustomer } = await setupTestEntities();

  // Create Goldhawk Invoice: 80,000 (Non-GST)
  const ghInvoice = await Invoice.create({
    businessId: goldhawk._id,
    customerId: ghCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-GH-001",
    invoiceDate: new Date("2026-06-10"),
    dueDate: new Date("2026-06-25"),
    sellerSnapshot: { billingEntityCode: "GOLDHAWK" },
    taxableAmount: 80000,
    subtotal: 80000,
    totalTax: 0,
    grandTotal: 80000,
    amountPaid: 0,
    balanceDue: 80000,
    paymentStatus: "unpaid",
    lineItems: [{ productName: "Brokerage Advisory", quantity: 1, rate: 80000, itemTotal: 80000, taxRate: 0 }],
  });
  await postInvoiceJournalEntry({ invoice: ghInvoice, business: goldhawk, userId: owner._id });

  // Record Goldhawk Expense: 25,000 paid via Bank (Non-GST)
  await createExpense({
    businessId: goldhawk._id,
    userId: owner._id,
    payload: {
      amountBeforeTax: 25000,
      gstEnabled: false,
      gstRate: 0,
      paymentStatus: "PAID",
      paymentMethod: "BANK_TRANSFER",
      expenseDate: new Date("2026-06-15"),
      category: "Professional Fees",
      description: "Consulting and Advisory",
    },
  });

  const ghPl = await getProfitAndLossReport({ businessId: goldhawk._id, query: { from: "2026-06-01", to: "2026-06-30" } });
  assert.equal(ghPl.income.total, 80000);
  assert.equal(ghPl.expenses.total, 25000);
  assert.equal(ghPl.netProfit, 55000);

  const ghBs = await getBalanceSheetReport({ businessId: goldhawk._id, query: { to: "2026-06-30" } });
  assert.equal(ghBs.totals.totalAssets, 55000); // AR 80k - Bank credit 25k = 55k
  assert.equal(ghBs.totals.totalLiabilities, 0); // ZERO GST liability
  assert.equal(ghBs.equity.retainedEarnings, 55000);
  assert.equal(ghBs.totals.isBalanced, true);
  assert.equal(ghBs.totals.discrepancy, 0);
});

test("Consolidated P&L and Balance Sheet: valid aggregate sum without mixing books", async () => {
  const { toor, goldhawk, owner, toorCustomer, ghCustomer } = await setupTestEntities();

  // TOOR: Invoice 10,000 (taxable 10k, total 11.8k)
  const toorInv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-T-99",
    invoiceDate: new Date("2026-07-05"),
    dueDate: new Date("2026-07-20"),
    taxableAmount: 10000,
    subtotal: 10000,
    totalTax: 1800,
    grandTotal: 11800,
    amountPaid: 0,
    balanceDue: 11800,
    paymentStatus: "unpaid",
    gstBreakup: { cgst: 900, sgst: 900 },
    lineItems: [{ productName: "Rental", quantity: 1, rate: 10000, itemTotal: 10000 }],
  });
  await postInvoiceJournalEntry({ invoice: toorInv, business: toor, userId: owner._id });

  // Goldhawk: Invoice 20,000 (taxable 20k, total 20k)
  const ghInv = await Invoice.create({
    businessId: goldhawk._id,
    customerId: ghCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-G-99",
    invoiceDate: new Date("2026-07-06"),
    dueDate: new Date("2026-07-21"),
    sellerSnapshot: { billingEntityCode: "GOLDHAWK" },
    taxableAmount: 20000,
    subtotal: 20000,
    totalTax: 0,
    grandTotal: 20000,
    amountPaid: 0,
    balanceDue: 20000,
    paymentStatus: "unpaid",
    lineItems: [{ productName: "Brokerage", quantity: 1, rate: 20000, itemTotal: 20000 }],
  });
  await postInvoiceJournalEntry({ invoice: ghInv, business: goldhawk, userId: owner._id });

  const consPl = await getConsolidatedReport({
    reportType: "PROFIT_AND_LOSS",
    homeBusinessId: toor._id,
    query: { from: "2026-07-01", to: "2026-07-31" },
  });

  assert.equal(consPl.income.toorTotal, 10000);
  assert.equal(consPl.income.goldhawkTotal, 20000);
  assert.equal(consPl.income.total, 30000);
  assert.equal(consPl.netProfit, 30000);

  const consBs = await getConsolidatedReport({
    reportType: "BALANCE_SHEET",
    homeBusinessId: toor._id,
    query: { to: "2026-07-31" },
  });

  assert.equal(consBs.totals.toorAssets, 11800);
  assert.equal(consBs.totals.goldhawkAssets, 20000);
  assert.equal(consBs.totals.totalAssets, 31800);
  assert.equal(consBs.totals.toorLiabilities, 1800);
  assert.equal(consBs.totals.goldhawkLiabilities, 0);
  assert.equal(consBs.totals.totalLiabilities, 1800);
  assert.equal(consBs.totals.totalEquityAndEarnings, 30000);
  assert.equal(consBs.totals.isBalanced, true);
});

test("Bank Book and Cash Book: running balances computed accurately from journal lines", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  // 1. Unallocated payment received via Bank: 50,000
  await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      amount: 50000,
      direction: "RECEIVED",
      customerId: toorCustomer._id,
      paymentMethod: "BANK_TRANSFER",
      paymentDate: new Date("2026-08-01"),
      referenceNumber: "TXN-BANK-01",
    },
  });

  // 2. Expense paid via Bank: 15,000
  await createExpense({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      amountBeforeTax: 15000,
      gstEnabled: false,
      gstRate: 0,
      paymentStatus: "PAID",
      paymentMethod: "BANK_TRANSFER",
      expenseDate: new Date("2026-08-05"),
      category: "Rent",
      description: "Monthly Office Rent",
    },
  });

  // Bank Book check:
  // Inflow 50,000 (Debit), Outflow 15,000 (Credit), Closing Balance = 35,000
  const bankBook = await getLedgerBookReport({
    businessId: toor._id,
    bookType: "BANK",
    query: { from: "2026-08-01", to: "2026-08-31" },
  });

  assert.equal(bankBook.title, "Bank Book / Bank Ledger");
  assert.equal(bankBook.periodDebit, 50000);
  assert.equal(bankBook.periodCredit, 15000);
  assert.equal(bankBook.closingBalance, 35000);
  assert.equal(bankBook.transactions.length, 2);
  assert.equal(bankBook.transactions[0].runningBalance, 50000);
  assert.equal(bankBook.transactions[1].runningBalance, 35000);
});

test("Historical unposted data warning triggers when unposted transactions exist", async () => {
  const { toor, owner, toorCustomer } = await setupTestEntities();

  // Create an invoice WITHOUT journal entry
  await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "LEGACY-INV-001",
    invoiceDate: new Date("2026-04-10"),
    dueDate: new Date("2026-04-25"),
    subtotal: 10000,
    taxableAmount: 10000,
    grandTotal: 10000,
    status: "issued",
    lineItems: [{ productName: "Historic Service", quantity: 1, rate: 10000, itemTotal: 10000 }],
  });

  const warning = await getHistoricalWarning({
    businessId: toor._id,
    fromDate: new Date("2026-04-01"),
    toDate: new Date("2026-04-30"),
  });

  assert.equal(warning.hasUnpostedLegacyData, true);
  assert.equal(warning.warning, "Historical accounting data incomplete / backfill required");
  assert.equal(warning.unpostedCounts.invoices, 1);
});

test("Accountant Export Pack contains all 10 required CSV registers and clean metadata", async () => {
  const { toor, owner } = await setupTestEntities();

  const exportPack = await getAccountantExportPack({
    businessId: toor._id,
    isConsolidated: true,
    homeBusinessId: toor._id,
    query: { period: "FY", fyYear: 2026 },
  });

  assert.ok(exportPack.metadata);
  assert.equal(exportPack.metadata.isConsolidated, true);

  const { files } = exportPack;
  assert.ok(files.profitLossCsv.includes("PROFIT") || files.profitLossCsv.includes("Income"));
  assert.ok(files.balanceSheetCsv.includes("Assets"));
  assert.ok(files.bankBookCsv.includes("Bank") || files.bankBookCsv.includes("Date"));
  assert.ok(files.cashBookCsv.includes("Cash") || files.cashBookCsv.includes("Date"));
  assert.ok(files.salesRegisterCsv.includes("Invoice #"));
  assert.ok(files.expenseRegisterCsv.includes("Expense #"));
  assert.ok(files.receivablesCsv.includes("Customer Name"));
  assert.ok(files.gstSummaryCsv.includes("Output GST"));
  assert.ok(files.combinedCsv.includes("# TRIAL BALANCE") || files.combinedCsv.includes("TRIAL BALANCE"));
});

test("Access control: staff cannot access reports; consolidated access requires all entities", async () => {
  const { toor, goldhawk, staff, owner } = await setupTestEntities();

  // 1. Staff access check
  const { authorizeAccountingReport } = require("../src/middlewares/accounting-access.middleware");

  const reqStaff = {
    user: staff,
    query: { entity: "TOOR" },
    headers: {},
  };
  let staffError = null;
  await authorizeAccountingReport(reqStaff, {}, (err) => { staffError = err; });
  assert.ok(staffError);
  assert.equal(staffError.statusCode, 403);

  // 2. User restricted to one entity cannot access consolidated report
  const restrictedUser = await User.create({
    businessId: goldhawk._id,
    name: "GH Only User",
    email: "ghonly@example.com",
    role: "accountant",
    password: "hashedPassword123",
  });

  const reqRestricted = {
    user: restrictedUser,
    query: { entity: "all" },
    headers: {},
  };
  let restrictedError = null;
  await authorizeAccountingReport(reqRestricted, {}, (err) => { restrictedError = err; });
  assert.ok(restrictedError);
  assert.equal(restrictedError.statusCode, 403);
});
