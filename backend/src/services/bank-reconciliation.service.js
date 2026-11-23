const crypto = require("node:crypto");
const mongoose = require("mongoose");
const BankAccount = require("../models/BankAccount");
const BankStatementTransaction = require("../models/BankStatementTransaction");
const JournalEntry = require("../models/JournalEntry");
const Account = require("../models/Account");
const AppError = require("../utils/appError");
const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const { parseBankStatementCsv, parseBankStatementXlsx, parseBankStatementGrid, checkRunningBalances } = require("../utils/csv-parser");
const { statementPdfToGrid } = require("../utils/statement-pdf");
const { ensureDefaultAccounts } = require("./accounting.service");

/**
 * Import statement rows from CSV and store separately from financial journal.
 * Idempotent, duplicate-resistant via importFingerprint.
 */
const importBankStatementFile = async ({
  businessId,
  bankAccountId,
  csvText = "",
  fileBase64 = "",
  fileName = "",
  buffer = null,
  password = "",
  autoMatch = true,
  userId = null,
}) => {
  const account = await BankAccount.findOne({ _id: bankAccountId, businessId });
  if (!account) throw new AppError("Bank account not found for this billing entity", 404);

  let parsedRows = [];
  let source = "EXCEL_CSV";
  let unclear = "";
  const fileBuffer = buffer || (fileBase64 ? Buffer.from(fileBase64, "base64") : null);
  const isPdf = fileBuffer && (fileBuffer.subarray(0, 5).toString("ascii") === "%PDF-" || /\.pdf$/i.test(fileName));
  if (isPdf) {
    // The PDF's own text first (free); a scan goes to the document reader.
    let grid = await statementPdfToGrid(fileBuffer, { password });
    source = "PDF_TEXT";
    if (!grid) {
      if (password) throw new AppError("This PDF is a scan protected by a password. Download an unlocked copy, or the Excel / CSV statement.", 400);
      ({ grid, unclear } = await require("./statement-reader.service").readScannedStatement({ buffer: fileBuffer }));
      source = "PDF_READ_BY_AI";
    }
    parsedRows = parseBankStatementGrid({ rows: grid, bankAccountId });
  } else if (fileBuffer) {
    parsedRows = parseBankStatementXlsx({ buffer: fileBuffer, bankAccountId });
  } else if (csvText) {
    parsedRows = parseBankStatementCsv({ csvText, bankAccountId });
  } else {
    throw new AppError("Either csvText or fileBase64/buffer must be provided", 400);
  }

  if (parsedRows.length === 0) {
    throw new AppError("No valid transaction rows found in the statement file", 400);
  }

  const batchId = "BATCH-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");

  let importedCount = 0;
  let duplicateCount = 0;

  for (const row of parsedRows) {
    const existing = await BankStatementTransaction.findOne({
      businessId,
      bankAccountId: account._id,
      importFingerprint: row.importFingerprint,
    });
    if (existing) {
      duplicateCount++;
      continue;
    }

    try {
      await BankStatementTransaction.create([
        {
          businessId,
          bankAccountId: account._id,
          transactionDate: row.transactionDate,
          valueDate: row.valueDate,
          description: row.description,
          reference: row.reference,
          direction: row.direction,
          amount: row.amount,
          amountMinor: row.amountMinor,
          runningBalance: row.runningBalance,
          importBatchId: batchId,
          importFingerprint: row.importFingerprint,
          status: "UNMATCHED",
        },
      ]);
      importedCount++;
    } catch (err) {
      if (err.code === 11000) {
        duplicateCount++;
      } else {
        throw err;
      }
    }
  }

  // Suggest matches for the new rows, and match on their own the ones that can only be one entry.
  const { autoMatched = 0 } = (await generateMatchSuggestions({ businessId, bankAccountId, autoMatch })) || {};

  return {
    batchId,
    source,
    totalRows: parsedRows.length,
    importedCount,
    duplicateCount,
    skippedCount: duplicateCount,
    unresolvedCount: parsedRows.unresolvedCount || 0,
    balanceCheck: checkRunningBalances(parsedRows),
    autoMatched,
    unclear,
  };
};

