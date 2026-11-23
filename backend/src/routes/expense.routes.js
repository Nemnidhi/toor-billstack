const express = require("express");
const controller = require("../controllers/expense.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const { requireModule } = require("../middlewares/module-guard.middleware");
const { validateObjectIdParam } = require("../middlewares/object-id.middleware");
const { permit } = require("../middlewares/role.middleware");

const router = express.Router();

router.use(authMiddleware, tenantMiddleware, requireActiveSubscription(), requireModule("expenses"));

router.get("/", controller.list);
router.get("/summary", controller.summary);
router.get("/categories", controller.categories);
router.get("/read-bill", controller.readBillStatus);
router.post("/read-bill", permit("owner", "admin", "staff", "accountant"), controller.readBill);
router.get("/:expenseId", validateObjectIdParam("expenseId"), controller.detail);
router.post("/", permit("owner", "admin", "staff", "accountant"), controller.create);
router.put("/:expenseId", validateObjectIdParam("expenseId"), permit("owner", "admin", "accountant"), controller.update);
router.post("/:expenseId/cancel", validateObjectIdParam("expenseId"), permit("owner", "admin", "accountant"), controller.cancel);

module.exports = router;
