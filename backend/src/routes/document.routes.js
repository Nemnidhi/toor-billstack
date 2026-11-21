const express = require("express");
const controls = require("../controllers/controls.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");
const { permit } = require("../middlewares/role.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const { validateObjectIdParam } = require("../middlewares/object-id.middleware");

// Documents attached to purchases, expenses and suppliers (bills, receipts, agreements).
const router = express.Router();
router.use(authMiddleware, tenantMiddleware, requireActiveSubscription());

const record = "/:recordType(purchase|expense|supplier)/:recordId";
router.get("/agreements/expiring", controls.getExpiringAgreements);
router.post(record, permit("owner", "admin", "staff", "accountant"), validateObjectIdParam("recordId"), controls.addDocument);
router.get(`${record}/:attachmentId`, validateObjectIdParam("recordId"), validateObjectIdParam("attachmentId"), controls.downloadDocument);
router.delete(`${record}/:attachmentId`, permit("owner", "admin", "accountant"), validateObjectIdParam("recordId"), validateObjectIdParam("attachmentId"), controls.removeDocument);

module.exports = router;