const importBankStatementCsv = async (args) => {
  return importBankStatementFile(args);
};

/**
 * Generates match suggestions between statement rows and unreconciled journal lines.
 */
const generateMatchSuggestions = async ({ businessId, bankAccountId, autoMatch = false }) => {
  await ensureDefaultAccounts({ businessId });

  const bankAccountModel = await BankAccount.findOne({ _id: bankAccountId, businessId });
  if (!bankAccountModel) throw new AppError("Bank account not found", 404);

  // A credit card reconciles against what is owed on it (2060), a bank account against the bank (1020).
  const targetAccount = await Account.findOne({ businessId, code: bankAccountModel.accountType === "CREDIT_CARD" ? "2060" : "1020" });
  if (!targetAccount) return;

  const unmatchedTransactions = await BankStatementTransaction.find({
    businessId,
    bankAccountId,
    status: { $in: ["UNMATCHED", "SUGGESTED_MATCH"] },
  });

  if (unmatchedTransactions.length === 0) return;

  // Find all reconciled journal entry IDs for this entity to exclude them
  const reconciledEntries = await BankStatementTransaction.find({
    businessId,
    status: "MATCHED",
    reconciledJournalEntryId: { $ne: null },
  }).select("reconciledJournalEntryId");

  const reconciledIds = new Set(reconciledEntries.map((r) => r.reconciledJournalEntryId.toString()));

  // Fetch all posted journal entries containing Bank Account (1020)
  const candidateJournalEntries = await JournalEntry.find({
    businessId,
    status: "POSTED",
    _id: { $nin: Array.from(reconciledIds) },
    "lines.accountId": targetAccount._id,
  });

  const found = [];
  for (const stmt of unmatchedTransactions) {
    // Statement INFLOW (Deposit) matches Journal DEBIT on Bank (1020)
    // Statement OUTFLOW (Withdrawal) matches Journal CREDIT on Bank (1020)
    const matchingEntries = [];

    candidateJournalEntries.forEach((je) => {
      const bankLines = je.lines.filter((l) => l.accountId.toString() === targetAccount._id.toString());
      const debitMinor = bankLines.reduce((s, l) => s + l.debitMinor, 0);
      const creditMinor = bankLines.reduce((s, l) => s + l.creditMinor, 0);

      const isDirectionMatch =
        (stmt.direction === "INFLOW" && debitMinor > 0) ||
        (stmt.direction === "OUTFLOW" && creditMinor > 0);

      const jeAmountMinor = stmt.direction === "INFLOW" ? debitMinor : creditMinor;

      if (isDirectionMatch && jeAmountMinor === stmt.amountMinor) {
        // Calculate date proximity in days
        const diffDays = Math.abs(
          (new Date(stmt.transactionDate).getTime() - new Date(je.entryDate).getTime()) / (1000 * 60 * 60 * 24)
        );

        const refMatch =
          stmt.reference &&
          (je.sourceKey?.toLowerCase().includes(stmt.reference.toLowerCase()) ||
            je.description?.toLowerCase().includes(stmt.reference.toLowerCase()));

        let confidence = "MEDIUM";
        let matchReason = "Amount match within period";

        if (refMatch) {
          confidence = "EXACT";
          matchReason = "Exact reference (" + stmt.reference + ") and amount match";
        } else if (diffDays <= 3) {
          confidence = "HIGH";
          matchReason = "Amount match within " + Math.round(diffDays) + " days";
        }

        matchingEntries.push({
          journalEntryId: je._id,
          entryNumber: je.entryNumber,
          entryDate: je.entryDate,
          description: je.description,
          reference: je.sourceKey,
          amount: fromMinorUnits(jeAmountMinor),
          amountMinor: jeAmountMinor,
          confidence,
          matchReason,
        });
      }
    });

    found.push({ stmt, matchingEntries });
  }

  // Automatic match: the row has exactly one possible entry, by reference or within 3 days, and that
  // entry is not a candidate for any other row. Anything less certain stays a suggestion.
  const candidateCount = new Map();
  for (const { matchingEntries } of found) {
    for (const m of matchingEntries) candidateCount.set(String(m.journalEntryId), (candidateCount.get(String(m.journalEntryId)) || 0) + 1);
  }
  let autoMatched = 0;
  for (const { stmt, matchingEntries } of found) {
    const only = matchingEntries.length === 1 ? matchingEntries[0] : null;
    if (autoMatch && only && ["EXACT", "HIGH"].includes(only.confidence) && candidateCount.get(String(only.journalEntryId)) === 1 && !stmt.autoMatchRejected) {
      stmt.status = "MATCHED";
      stmt.reconciledJournalEntryId = only.journalEntryId;
      stmt.reconciledAt = new Date();
      stmt.reconciledBy = null;
      stmt.matchedAutomatically = true;
      stmt.suggestedMatches = matchingEntries;
      stmt.notes = `Matched automatically: ${only.matchReason}`;
      autoMatched++;
    } else if (matchingEntries.length > 0) {
      stmt.status = "SUGGESTED_MATCH";
      stmt.suggestedMatches = matchingEntries;
    } else {
      stmt.status = "UNMATCHED";
      stmt.suggestedMatches = [];
    }

    await stmt.save();
  }
  return { autoMatched };
};

