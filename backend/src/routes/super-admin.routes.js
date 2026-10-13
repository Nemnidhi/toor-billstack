const express = require("express");

const {
  getSuperAdminOverview,
  getProductConfiguration,
  createModuleOfferByAdmin,
  listBusinesses,
  createClientWorkspaceByAdmin,
  reviewCommercialOrderByAdmin,
  reviewModuleRequest,
  superAdminLogin,
  syncCommercialModules,
  toggleBusinessStatus,
  updateCommercialModuleByAdmin,
  updateCommercialPlanByAdmin,
  updateBusinessPlanBySuperAdmin,
} = require("../controllers/super-admin.controller");
const { validateObjectIdParam } = require("../middlewares/object-id.middleware");
const { authRateLimiter } = require("../middlewares/rate-limit.middleware");
const { requireSuperAdmin } = require("../middlewares/super-admin.middleware");

const router = express.Router();

router.post("/login", authRateLimiter, superAdminLogin);
router.get("/overview", requireSuperAdmin, getSuperAdminOverview);
router.get("/product-configuration", requireSuperAdmin, getProductConfiguration);
router.post("/product-configuration/sync", requireSuperAdmin, syncCommercialModules);
router.put("/commercial-modules/:moduleKey", requireSuperAdmin, updateCommercialModuleByAdmin);
router.put("/commercial-plans/:planCode", requireSuperAdmin, updateCommercialPlanByAdmin);
router.post("/module-offers", requireSuperAdmin, createModuleOfferByAdmin);
router.post(
  "/commercial-orders/:orderId/review",
  requireSuperAdmin,
  validateObjectIdParam("orderId"),
  reviewCommercialOrderByAdmin
);
router.get("/businesses", requireSuperAdmin, listBusinesses);
router.post("/businesses", requireSuperAdmin, createClientWorkspaceByAdmin);
router.post(
  "/businesses/:businessId/toggle-status",
  requireSuperAdmin,
  validateObjectIdParam("businessId"),
  toggleBusinessStatus
);
router.post(
  "/businesses/:businessId/plan",
  requireSuperAdmin,
  validateObjectIdParam("businessId"),
  updateBusinessPlanBySuperAdmin
);
router.post(
  "/module-requests/:requestId/review",
  requireSuperAdmin,
  validateObjectIdParam("requestId"),
  reviewModuleRequest
);

module.exports = router;
