const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const BankAccount = require("../models/BankAccount");
const backfillService = require("../services/accounting-backfill.service");
const reconciliationService = require("../services/bank-reconciliation.service");

/**
 * Controller: Historical Backfill (Dry Run or Execute)
 */
// Sum two backfill results so "All companies" reports one combined outcome.
const mergeBackfillResults = (results) => {
  const add = (target, source) => {
    Object.entries(source || {}).forEach(([key, value]) => {
      if (typeof value === "number") target[key] = (target[key] || 0) + value;
      else if (value && typeof value === "object") add((target[key] = target[key] || {}), value);
    });
    return target;
  };
  return {
    ...results[0],
    business: { id: null, name: results.map((row) => row.business?.name).filter(Boolean).join(" + "), code: "ALL" },
    summary: results.reduce((acc, row) => add(acc, row.summary), {}),
    breakdown: results.reduce((acc, row) => add(acc, row.breakdown), {}),
    unresolvedItems: results.flatMap((row) => (row.unresolvedItems || []).map((item) => ({ ...item, entity: row.business?.name }))),
    entities: results,
  };
};

const runBackfill = asyncHandler(async (req, res) => {
  const { businessId, isConsolidated, groupEntities = [] } = req.accountingScope;
  const { mode = "DRY_RUN", fromDate, toDate } = req.body;
  const run = (id) => backfillService.runHistoricalBackfill({ businessId: id, userId: req.user._id, mode, fromDate, toDate });

  if (isConsolidated) {
    const results = [];
    for (const entity of groupEntities) results.push(await run(entity._id));
    return res.status(200).json({ success: true, data: mergeBackfillResults(results) });
  }

  res.status(200).json({ success: true, data: await run(businessId) });
});

/**
 * Controller: Post Opening Balances
 */
const postOpeningBalances = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const { effectiveDate, description, lines } = req.body;

  const entry = await backfillService.postOpeningBalances({
    businessId,
    userId: req.user._id,
    effectiveDate,
    description,
    lines,
  });

  res.status(201).json({ success: true, data: entry });
});

/**
 * Controller: Bank Accounts List
 */
const getBankAccounts = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const accounts = await BankAccount.find({ businessId, isActive: true }).sort("createdAt");
  res.status(200).json({ success: true, data: accounts });
});

/**
 * Controller: Create Bank Account
 */
const createBankAccount = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const {
    accountName,
    bankName,
    accountNumber,
    ifscCode,
    branchName,
    accountType,
    currency,
    openingBalance,
    openingBalanceDate,
  } = req.body;

  if (!accountName || !bankName || !accountNumber) {
    throw new AppError("Account name, bank name, and account number are required", 400);
  }

  const [account] = await BankAccount.create([
    {
      businessId,
      accountName,
      bankName,
      accountNumber,
      ifscCode,
      branchName,
      accountType,
      currency,
      openingBalance: openingBalance || 0,
      openingBalanceDate,
    },
  ]);

  res.status(201).json({ success: true, data: account });
});

/**
 * Controller: Update Bank Account
 */
const updateBankAccount = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const { id } = req.params;

  const account = await BankAccount.findOneAndUpdate(
    { _id: id, businessId },
    { $set: req.body },
    { new: true, runValidators: true }
  );

  if (!account) throw new AppError("Bank account not found", 404);
  res.status(200).json({ success: true, data: account });
});

/**
 * Controller: Import Bank Statement CSV
 */
const importBankStatement = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const { bankAccountId, csvText, fileBase64, fileName } = req.body;

  if (!bankAccountId) {
    throw new AppError("bankAccountId is required", 400);
  }
  if (!csvText && !fileBase64) {
    throw new AppError("Either csvText or fileBase64 is required", 400);
  }

  const result = await reconciliationService.importBankStatementFile({
    businessId,
    bankAccountId,
    csvText,
    fileBase64,
    fileName,
  });

  res.status(200).json({ success: true, data: result });
});

/**
 * Controller: Get Bank Reconciliation Summary & Transactions
 */
const getReconciliation = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const { bankAccountId, asOfDate } = req.query;

  if (!bankAccountId) {
    throw new AppError("bankAccountId query parameter is required", 400);
  }

  const summary = await reconciliationService.getReconciliationSummary({
    businessId,
    bankAccountId,
    asOfDate,
  });

  res.status(200).json({ success: true, data: summary });
});

/**
 * Controller: Confirm Reconciliation Match
 */
const confirmReconciliationMatch = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const { bankTransactionId, journalEntryId } = req.body;

  if (!bankTransactionId || !journalEntryId) {
    throw new AppError("bankTransactionId and journalEntryId are required", 400);
  }

  const matched = await reconciliationService.confirmMatch({
    businessId,
    bankTransactionId,
    journalEntryId,
    userId: req.user._id,
  });

  res.status(200).json({ success: true, data: matched });
});

/**
 * Controller: Unmatch Statement Transaction
 */
const unmatchReconciliation = asyncHandler(async (req, res) => {
  const { businessId } = req.accountingScope;
  const { bankTransactionId } = req.body;

  if (!bankTransactionId) {
    throw new AppError("bankTransactionId is required", 400);
  }

  const unmatched = await reconciliationService.unmatchTransaction({
    businessId,
    bankTransactionId,
    userId: req.user._id,
  });

  res.status(200).json({ success: true, data: unmatched });
});

module.exports = {
  runBackfill,
  postOpeningBalances,
  getBankAccounts,
  createBankAccount,
  updateBankAccount,
  importBankStatement,
  getReconciliation,
  confirmReconciliationMatch,
  unmatchReconciliation,
};