/**
 * Confirm reconciliation match between a statement transaction and a journal entry.
 * Prevents double reconciliation.
 */
const confirmMatch = async ({
  businessId,
  bankTransactionId,
  journalEntryId,
  userId,
}) => {
  const stmt = await BankStatementTransaction.findOne({ _id: bankTransactionId, businessId });
  if (!stmt) throw new AppError("Bank statement transaction not found", 404);

  if (stmt.status === "MATCHED") {
    throw new AppError("This statement transaction is already matched", 400);
  }

  const je = await JournalEntry.findOne({ _id: journalEntryId, businessId, status: "POSTED" });
  if (!je) throw new AppError("Journal entry not found or not posted", 404);

  // Prevent same journal entry from being reconciled to another statement row
  const alreadyMatched = await BankStatementTransaction.findOne({
    businessId,
    _id: { $ne: stmt._id },
    reconciledJournalEntryId: je._id,
    status: "MATCHED",
  });

  if (alreadyMatched) {
    throw new AppError("This journal entry is already reconciled to another statement transaction", 400);
  }

  stmt.status = "MATCHED";
  stmt.reconciledJournalEntryId = je._id;
  stmt.reconciledAt = new Date();
  stmt.reconciledBy = userId;
  await stmt.save();

  return await BankStatementTransaction.findById(bankTransactionId);
};

/**
 * Unmatch a reconciled statement transaction.
 */
const unmatchTransaction = async ({ businessId, bankTransactionId, userId }) => {
  const stmt = await BankStatementTransaction.findOne({ _id: bankTransactionId, businessId });
  if (!stmt) throw new AppError("Bank statement transaction not found", 404);

  if (stmt.matchedAutomatically) stmt.autoMatchRejected = true;
  stmt.status = "UNMATCHED";
  stmt.reconciledJournalEntryId = null;
  stmt.reconciledLineId = "";
  stmt.reconciledAt = null;
  stmt.reconciledBy = null;
  stmt.matchedAutomatically = false;
  stmt.notes = "";
  await stmt.save();

  await generateMatchSuggestions({ businessId, bankAccountId: stmt.bankAccountId });
  return await BankStatementTransaction.findById(bankTransactionId);
};

/**
 * Bank Reconciliation Summary:
 * Computes statement closing balance, book ledger balance, reconciled balance,
 * unmatched amounts, and reconciliation difference without silently forcing to zero.
 */
