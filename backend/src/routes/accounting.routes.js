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
  getCentres,
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
const tds = require("../controllers/tds.controller");
const controls = require("../controllers/controls.controller");
const yearEnd = require("../controllers/year-end.controller");
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
router.get("/centres", getCentres);
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

// TDS: deducted by customers (receivable, 26AS) and deducted by us (payable, challans, returns)
router.get("/tds/meta", tds.getMeta);
router.get("/tds/receivable", authorizeAccountingReport, tds.getReceivable);
router.patch("/tds/receivable/:id", authorizeAccountingReport, tds.updateReceivable);
router.post("/tds/26as/import", authorizeAccountingReport, tds.import26as);
router.get("/tds/payable", authorizeAccountingReport, tds.getPayable);
router.get("/tds/challans", authorizeAccountingReport, tds.getChallans);
router.post("/tds/challans", authorizeAccountingReport, tds.createChallan);
router.post("/tds/challans/:id/cancel", authorizeAccountingReport, tds.cancelChallan);
router.get("/tds/form140", authorizeAccountingReport, tds.getForm140);
router.get("/tds/form131", authorizeAccountingReport, tds.getForm131);

// Controls: period lock, edit log (rule 3(1) audit trail), Goldhawk GST registration watch
router.get("/period-lock", authorizeAccountingReport, controls.getPeriodLock);
router.put("/period-lock", authorizeAccountingReport, controls.setPeriodLock);
router.get("/edit-log", authorizeAccountingReport, controls.getEditLog);
router.get("/edit-log/export", authorizeAccountingReport, controls.exportEditLog);
// Year end: deposits, fixed assets and depreciation, Schedule III, MSME 45-day, GSTR-9, Tally
router.get("/deposits", authorizeAccountingReport, yearEnd.listDeposits);
router.post("/deposits", authorizeAccountingReport, yearEnd.createDeposit);
router.post("/deposits/:id/movements", authorizeAccountingReport, yearEnd.moveDeposit);
router.post("/deposits/:id/cancel", authorizeAccountingReport, yearEnd.cancelDeposit);
router.get("/fixed-assets/classes", yearEnd.assetClasses);
router.get("/fixed-assets", authorizeAccountingReport, yearEnd.listAssets);
router.post("/fixed-assets", authorizeAccountingReport, yearEnd.createAsset);
router.get("/fixed-assets/register", authorizeAccountingReport, yearEnd.assetRegister);
router.get("/fixed-assets/it-blocks", authorizeAccountingReport, yearEnd.itBlocks);
router.post("/fixed-assets/depreciation", authorizeAccountingReport, yearEnd.runDepreciation);
router.post("/fixed-assets/:id/dispose", authorizeAccountingReport, yearEnd.disposeAsset);
router.post("/fixed-assets/:id/cancel", authorizeAccountingReport, yearEnd.cancelAsset);
router.get("/year-end/schedule-iii", authorizeAccountingReport, yearEnd.scheduleIII);
router.get("/year-end/msme", authorizeAccountingReport, yearEnd.msme);
router.get("/year-end/gstr9", authorizeAccountingReport, yearEnd.gstr9);
router.get("/year-end/tally", authorizeAccountingReport, yearEnd.tally);
router.get("/goldhawk-watch", permit("owner", "admin", "accountant"), controls.getGoldhawkWatch);

module.exports = router;
