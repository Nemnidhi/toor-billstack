const express = require("express");
const {
  getAccountLedger,
  getAccounts,
  getJournalEntries,
  getTrialBalance,
  postManualJournalEntry,
} = require("../controllers/accounting.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { permit } = require("../middlewares/role.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");

const router = express.Router();
router.use(authMiddleware, tenantMiddleware, requireActiveSubscription());

router.get("/accounts", getAccounts);
router.get("/trial-balance", getTrialBalance);
router.get("/account-ledger", getAccountLedger);
router.get("/account-ledger/:accountId", getAccountLedger);
router.get("/journal-entries", getJournalEntries);
router.post("/journal-entries/manual", permit("owner", "admin", "accountant"), postManualJournalEntry);

module.exports = router;