const getReconciliationSummary = async ({ businessId, bankAccountId, asOfDate = new Date() }) => {
  const account = await BankAccount.findOne({ _id: bankAccountId, businessId });
  if (!account) throw new AppError("Bank account not found", 404);

  await ensureDefaultAccounts({ businessId });
  const targetAccount = await Account.findOne({ businessId, code: account.accountType === "CREDIT_CARD" ? "2060" : "1020" });

  const dateLimit = new Date(asOfDate);
  dateLimit.setHours(23, 59, 59, 999);

  // 1. Statement transactions up to asOfDate
  const allStmtTransactions = await BankStatementTransaction.find({
    businessId,
    bankAccountId,
    transactionDate: { $lte: dateLimit },
  }).sort("transactionDate createdAt");

  let stmtInflowMinor = 0;
  let stmtOutflowMinor = 0;
  let latestRunningBalance = null;

  let matchedCount = 0;
  let matchedAmountMinor = 0;
  let unmatchedCount = 0;
  let unmatchedAmountMinor = 0;

  allStmtTransactions.forEach((tx) => {
    if (tx.direction === "INFLOW") {
      stmtInflowMinor += tx.amountMinor;
    } else {
      stmtOutflowMinor += tx.amountMinor;
    }

    if (tx.runningBalance !== null && tx.runningBalance !== undefined) {
      latestRunningBalance = tx.runningBalance;
    }

    if (tx.status === "MATCHED") {
      matchedCount++;
      matchedAmountMinor += tx.amountMinor;
    } else {
      unmatchedCount++;
      unmatchedAmountMinor += tx.amountMinor;
    }
  });

  const statementCalculatedBalance = fromMinorUnits(
    toMinorUnits(account.openingBalance || 0, "Opening balance", { allowZero: true }) +
      (stmtInflowMinor - stmtOutflowMinor)
  );

  const statementClosingBalance =
    latestRunningBalance !== null ? latestRunningBalance : statementCalculatedBalance;

  // 2. Book balance from JournalEntry (Account 1020)
  const journalEntries = await JournalEntry.find({
    businessId,
    status: "POSTED",
    entryDate: { $lte: dateLimit },
    "lines.accountId": targetAccount._id,
  });

  let bookDebitMinor = 0;
  let bookCreditMinor = 0;

  const reconciledJeIds = new Set(
    allStmtTransactions.filter((t) => t.status === "MATCHED" && t.reconciledJournalEntryId).map((t) => t.reconciledJournalEntryId.toString())
  );

  let unreconciledBookCount = 0;
  let unreconciledBookMinor = 0;

  journalEntries.forEach((je) => {
    const lines = je.lines.filter((l) => l.accountId.toString() === targetAccount._id.toString());
    const d = lines.reduce((s, l) => s + l.debitMinor, 0);
    const c = lines.reduce((s, l) => s + l.creditMinor, 0);

    bookDebitMinor += d;
    bookCreditMinor += c;

    if (!reconciledJeIds.has(je._id.toString())) {
      unreconciledBookCount++;
      unreconciledBookMinor += Math.abs(d - c);
    }
  });

  const bookBalanceMinor = bookDebitMinor - bookCreditMinor;
  const bookBalance = fromMinorUnits(bookBalanceMinor);

  // 3. Difference (Book Balance vs Statement Balance)
  const stmtClosingMinor = toMinorUnits(statementClosingBalance, "Statement balance", { allowZero: true });
  const diffMinor = bookBalanceMinor - stmtClosingMinor;
  const difference = fromMinorUnits(diffMinor);
  const isReconciled = diffMinor === 0 && unmatchedCount === 0;

  return {
    bankAccount: {
      id: account._id,
      accountName: account.accountName,
      bankName: account.bankName,
      accountNumber: account.accountNumber,
    },
    asOfDate: dateLimit.toISOString().slice(0, 10),
    statementClosingBalance,
    bookBalance,
    reconciledBalance: fromMinorUnits(matchedAmountMinor),
    reconciliationDifference: difference,
    isReconciled,
    metrics: {
      matchedCount,
      matchedAmount: fromMinorUnits(matchedAmountMinor),
      unmatchedStatementCount: unmatchedCount,
      unmatchedStatementAmount: fromMinorUnits(unmatchedAmountMinor),
      unreconciledBookCount,
      unreconciledBookAmount: fromMinorUnits(unreconciledBookMinor),
    },
    transactions: allStmtTransactions,
  };
};

module.exports = {
  importBankStatementCsv,
  importBankStatementFile,
  generateMatchSuggestions,
  confirmMatch,
  unmatchTransaction,
  getReconciliationSummary,
};
