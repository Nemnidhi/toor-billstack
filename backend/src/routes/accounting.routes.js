const express = require("express");
const {
  getAccountLedger,
  getAccounts,
  getJournalEntries,
  getTrialBalance,
  postManualJournalEntry,
} = require("../controllers/accounting.controller");
const {
  getProfitAndLoss,
  getBalanceSheet,
  getBankBook,
  getCashBook,
  getHistoricalWarning,
  exportAccountantPack,
} = require("../controllers/accounting-reports.controller");
const {
  runBackfill,
  postOpeningBalances,
  getBankAccounts,
  createBankAccount,
  updateBankAccount,
  importBankStatement,
  getReconciliation,
  confirmReconciliationMatch,
  unmatchReconciliation,
} = require("../controllers/bank-reconciliation.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { permit } = require("../middlewares/role.middleware");
const { authorizeAccountingReport } = require("../middlewares/accounting-access.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");

const router = express.Router();
router.use(authMiddleware, tenantMiddleware, requireActiveSubscription());

// Core Chart of Accounts & General Ledger
router.get("/accounts", permit("owner", "admin", "accountant"), getAccounts);
router.get("/trial-balance", permit("owner", "admin", "accountant"), getTrialBalance);
router.get("/account-ledger", permit("owner", "admin", "accountant"), getAccountLedger);
router.get("/account-ledger/:accountId", permit("owner", "admin", "accountant"), getAccountLedger);
router.get("/journal-entries", permit("owner", "admin", "accountant"), getJournalEntries);
router.post("/journal-entries/manual", permit("owner", "admin", "accountant"), postManualJournalEntry);

// Accountant Financial Reports (Entity-scoped, Consolidated, Indian FY & Export)
router.get("/reports/profit-loss", authorizeAccountingReport, getProfitAndLoss);
router.get("/reports/balance-sheet", authorizeAccountingReport, getBalanceSheet);
router.get("/reports/bank-book", authorizeAccountingReport, getBankBook);
router.get("/reports/cash-book", authorizeAccountingReport, getCashBook);
router.get("/reports/historical-warning", authorizeAccountingReport, getHistoricalWarning);
router.get("/reports/export-pack", authorizeAccountingReport, exportAccountantPack);

// Historical Accounting Backfill & Opening Balances
router.post("/backfill", authorizeAccountingReport, runBackfill);
router.post("/opening-balances", authorizeAccountingReport, postOpeningBalances);

// Bank Accounts Management
router.get("/bank-accounts", authorizeAccountingReport, getBankAccounts);
router.post("/bank-accounts", authorizeAccountingReport, createBankAccount);
router.put("/bank-accounts/:id", authorizeAccountingReport, updateBankAccount);

// Bank Statement Import & Reconciliation
router.post("/bank-statements/import", authorizeAccountingReport, importBankStatement);
router.get("/bank-reconciliation", authorizeAccountingReport, getReconciliation);
router.post("/bank-reconciliation/match", authorizeAccountingReport, confirmReconciliationMatch);
router.post("/bank-reconciliation/unmatch", authorizeAccountingReport, unmatchReconciliation);

module.exports = router;
