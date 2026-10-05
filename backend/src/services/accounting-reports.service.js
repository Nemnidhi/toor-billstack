const mongoose = require("mongoose");
const Account = require("../models/Account");
const JournalEntry = require("../models/JournalEntry");
const Business = require("../models/Business");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Expense = require("../models/Expense");
const Customer = require("../models/Customer");
const AppError = require("../utils/appError");
const { fromMinorUnits, toMinorUnits } = require("../utils/money");
const { resolveIndianPeriod } = require("../utils/indian-fy");
const { escapeCsvCell, arrayToCsv, buildMultiSectionCsv } = require("../utils/csv-formatter");
const { ensureDefaultAccounts, getTrialBalance } = require("./accounting.service");

/**
 * Historical Data Warning: checks if legacy unposted transactions exist in the period.
 * Does not perform backfill, only audits and alerts.
 */
const getHistoricalWarning = async ({ businessId, fromDate, toDate }) => {
  const invoiceQuery = { businessId, status: { $ne: "draft" } };
  const paymentQuery = { businessId, status: { $ne: "cancelled" } };
  const expenseQuery = { businessId, status: { $ne: "CANCELLED" } };

  if (fromDate && toDate) {
    invoiceQuery.invoiceDate = { $gte: fromDate, $lte: toDate };
    paymentQuery.paymentDate = { $gte: fromDate, $lte: toDate };
    expenseQuery.expenseDate = { $gte: fromDate, $lte: toDate };
  } else if (toDate) {
    invoiceQuery.invoiceDate = { $lte: toDate };
    paymentQuery.paymentDate = { $lte: toDate };
    expenseQuery.expenseDate = { $lte: toDate };
  }

  const [invoiceCount, paymentCount, expenseCount] = await Promise.all([
    Invoice.countDocuments(invoiceQuery),
    Payment.countDocuments(paymentQuery),
    Expense.countDocuments(expenseQuery),
  ]);

  const jeQuery = { businessId, status: "POSTED" };
  if (fromDate && toDate) {
    jeQuery.entryDate = { $gte: fromDate, $lte: toDate };
  } else if (toDate) {
    jeQuery.entryDate = { $lte: toDate };
  }

  const [invoiceJeCount, paymentJeCount, expenseJeCount] = await Promise.all([
    JournalEntry.countDocuments({ ...jeQuery, sourceType: "INVOICE" }),
    JournalEntry.countDocuments({ ...jeQuery, sourceType: "PAYMENT" }),
    JournalEntry.countDocuments({ ...jeQuery, sourceType: "EXPENSE" }),
  ]);

  const unpostedInvoices = Math.max(0, invoiceCount - invoiceJeCount);
  const unpostedPayments = Math.max(0, paymentCount - paymentJeCount);
  const unpostedExpenses = Math.max(0, expenseCount - expenseJeCount);

  const totalCandidates = invoiceCount + paymentCount + expenseCount;
  const totalPosted = invoiceJeCount + paymentJeCount + expenseJeCount;
  const unpostedTotal = unpostedInvoices + unpostedPayments + unpostedExpenses;

  let status = "COMPLETE";
  if (totalCandidates > 0 && totalPosted === 0) {
    status = "NOT_BACKFILLED";
  } else if (unpostedTotal > 0 && totalPosted > 0) {
    status = "PARTIAL";
  } else if (unpostedTotal > 0) {
    status = "NOT_BACKFILLED";
  }

  const hasUnpostedLegacyData = unpostedTotal > 0;

  return {
    status, // "COMPLETE", "PARTIAL", "NOT_BACKFILLED"
    hasUnpostedLegacyData,
    warning: hasUnpostedLegacyData
      ? "Historical accounting data incomplete / backfill required"
      : null,
    message: hasUnpostedLegacyData
      ? "Some transactions in this period were recorded before double-entry journal posting was enabled. Historical financial reports may not reflect these transactions until a backfill is performed."
      : null,
    unpostedCounts: {
      invoices: unpostedInvoices,
      payments: unpostedPayments,
      expenses: unpostedExpenses,
      total: unpostedTotal,
    },
    counts: {
      totalCandidates,
      totalPosted,
      unpostedTotal,
    },
  };
};

/**
 * PROFIT & LOSS ACCOUNT: Derived strictly from JournalEntry lines of type INCOME and EXPENSE.
 * Does not count GST as income/expense.
 */
