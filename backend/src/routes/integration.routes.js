const express = require("express");

const {
  consumeInvoiceHandoff,
  createIntegrationCredential,
  ingestOrder,
  listIntegrationCredentials,
  listIntegrationEvents,
  requestInvoiceHandoff,
  revokeIntegrationCredential,
  upsertCustomer,
} = require("../controllers/integration.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const integrationAuthMiddleware = require("../middlewares/integration-auth.middleware");
const { permit } = require("../middlewares/role.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");

const router = express.Router();

router.post("/orders", integrationAuthMiddleware, ingestOrder);
router.post("/customers/upsert", integrationAuthMiddleware, upsertCustomer);
router.post("/handoffs/invoice", integrationAuthMiddleware, requestInvoiceHandoff);
router.post("/payroll/runs", integrationAuthMiddleware, require("../controllers/payroll.controller").receiveRun);
router.get("/payroll/runs/:runId", integrationAuthMiddleware, require("../controllers/payroll.controller").runStatusForCrm);
router.get("/handoffs/invoice/:token", authMiddleware, tenantMiddleware, permit("owner", "admin", "staff", "accountant"), consumeInvoiceHandoff);

router.use(authMiddleware, tenantMiddleware, permit("owner", "admin"));
router.get("/credentials", listIntegrationCredentials);
router.post("/credentials", createIntegrationCredential);
router.post("/credentials/:credentialId/revoke", revokeIntegrationCredential);
router.get("/events", listIntegrationEvents);

module.exports = router;