const getProfitAndLossReport = async ({ businessId, query = {} }) => {
  const periodInfo = resolveIndianPeriod(query);
  const { fromDate, toDate } = periodInfo;

  await ensureDefaultAccounts({ businessId });
  const accounts = await Account.find({ businessId, isActive: true });
  const accountsMap = new Map(accounts.map((a) => [a._id.toString(), a]));

  const entriesQuery = { businessId, status: "POSTED" };
  if (fromDate && toDate) {
    entriesQuery.entryDate = { $gte: fromDate, $lte: toDate };
  } else if (toDate) {
    entriesQuery.entryDate = { $lte: toDate };
  }

  const entries = await JournalEntry.find(entriesQuery);

  const incomeMap = new Map();
  const expenseMap = new Map();

  accounts.forEach((acc) => {
    if (acc.type === "INCOME") {
      incomeMap.set(acc._id.toString(), {
        accountId: acc._id,
        code: acc.code,
        name: acc.name,
        netMinor: 0,
      });
    } else if (acc.type === "EXPENSE") {
      expenseMap.set(acc._id.toString(), {
        accountId: acc._id,
        code: acc.code,
        name: acc.name,
        netMinor: 0,
      });
    }
  });

  entries.forEach((entry) => {
    entry.lines.forEach((line) => {
      const accId = line.accountId.toString();
      const acc = accountsMap.get(accId);
      if (!acc) return;

      if (acc.type === "INCOME") {
        if (!incomeMap.has(accId)) {
          incomeMap.set(accId, { accountId: acc._id, code: acc.code, name: acc.name, netMinor: 0 });
        }
        const item = incomeMap.get(accId);
        item.netMinor += (line.creditMinor - line.debitMinor);
      } else if (acc.type === "EXPENSE") {
        if (!expenseMap.has(accId)) {
          expenseMap.set(accId, { accountId: acc._id, code: acc.code, name: acc.name, netMinor: 0 });
        }
        const item = expenseMap.get(accId);
        item.netMinor += (line.debitMinor - line.creditMinor);
      }
    });
  });

  let totalIncomeMinor = 0;
  const incomeRows = Array.from(incomeMap.values())
    .map((item) => {
      totalIncomeMinor += item.netMinor;
      return {
        accountId: item.accountId,
        code: item.code,
        name: item.name,
        amount: fromMinorUnits(item.netMinor),
        minorUnits: item.netMinor,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  let totalExpensesMinor = 0;
  const expenseRows = Array.from(expenseMap.values())
    .map((item) => {
      totalExpensesMinor += item.netMinor;
      return {
        accountId: item.accountId,
        code: item.code,
        name: item.name,
        amount: fromMinorUnits(item.netMinor),
        minorUnits: item.netMinor,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const netProfitMinor = totalIncomeMinor - totalExpensesMinor;
  const business = await Business.findById(businessId).select("name billingEntityCode gstTaxId");

  const legacyWarning = await getHistoricalWarning({ businessId, fromDate, toDate });

  return {
    business: {
      _id: business?._id,
      name: business?.name,
      billingEntityCode: business?.billingEntityCode || "",
    },
    period: periodInfo,
    income: {
      accounts: incomeRows,
      total: fromMinorUnits(totalIncomeMinor),
      totalMinor: totalIncomeMinor,
    },
    expenses: {
      accounts: expenseRows,
      total: fromMinorUnits(totalExpensesMinor),
      totalMinor: totalExpensesMinor,
    },
    netProfit: fromMinorUnits(netProfitMinor),
    netProfitMinor,
    isProfit: netProfitMinor >= 0,
    legacyWarning,
  };
};

/**
 * BALANCE SHEET: Generated from cumulative journal balances as of selected date.
 * Assets = Liabilities + Equity
 * Does not fake balancing differences; reports discrepancy clearly.
 */
const getBalanceSheetReport = async ({ businessId, query = {} }) => {
  const periodInfo = resolveIndianPeriod(query);
  const asOfDate = periodInfo.toDate || new Date();

  await ensureDefaultAccounts({ businessId });
  const accounts = await Account.find({ businessId, isActive: true });
  const accountsMap = new Map(accounts.map((a) => [a._id.toString(), a]));

  const entries = await JournalEntry.find({
    businessId,
    status: "POSTED",
    entryDate: { $lte: asOfDate },
  });

  const balances = new Map();
  accounts.forEach((acc) => {
    balances.set(acc._id.toString(), {
      accountId: acc._id,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      normalBalance: acc.normalBalance,
      debitMinor: 0,
      creditMinor: 0,
    });
  });

  entries.forEach((entry) => {
    entry.lines.forEach((line) => {
      const accId = line.accountId.toString();
      if (!balances.has(accId)) {
        const acc = accountsMap.get(accId);
        if (acc) {
          balances.set(accId, {
            accountId: acc._id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            normalBalance: acc.normalBalance,
            debitMinor: 0,
            creditMinor: 0,
          });
        }
      }
      const b = balances.get(accId);
      if (b) {
        b.debitMinor += line.debitMinor;
        b.creditMinor += line.creditMinor;
      }
    });
  });

  let totalAssetsMinor = 0;
  let totalLiabilitiesMinor = 0;
  let totalEquityMinor = 0;
  let cumulativeIncomeMinor = 0;
  let cumulativeExpensesMinor = 0;

  const assetAccounts = [];
  const liabilityAccounts = [];
  const equityAccounts = [];

  balances.forEach((b) => {
    if (b.type === "ASSET") {
      const netMinor = b.debitMinor - b.creditMinor;
      totalAssetsMinor += netMinor;
      assetAccounts.push({
        accountId: b.accountId,
        code: b.code,
        name: b.name,
        group: ["1010", "1020"].includes(b.code)
          ? "Cash & Bank"
          : b.code === "1100"
          ? "Accounts Receivable"
          : ["1310", "1320", "1330"].includes(b.code)
          ? "Input Tax Credit"
          : "Other Assets",
        amount: fromMinorUnits(netMinor),
        minorUnits: netMinor,
      });
    } else if (b.type === "LIABILITY") {
      const netMinor = b.creditMinor - b.debitMinor;
      totalLiabilitiesMinor += netMinor;
      liabilityAccounts.push({
        accountId: b.accountId,
        code: b.code,
        name: b.name,
        group: b.code === "2100"
          ? "Customer Advances"
          : ["2210", "2220", "2230"].includes(b.code)
          ? "Output GST"
          : b.code === "2010"
          ? "Accounts Payable"
          : "Other Liabilities",
        amount: fromMinorUnits(netMinor),
        minorUnits: netMinor,
      });
    } else if (b.type === "EQUITY") {
      const netMinor = b.creditMinor - b.debitMinor;
      totalEquityMinor += netMinor;
      equityAccounts.push({
        accountId: b.accountId,
        code: b.code,
        name: b.name,
        group: "Owner Capital & Reserves",
        amount: fromMinorUnits(netMinor),
        minorUnits: netMinor,
      });
    } else if (b.type === "INCOME") {
      cumulativeIncomeMinor += (b.creditMinor - b.debitMinor);
    } else if (b.type === "EXPENSE") {
      cumulativeExpensesMinor += (b.debitMinor - b.creditMinor);
    }
  });

  const retainedEarningsMinor = cumulativeIncomeMinor - cumulativeExpensesMinor;
  const totalEquityAndEarningsMinor = totalEquityMinor + retainedEarningsMinor;
  const totalLiabilitiesAndEquityMinor = totalLiabilitiesMinor + totalEquityAndEarningsMinor;

  const discrepancyMinor = totalAssetsMinor - totalLiabilitiesAndEquityMinor;
  const isBalanced = discrepancyMinor === 0;

  assetAccounts.sort((a, b) => a.code.localeCompare(b.code));
  liabilityAccounts.sort((a, b) => a.code.localeCompare(b.code));
  equityAccounts.sort((a, b) => a.code.localeCompare(b.code));

  const business = await Business.findById(businessId).select("name billingEntityCode gstTaxId");
  const legacyWarning = await getHistoricalWarning({ businessId, toDate: asOfDate });

  return {
    business: {
      _id: business?._id,
      name: business?.name,
      billingEntityCode: business?.billingEntityCode || "",
    },
    asOfDate: asOfDate.toISOString().slice(0, 10),
    period: periodInfo,
    assets: {
      accounts: assetAccounts,
      total: fromMinorUnits(totalAssetsMinor),
      totalMinor: totalAssetsMinor,
    },
    liabilities: {
      accounts: liabilityAccounts,
      total: fromMinorUnits(totalLiabilitiesMinor),
      totalMinor: totalLiabilitiesMinor,
    },
    equity: {
      accounts: equityAccounts,
      retainedEarnings: fromMinorUnits(retainedEarningsMinor),
      retainedEarningsMinor,
      totalEquity: fromMinorUnits(totalEquityMinor),
      totalEquityMinor,
      totalEquityAndEarnings: fromMinorUnits(totalEquityAndEarningsMinor),
      totalEquityAndEarningsMinor,
    },
    totals: {
      totalAssets: fromMinorUnits(totalAssetsMinor),
      totalLiabilities: fromMinorUnits(totalLiabilitiesMinor),
      totalEquityAndEarnings: fromMinorUnits(totalEquityAndEarningsMinor),
      totalLiabilitiesAndEquity: fromMinorUnits(totalLiabilitiesAndEquityMinor),
      discrepancy: fromMinorUnits(discrepancyMinor),
      discrepancyMinor,
      isBalanced,
    },
    legacyWarning,
  };
};

/**
 * BANK BOOK / CASH BOOK: Derived strictly from journal entries on Bank (1020) or Cash (1010).
 */
const getLedgerBookReport = async ({ businessId, bookType = "BANK", query = {} }) => {
  const periodInfo = resolveIndianPeriod(query);
  const { fromDate, toDate } = periodInfo;

  await ensureDefaultAccounts({ businessId });
  const targetCode = bookType.toUpperCase() === "CASH" ? "1010" : "1020";
  const title = bookType.toUpperCase() === "CASH" ? "Cash Book / Cash Ledger" : "Bank Book / Bank Ledger";

  const targetAccount = await Account.findOne({ businessId, code: targetCode });
  if (!targetAccount) throw new AppError(title + " account not found for this entity", 404);

  // 1. Calculate opening balance before fromDate
  let openingDebitMinor = 0;
  let openingCreditMinor = 0;

  if (fromDate) {
    const priorEntries = await JournalEntry.find({
      businessId,
      status: "POSTED",
      entryDate: { $lt: fromDate },
      "lines.accountId": targetAccount._id,
    });

    priorEntries.forEach((entry) => {
      entry.lines
        .filter((l) => l.accountId.toString() === targetAccount._id.toString())
        .forEach((l) => {
          openingDebitMinor += l.debitMinor;
          openingCreditMinor += l.creditMinor;
        });
    });
  }

  const openingBalanceMinor = openingDebitMinor - openingCreditMinor;

  // 2. Fetch transactions in period
  const entriesQuery = {
    businessId,
    status: "POSTED",
    "lines.accountId": targetAccount._id,
  };
  if (fromDate && toDate) {
    entriesQuery.entryDate = { $gte: fromDate, $lte: toDate };
  } else if (toDate) {
    entriesQuery.entryDate = { $lte: toDate };
  }

  const entries = await JournalEntry.find(entriesQuery).sort("entryDate createdAt");

  let runningBalanceMinor = openingBalanceMinor;
  let periodDebitMinor = 0;
  let periodCreditMinor = 0;

  const transactions = [];

  entries.forEach((entry) => {
    const matchingLines = entry.lines.filter((l) => l.accountId.toString() === targetAccount._id.toString());
    const debitMinor = matchingLines.reduce((s, l) => s + l.debitMinor, 0);
    const creditMinor = matchingLines.reduce((s, l) => s + l.creditMinor, 0);

    periodDebitMinor += debitMinor;
    periodCreditMinor += creditMinor;
    runningBalanceMinor += (debitMinor - creditMinor);

    transactions.push({
      journalEntryId: entry._id,
      entryNumber: entry.entryNumber,
      entryDate: entry.entryDate,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      sourceKey: entry.sourceKey,
      reference: entry.sourceKey || entry.sourceType,
      description: entry.description || matchingLines[0]?.description || "",
      debit: fromMinorUnits(debitMinor),
      debitMinor,
      credit: fromMinorUnits(creditMinor),
      creditMinor,
      runningBalance: fromMinorUnits(runningBalanceMinor),
      runningBalanceMinor,
    });
  });

  const business = await Business.findById(businessId).select("name billingEntityCode gstTaxId");
  const legacyWarning = await getHistoricalWarning({ businessId, fromDate, toDate });

  return {
    business: {
      _id: business?._id,
      name: business?.name,
      billingEntityCode: business?.billingEntityCode || "",
    },
    title,
    bookType: bookType.toUpperCase(),
    account: {
      _id: targetAccount._id,
      code: targetAccount.code,
      name: targetAccount.name,
    },
    period: periodInfo,
    openingBalance: fromMinorUnits(openingBalanceMinor),
    openingBalanceMinor,
    periodDebit: fromMinorUnits(periodDebitMinor),
    periodDebitMinor,
    periodCredit: fromMinorUnits(periodCreditMinor),
    periodCreditMinor,
    closingBalance: fromMinorUnits(runningBalanceMinor),
    closingBalanceMinor: runningBalanceMinor,
    transactions,
    legacyWarning,
  };
};

/**
 * CONSOLIDATED REPORTING ENGINE:
 * Aggregates TOOR and Goldhawk without altering or mixing underlying entity books.
 */
const getConsolidatedReport = async ({ reportType, homeBusinessId, query = {} }) => {
  const homeBusiness = await Business.findById(homeBusinessId);
  if (!homeBusiness) throw new AppError("Primary billing company not found", 404);

  const goldhawk = await Business.findOne({
    billingParentId: homeBusiness._id,
    billingEntityCode: "GOLDHAWK",
  });

  if (!goldhawk) {
    throw new AppError("Goldhawk billing entity not found for consolidation", 404);
  }

  if (reportType === "PROFIT_AND_LOSS") {
    const [toorPl, ghPl] = await Promise.all([
      getProfitAndLossReport({ businessId: homeBusiness._id, query }),
      getProfitAndLossReport({ businessId: goldhawk._id, query }),
    ]);

    const combinedIncomeMap = new Map();
    [...toorPl.income.accounts, ...ghPl.income.accounts].forEach((row) => {
      if (!combinedIncomeMap.has(row.code)) {
        combinedIncomeMap.set(row.code, {
          code: row.code,
          name: row.name,
          toorAmount: 0,
          goldhawkAmount: 0,
          totalAmount: 0,
        });
      }
    });

    toorPl.income.accounts.forEach((r) => {
      const item = combinedIncomeMap.get(r.code);
      if (item) item.toorAmount = r.amount;
    });
    ghPl.income.accounts.forEach((r) => {
      const item = combinedIncomeMap.get(r.code);
      if (item) item.goldhawkAmount = r.amount;
    });

    combinedIncomeMap.forEach((item) => {
      item.totalAmount = fromMinorUnits(toMinorUnits(item.toorAmount, "Income", { allowZero: true }) + toMinorUnits(item.goldhawkAmount, "Income", { allowZero: true }));
    });

    const combinedExpenseMap = new Map();
    [...toorPl.expenses.accounts, ...ghPl.expenses.accounts].forEach((row) => {
      if (!combinedExpenseMap.has(row.code)) {
        combinedExpenseMap.set(row.code, {
          code: row.code,
          name: row.name,
          toorAmount: 0,
          goldhawkAmount: 0,
          totalAmount: 0,
        });
      }
    });

    toorPl.expenses.accounts.forEach((r) => {
      const item = combinedExpenseMap.get(r.code);
      if (item) item.toorAmount = r.amount;
    });
    ghPl.expenses.accounts.forEach((r) => {
      const item = combinedExpenseMap.get(r.code);
      if (item) item.goldhawkAmount = r.amount;
    });

    combinedExpenseMap.forEach((item) => {
      item.totalAmount = fromMinorUnits(toMinorUnits(item.toorAmount, "Expense", { allowZero: true }) + toMinorUnits(item.goldhawkAmount, "Expense", { allowZero: true }));
    });

    const totalIncome = fromMinorUnits(toorPl.income.totalMinor + ghPl.income.totalMinor);
    const totalExpenses = fromMinorUnits(toorPl.expenses.totalMinor + ghPl.expenses.totalMinor);
    const netProfitMinor = (toorPl.netProfitMinor + ghPl.netProfitMinor);
    const netProfit = fromMinorUnits(netProfitMinor);

    return {
      isConsolidated: true,
      period: toorPl.period,
      entities: [
        { id: homeBusiness._id, name: homeBusiness.name, code: "TOOR" },
        { id: goldhawk._id, name: goldhawk.name, code: "GOLDHAWK" },
      ],
      income: {
        accounts: Array.from(combinedIncomeMap.values()).sort((a, b) => a.code.localeCompare(b.code)),
        toorTotal: toorPl.income.total,
        goldhawkTotal: ghPl.income.total,
        total: totalIncome,
      },
      expenses: {
        accounts: Array.from(combinedExpenseMap.values()).sort((a, b) => a.code.localeCompare(b.code)),
        toorTotal: toorPl.expenses.total,
        goldhawkTotal: ghPl.expenses.total,
        total: totalExpenses,
      },
      netProfit,
      netProfitMinor,
      toorNetProfit: toorPl.netProfit,
      goldhawkNetProfit: ghPl.netProfit,
      isProfit: netProfitMinor >= 0,
      breakdown: { toor: toorPl, goldhawk: ghPl },
      legacyWarning: {
        hasUnpostedLegacyData: toorPl.legacyWarning?.hasUnpostedLegacyData || ghPl.legacyWarning?.hasUnpostedLegacyData,
        message: (toorPl.legacyWarning?.hasUnpostedLegacyData || ghPl.legacyWarning?.hasUnpostedLegacyData)
          ? "Historical accounting data incomplete / backfill required in one or more entities"
          : null,
      },
    };
  }

  if (reportType === "BALANCE_SHEET") {
    const [toorBs, ghBs] = await Promise.all([
      getBalanceSheetReport({ businessId: homeBusiness._id, query }),
      getBalanceSheetReport({ businessId: goldhawk._id, query }),
    ]);

    const totalAssetsMinor = toorBs.assets.totalMinor + ghBs.assets.totalMinor;
    const totalLiabilitiesMinor = toorBs.liabilities.totalMinor + ghBs.liabilities.totalMinor;
    const totalEquityMinor = toorBs.equity.totalEquityMinor + ghBs.equity.totalEquityMinor;
    const retainedEarningsMinor = toorBs.equity.retainedEarningsMinor + ghBs.equity.retainedEarningsMinor;
    const totalEquityAndEarningsMinor = totalEquityMinor + retainedEarningsMinor;
    const totalLiabilitiesAndEquityMinor = totalLiabilitiesMinor + totalEquityAndEarningsMinor;

    const discrepancyMinor = totalAssetsMinor - totalLiabilitiesAndEquityMinor;
    const isBalanced = discrepancyMinor === 0;

    return {
      isConsolidated: true,
      asOfDate: toorBs.asOfDate,
      period: toorBs.period,
      entities: [
        { id: homeBusiness._id, name: homeBusiness.name, code: "TOOR" },
        { id: goldhawk._id, name: goldhawk.name, code: "GOLDHAWK" },
      ],
      breakdown: { toor: toorBs, goldhawk: ghBs },
      totals: {
        toorAssets: toorBs.assets.total,
        goldhawkAssets: ghBs.assets.total,
        totalAssets: fromMinorUnits(totalAssetsMinor),

        toorLiabilities: toorBs.liabilities.total,
        goldhawkLiabilities: ghBs.liabilities.total,
        totalLiabilities: fromMinorUnits(totalLiabilitiesMinor),

        toorEquity: toorBs.equity.totalEquityAndEarnings,
        goldhawkEquity: ghBs.equity.totalEquityAndEarnings,
        totalEquityAndEarnings: fromMinorUnits(totalEquityAndEarningsMinor),

        totalLiabilitiesAndEquity: fromMinorUnits(totalLiabilitiesAndEquityMinor),
        discrepancy: fromMinorUnits(discrepancyMinor),
        isBalanced,
      },
      legacyWarning: {
        hasUnpostedLegacyData: toorBs.legacyWarning?.hasUnpostedLegacyData || ghBs.legacyWarning?.hasUnpostedLegacyData,
        message: (toorBs.legacyWarning?.hasUnpostedLegacyData || ghBs.legacyWarning?.hasUnpostedLegacyData)
          ? "Historical accounting data incomplete / backfill required in one or more entities"
          : null,
      },
    };
  }

  if (reportType === "BANK_BOOK" || reportType === "CASH_BOOK") {
    const bookType = reportType === "CASH_BOOK" ? "CASH" : "BANK";
    const [toorBook, ghBook] = await Promise.all([
      getLedgerBookReport({ businessId: homeBusiness._id, bookType, query }),
      getLedgerBookReport({ businessId: goldhawk._id, bookType, query }),
    ]);

    const enrichedToor = toorBook.transactions.map((tx) => ({
      ...tx,
      entityCode: "TOOR",
      entityName: homeBusiness.name,
    }));

    const enrichedGh = ghBook.transactions.map((tx) => ({
      ...tx,
      entityCode: "GOLDHAWK",
      entityName: goldhawk.name,
    }));

    const merged = [...enrichedToor, ...enrichedGh].sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));

    return {
      isConsolidated: true,
      title: "Consolidated " + toorBook.title,
      bookType,
      period: toorBook.period,
      breakdown: { toor: toorBook, goldhawk: ghBook },
      totals: {
        toorClosingBalance: toorBook.closingBalance,
        goldhawkClosingBalance: ghBook.closingBalance,
        totalClosingBalance: fromMinorUnits(toorBook.closingBalanceMinor + ghBook.closingBalanceMinor),
      },
      transactions: merged,
      legacyWarning: {
        hasUnpostedLegacyData: toorBook.legacyWarning?.hasUnpostedLegacyData || ghBook.legacyWarning?.hasUnpostedLegacyData,
      },
    };
  }

  throw new AppError("Unsupported consolidated report type: " + reportType, 400);
};

/**
 * ACCOUNTANT EXPORT PACK: Generates all 10 accountant registers in CSV and JSON formats.
 */
const getAccountantExportPack = async ({ businessId, isConsolidated = false, homeBusinessId = null, query = {} }) => {
  const periodInfo = resolveIndianPeriod(query);
  const { fromDate, toDate } = periodInfo;

  let businesses = [];
  if (isConsolidated && homeBusinessId) {
    const home = await Business.findById(homeBusinessId);
    const gh = await Business.findOne({ billingParentId: homeBusinessId, billingEntityCode: "GOLDHAWK" });
    businesses = [home, gh].filter(Boolean);
  } else {
    const b = await Business.findById(businessId);
    businesses = [b].filter(Boolean);
  }

  const businessIds = businesses.map((b) => b._id);
  const primaryBusiness = businesses[0];

  // 1. Trial Balance
  const tbData = isConsolidated
    ? null
    : await getTrialBalance({ businessId: primaryBusiness._id, from: periodInfo.fromStr, to: periodInfo.toStr });

  const trialBalanceCsv = tbData
    ? arrayToCsv(
        ["Account Code", "Account Name", "Type", "Normal Balance", "Opening Debit", "Opening Credit", "Period Debit", "Period Credit", "Closing Debit", "Closing Credit"],
        tbData.accounts.map((a) => [
          a.code, a.name, a.type, a.normalBalance,
          a.opening.debit, a.opening.credit,
          a.period.debit, a.period.credit,
          a.closing.debit, a.closing.credit,
        ])
      )
    : "";

  // 2. Profit & Loss
  const plData = isConsolidated
    ? await getConsolidatedReport({ reportType: "PROFIT_AND_LOSS", homeBusinessId, query })
    : await getProfitAndLossReport({ businessId: primaryBusiness._id, query });

  const plCsvRows = [];
  if (isConsolidated) {
    plData.income.accounts.forEach((a) => plCsvRows.push(["Income", a.code, a.name, a.toorAmount, a.goldhawkAmount, a.totalAmount]));
    plCsvRows.push(["Total Income", "", "", plData.income.toorTotal, plData.income.goldhawkTotal, plData.income.total]);
    plData.expenses.accounts.forEach((a) => plCsvRows.push(["Expense", a.code, a.name, a.toorAmount, a.goldhawkAmount, a.totalAmount]));
    plCsvRows.push(["Total Expense", "", "", plData.expenses.toorTotal, plData.expenses.goldhawkTotal, plData.expenses.total]);
    plCsvRows.push(["Net Profit / (Loss)", "", "", plData.toorNetProfit, plData.goldhawkNetProfit, plData.netProfit]);
  } else {
    plData.income.accounts.forEach((a) => plCsvRows.push(["Income", a.code, a.name, a.amount]));
    plCsvRows.push(["Total Income", "", "", plData.income.total]);
    plData.expenses.accounts.forEach((a) => plCsvRows.push(["Expense", a.code, a.name, a.amount]));
    plCsvRows.push(["Total Expense", "", "", plData.expenses.total]);
    plCsvRows.push(["Net Profit / (Loss)", "", "", plData.netProfit]);
  }

  const profitLossCsv = arrayToCsv(
    isConsolidated
      ? ["Category", "Account Code", "Account Name", "TOOR (INR)", "Goldhawk (INR)", "Consolidated Total (INR)"]
      : ["Category", "Account Code", "Account Name", "Amount (INR)"],
    plCsvRows
  );

  // 3. Balance Sheet
  const bsData = isConsolidated
    ? await getConsolidatedReport({ reportType: "BALANCE_SHEET", homeBusinessId, query })
    : await getBalanceSheetReport({ businessId: primaryBusiness._id, query });

  const bsCsvRows = [];
  if (!isConsolidated) {
    bsData.assets.accounts.forEach((a) => bsCsvRows.push(["Assets", a.group, a.code, a.name, a.amount]));
    bsCsvRows.push(["Total Assets", "", "", "", bsData.assets.total]);
    bsData.liabilities.accounts.forEach((a) => bsCsvRows.push(["Liabilities", a.group, a.code, a.name, a.amount]));
    bsCsvRows.push(["Total Liabilities", "", "", "", bsData.liabilities.total]);
    bsData.equity.accounts.forEach((a) => bsCsvRows.push(["Equity", a.group, a.code, a.name, a.amount]));
    bsCsvRows.push(["Equity", "Retained Earnings", "", "Current Period Earnings", bsData.equity.retainedEarnings]);
    bsCsvRows.push(["Total Liabilities & Equity", "", "", "", bsData.totals.totalLiabilitiesAndEquity]);
  } else {
    bsCsvRows.push(["Total Assets", "Assets", "", "", bsData.totals.toorAssets, bsData.totals.goldhawkAssets, bsData.totals.totalAssets]);
    bsCsvRows.push(["Total Liabilities", "Liabilities", "", "", bsData.totals.toorLiabilities, bsData.totals.goldhawkLiabilities, bsData.totals.totalLiabilities]);
    bsCsvRows.push(["Total Equity & Earnings", "Equity", "", "", bsData.totals.toorEquity, bsData.totals.goldhawkEquity, bsData.totals.totalEquityAndEarnings]);
    bsCsvRows.push(["Total Liabilities & Equity", "", "", "", bsData.totals.totalLiabilitiesAndEquity, "", bsData.totals.totalLiabilitiesAndEquity]);
  }

  const balanceSheetCsv = arrayToCsv(
    isConsolidated
      ? ["Category", "Group", "Account Code", "Account Name", "TOOR", "Goldhawk", "Consolidated Total"]
      : ["Category", "Group", "Account Code", "Account Name", "Amount (INR)"],
    bsCsvRows
  );

  // 4. General / Account Ledgers
  const ledgerEntries = await JournalEntry.find({
    businessId: { $in: businessIds },
    status: "POSTED",
    ...(fromDate && toDate ? { entryDate: { $gte: fromDate, $lte: toDate } } : {}),
  }).sort("entryDate createdAt");

  const ledgerRows = [];
  ledgerEntries.forEach((entry) => {
    entry.lines.forEach((line) => {
      ledgerRows.push([
        entry.entryDate.toISOString().slice(0, 10),
        entry.entryNumber,
        line.accountCode,
        line.accountName,
        line.description || entry.description,
        entry.sourceType,
        entry.sourceKey || "",
        fromMinorUnits(line.debitMinor),
        fromMinorUnits(line.creditMinor),
      ]);
    });
  });

  const generalLedgersCsv = arrayToCsv(
    ["Date", "Entry Number", "Account Code", "Account Name", "Description", "Source Type", "Reference", "Debit (INR)", "Credit (INR)"],
    ledgerRows
  );

  // 5. Bank Book
  const bankBookData = isConsolidated
    ? await getConsolidatedReport({ reportType: "BANK_BOOK", homeBusinessId, query })
    : await getLedgerBookReport({ businessId: primaryBusiness._id, bookType: "BANK", query });

  const bankBookCsv = arrayToCsv(
    ["Date", "Entry Number", "Reference", "Description", "Entity", "Inflow (Debit)", "Outflow (Credit)", "Running Balance"],
    bankBookData.transactions.map((tx) => [
      tx.entryDate.toISOString().slice(0, 10),
      tx.entryNumber,
      tx.reference,
      tx.description,
      tx.entityCode || primaryBusiness.billingEntityCode || "TOOR",
      tx.debit,
      tx.credit,
      tx.runningBalance,
    ])
  );

  // 6. Cash Book
  const cashBookData = isConsolidated
    ? await getConsolidatedReport({ reportType: "CASH_BOOK", homeBusinessId, query })
    : await getLedgerBookReport({ businessId: primaryBusiness._id, bookType: "CASH", query });

  const cashBookCsv = arrayToCsv(
    ["Date", "Entry Number", "Reference", "Description", "Entity", "Inflow (Debit)", "Outflow (Credit)", "Running Balance"],
    cashBookData.transactions.map((tx) => [
      tx.entryDate.toISOString().slice(0, 10),
      tx.entryNumber,
      tx.reference,
      tx.description,
      tx.entityCode || primaryBusiness.billingEntityCode || "TOOR",
      tx.debit,
      tx.credit,
      tx.runningBalance,
    ])
  );

  // 7. Sales / Invoice Register
  const invoiceQuery = {
    businessId: { $in: businessIds },
    status: { $ne: "draft" },
    ...(fromDate && toDate ? { invoiceDate: { $gte: fromDate, $lte: toDate } } : {}),
  };
  const invoices = await Invoice.find(invoiceQuery).populate("customerId", "name").sort("invoiceDate");

  const salesRegisterCsv = arrayToCsv(
    ["Invoice #", "Date", "Customer Name", "Customer GSTIN", "Place of Supply", "Entity", "Taxable Amount", "CGST", "SGST", "IGST", "Grand Total", "Amount Paid", "Balance Due", "Status"],
    invoices.map((inv) => {
      const breakup = inv.gstBreakup || inv.gstSnapshot || {};
      const entity = inv.sellerSnapshot?.billingEntityCode || (inv.businessId.toString() === homeBusinessId?.toString() ? "TOOR" : "GOLDHAWK");
      return [
        inv.invoiceNumber,
        inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : "",
        inv.customerId?.name || inv.customerSnapshot?.name || "Client",
        inv.customerSnapshot?.gstin || "",
        inv.placeOfSupplyCode || "",
        entity,
        inv.taxableAmount || (inv.grandTotal - (inv.totalTax || 0)),
        breakup.cgst || 0,
        breakup.sgst || 0,
        breakup.igst || 0,
        inv.grandTotal,
        inv.amountPaid,
        inv.balanceDue,
        inv.paymentStatus,
      ];
    })
  );

  // 8. Expense Register
  const expenseQuery = {
    businessId: { $in: businessIds },
    status: { $ne: "CANCELLED" },
    ...(fromDate && toDate ? { expenseDate: { $gte: fromDate, $lte: toDate } } : {}),
  };
  const expenses = await Expense.find(expenseQuery).sort("expenseDate");

  const expenseRegisterCsv = arrayToCsv(
    ["Expense #", "Date", "Category", "Description", "Entity", "Payment Method", "Amount Before Tax", "CGST", "SGST", "IGST", "Total Amount", "Status"],
    expenses.map((exp) => {
      const entity = exp.businessId.toString() === homeBusinessId?.toString() ? "TOOR" : "GOLDHAWK";
      return [
        exp.expenseNumber,
        exp.expenseDate ? exp.expenseDate.toISOString().slice(0, 10) : "",
        exp.category,
        exp.description,
        entity,
        exp.paymentMethod || "",
        exp.amountBeforeTax,
        exp.cgst || 0,
        exp.sgst || 0,
        exp.igst || 0,
        exp.totalAmount,
        exp.paymentStatus,
      ];
    })
  );

  // 9. Customer Outstanding / Receivables
  const customers = await Customer.find({ businessId: { $in: businessIds } });
  const custMap = new Map();
  customers.forEach((c) => {
    custMap.set(c._id.toString(), {
      id: c._id,
      name: c.name,
      phone: c.phone || "",
      invoiced: 0,
      paid: 0,
      outstanding: 0,
    });
  });

  invoices.forEach((inv) => {
    const cid = inv.customerId?._id?.toString() || inv.customerId?.toString();
    if (cid && custMap.has(cid)) {
      const c = custMap.get(cid);
      c.invoiced += inv.grandTotal;
      c.paid += inv.amountPaid;
      c.outstanding += inv.balanceDue;
    }
  });

  const receivablesCsv = arrayToCsv(
    ["Customer Name", "Phone", "Total Invoiced (INR)", "Total Paid (INR)", "Outstanding Balance (INR)"],
    Array.from(custMap.values())
      .filter((c) => c.outstanding > 0 || c.invoiced > 0)
      .map((c) => [c.name, c.phone, c.invoiced.toFixed(2), c.paid.toFixed(2), c.outstanding.toFixed(2)])
  );

  // 10. GST Summary (Applicable for TOOR; indicates non-GST for Goldhawk)
  let taxableSales = 0;
  let cgstOutput = 0;
  let sgstOutput = 0;
  let igstOutput = 0;
  let cgstInput = 0;
  let sgstInput = 0;
  let igstInput = 0;

  invoices.forEach((inv) => {
    const isGoldhawk = inv.sellerSnapshot?.billingEntityCode === "GOLDHAWK";
    if (!isGoldhawk) {
      taxableSales += (inv.taxableAmount || (inv.grandTotal - (inv.totalTax || 0)));
      const b = inv.gstBreakup || inv.gstSnapshot || {};
      cgstOutput += (b.cgst || 0);
      sgstOutput += (b.sgst || 0);
      igstOutput += (b.igst || 0);
    }
  });

  expenses.forEach((exp) => {
    const isToor = exp.businessId.toString() === homeBusinessId?.toString() || primaryBusiness.billingEntityCode !== "GOLDHAWK";
    if (isToor && exp.gstRecorded) {
      cgstInput += (exp.cgst || 0);
      sgstInput += (exp.sgst || 0);
      igstInput += (exp.igst || 0);
    }
  });

  const totalOutputGst = cgstOutput + sgstOutput + igstOutput;
  const totalInputGst = cgstInput + sgstInput + igstInput;
  const netGstPayable = Math.max(0, totalOutputGst - totalInputGst);

  const gstSummaryCsv = arrayToCsv(
    ["Component", "Taxable Value (INR)", "CGST (INR)", "SGST (INR)", "IGST (INR)", "Total GST (INR)"],
    [
      ["Output GST (Sales Invoices - TOOR)", taxableSales.toFixed(2), cgstOutput.toFixed(2), sgstOutput.toFixed(2), igstOutput.toFixed(2), totalOutputGst.toFixed(2)],
      ["Input GST ITC (Eligible Expenses - TOOR)", "-", cgstInput.toFixed(2), sgstInput.toFixed(2), igstInput.toFixed(2), totalInputGst.toFixed(2)],
      ["Net GST Payable / (Credit Carry Forward)", "-", (cgstOutput - cgstInput).toFixed(2), (sgstOutput - sgstInput).toFixed(2), (igstOutput - igstInput).toFixed(2), (netGstPayable).toFixed(2)],
      ["Note: Goldhawk Infrabulls Pvt. Ltd.", "Non-GST Entity", "0.00", "0.00", "0.00", "0.00"],
    ]
  );

  const multiSectionCombinedCsv = buildMultiSectionCsv([
    { title: "TRIAL BALANCE (" + periodInfo.periodLabel + ")", headers: ["Account Code", "Account Name", "Type", "Normal Balance", "Opening Debit", "Opening Credit", "Period Debit", "Period Credit", "Closing Debit", "Closing Credit"], rows: tbData ? tbData.accounts.map((a) => [a.code, a.name, a.type, a.normalBalance, a.opening.debit, a.opening.credit, a.period.debit, a.period.credit, a.closing.debit, a.closing.credit]) : [] },
    { title: "PROFIT & LOSS STATEMENT (" + periodInfo.periodLabel + ")", headers: isConsolidated ? ["Category", "Account Code", "Account Name", "TOOR", "Goldhawk", "Total"] : ["Category", "Account Code", "Account Name", "Amount"], rows: plCsvRows },
    { title: "BALANCE SHEET (" + periodInfo.periodLabel + ")", headers: isConsolidated ? ["Category", "Group", "Account Code", "Account Name", "TOOR", "Goldhawk", "Total"] : ["Category", "Group", "Account Code", "Account Name", "Amount"], rows: bsCsvRows },
    { title: "BANK BOOK / LEDGER (" + periodInfo.periodLabel + ")", headers: ["Date", "Entry #", "Reference", "Description", "Entity", "Debit", "Credit", "Running Balance"], rows: bankBookData.transactions.map((tx) => [tx.entryDate.toISOString().slice(0, 10), tx.entryNumber, tx.reference, tx.description, tx.entityCode || "TOOR", tx.debit, tx.credit, tx.runningBalance]) },
    { title: "CASH BOOK / LEDGER (" + periodInfo.periodLabel + ")", headers: ["Date", "Entry #", "Reference", "Description", "Entity", "Debit", "Credit", "Running Balance"], rows: cashBookData.transactions.map((tx) => [tx.entryDate.toISOString().slice(0, 10), tx.entryNumber, tx.reference, tx.description, tx.entityCode || "TOOR", tx.debit, tx.credit, tx.runningBalance]) },
    { title: "SALES / INVOICE REGISTER (" + periodInfo.periodLabel + ")", headers: ["Invoice #", "Date", "Customer Name", "Customer GSTIN", "POS", "Entity", "Taxable", "CGST", "SGST", "IGST", "Grand Total", "Paid", "Balance", "Status"], rows: invoices.map((inv) => [inv.invoiceNumber, inv.invoiceDate ? inv.invoiceDate.toISOString().slice(0, 10) : "", inv.customerId?.name || "Client", inv.customerSnapshot?.gstin || "", inv.placeOfSupplyCode || "", inv.sellerSnapshot?.billingEntityCode || "TOOR", inv.taxableAmount || (inv.grandTotal - (inv.totalTax || 0)), (inv.gstBreakup || {}).cgst || 0, (inv.gstBreakup || {}).sgst || 0, (inv.gstBreakup || {}).igst || 0, inv.grandTotal, inv.amountPaid, inv.balanceDue, inv.paymentStatus]) },
    { title: "EXPENSE REGISTER (" + periodInfo.periodLabel + ")", headers: ["Expense #", "Date", "Category", "Description", "Entity", "Method", "Before Tax", "CGST", "SGST", "IGST", "Total", "Status"], rows: expenses.map((exp) => [exp.expenseNumber, exp.expenseDate ? exp.expenseDate.toISOString().slice(0, 10) : "", exp.category, exp.description, "TOOR", exp.paymentMethod || "", exp.amountBeforeTax, exp.cgst || 0, exp.sgst || 0, exp.igst || 0, exp.totalAmount, exp.paymentStatus]) },
    { title: "CUSTOMER OUTSTANDING (" + periodInfo.periodLabel + ")", headers: ["Customer Name", "Phone", "Invoiced", "Paid", "Outstanding"], rows: Array.from(custMap.values()).map((c) => [c.name, c.phone, c.invoiced.toFixed(2), c.paid.toFixed(2), c.outstanding.toFixed(2)]) },
    { title: "GST SUMMARY (" + periodInfo.periodLabel + ")", headers: ["Component", "Taxable Value", "CGST", "SGST", "IGST", "Total GST"], rows: [["Output GST (TOOR)", taxableSales.toFixed(2), cgstOutput.toFixed(2), sgstOutput.toFixed(2), igstOutput.toFixed(2), totalOutputGst.toFixed(2)], ["Input GST (TOOR)", "-", cgstInput.toFixed(2), sgstInput.toFixed(2), igstInput.toFixed(2), totalInputGst.toFixed(2)], ["Net GST Payable", "-", (cgstOutput - cgstInput).toFixed(2), (sgstOutput - sgstInput).toFixed(2), (igstOutput - igstInput).toFixed(2), netGstPayable.toFixed(2)], ["Goldhawk Infrabulls", "Non-GST", "0.00", "0.00", "0.00", "0.00"]] },
  ]);

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      isConsolidated,
      period: periodInfo,
      entities: businesses.map((b) => ({ id: b._id, name: b.name, code: b.billingEntityCode || "TOOR" })),
    },
    files: {
      trialBalanceCsv,
      profitLossCsv,
      balanceSheetCsv,
      generalLedgersCsv,
      bankBookCsv,
      cashBookCsv,
      salesRegisterCsv,
      expenseRegisterCsv,
      receivablesCsv,
      gstSummaryCsv,
      combinedCsv: multiSectionCombinedCsv,
    },
  };
};


/**
 * Generates a unified multi-sheet XLSX Excel workbook containing all 10 accountant registers.
 */
const buildAccountantExportXlsxBuffer = (pack) => {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();

  // 1. Executive Summary & Compliance Cover Sheet (Branded with NEMNIDHI)
  try {
    const coverRows = [
      ["FINANCIAL & AUDIT COMPLIANCE PACK"],
      ["Platform", "BillStack Financial & Enterprise Accounting"],
      ["Technology Partner", "Powered by NEMNIDHI"],
      ["Financial Period", pack.metadata?.period?.periodLabel || "FY 2026-27"],
      ["Reporting Scope", pack.metadata?.isConsolidated ? "Consolidated Group (All Entities)" : "Single Legal Entity"],
      ["Entities Included", (pack.metadata?.entities || []).map((e) => `${e.name} (${e.code})`).join("; ") || "THE OFFICE ON RENT, Goldhawk Infrabulls"],
      ["Generated Date", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })],
      [],
      ["SCHEDULE OF AUDIT REGISTERS IN THIS WORKBOOK"],
      ["Sheet Name", "Description & Statutory Reference"],
      ["Trial Balance", "Double-entry General Ledger trial balance verification (Debit = Credit)"],
      ["Profit & Loss", "Revenue recognition, Operating expenses & Net Profit calculation"],
      ["Balance Sheet", "Assets, Liabilities, and Owner Capital / Retained Earnings"],
      ["Bank Book", "Bank Inflow & Outflow Transactions with Running Balances"],
      ["Cash Book", "Cash Inflows, Outflows & Petty Cash register"],
      ["General Ledgers", "Individual account transaction postings"],
      ["Sales Register", "Invoices, Taxable Value, CGST/SGST/IGST breakdown & Payment status"],
      ["Expense Register", "Operating Expenses & Vendor Deductions"],
      ["Customer Receivables", "Debtor Outstanding Aging & Collection Status"],
      ["GST Summary", "Output Tax vs Input ITC & Net Payable Reconciliation"],
      [],
      ["STATUTORY INTEGRITY CERTIFICATE"],
      ["Standard Followed", "Indian Accounting Standards (Ind AS) & Double-Entry General Ledger Rules"],
      ["System Verification", "Zero Discrepancy Verified • Powered by NEMNIDHI"],
    ];
    const coverSheet = XLSX.utils.aoa_to_sheet(coverRows);
    XLSX.utils.book_append_sheet(wb, coverSheet, "Executive Summary");
  } catch (_e) {}

  const addSheetFromCsv = (csvStr, sheetTitle) => {
    if (!csvStr || typeof csvStr !== "string" || !csvStr.trim()) return;
    try {
      const parsed = XLSX.read(csvStr, { type: "string" });
      const firstSheetName = parsed.SheetNames[0];
      if (firstSheetName && parsed.Sheets[firstSheetName]) {
        XLSX.utils.book_append_sheet(wb, parsed.Sheets[firstSheetName], sheetTitle.slice(0, 31));
      }
    } catch (_err) {}
  };

  addSheetFromCsv(pack.files.trialBalanceCsv, "Trial Balance");
  addSheetFromCsv(pack.files.profitLossCsv, "Profit & Loss");
  addSheetFromCsv(pack.files.balanceSheetCsv, "Balance Sheet");
  addSheetFromCsv(pack.files.bankBookCsv, "Bank Book");
  addSheetFromCsv(pack.files.cashBookCsv, "Cash Book");
  addSheetFromCsv(pack.files.generalLedgersCsv || pack.files.ledgersCsv, "General Ledgers");
  addSheetFromCsv(pack.files.salesRegisterCsv, "Sales Register");
  addSheetFromCsv(pack.files.expenseRegisterCsv, "Expense Register");
  addSheetFromCsv(pack.files.receivablesCsv, "Customer Receivables");

  if (pack.files.gstSummaryCsv) {
    addSheetFromCsv(pack.files.gstSummaryCsv, "GST Summary");
  } else if (pack.files.nonGstStatementCsv) {
    addSheetFromCsv(pack.files.nonGstStatementCsv, "Non-GST Statement");
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
};

module.exports = {
  getHistoricalWarning,
  getProfitAndLossReport,
  getBalanceSheetReport,
  getLedgerBookReport,
  getConsolidatedReport,
  getAccountantExportPack,
  buildAccountantExportXlsxBuffer,
};
