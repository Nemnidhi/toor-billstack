const express = require("express");

const {
  getCurrentBusiness,
  createBusinessSampleData,
  getPlanRecommendation,
  removeBusinessSampleData,
  updateBusinessPlan,
  updateBusinessSetup,
} = require("../controllers/business.controller");
const { logoUpload, validateUploadedBranding } = require("../config/upload");
const authMiddleware = require("../middlewares/auth.middleware");
const { permit } = require("../middlewares/role.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  businessSetupValidator,
  planUpdateValidator,
} = require("../validators/auth.validation");

const router = express.Router();

router.use(authMiddleware, tenantMiddleware);

const entities = require("../controllers/billing-entity.controller");
router.get("/billing-entities", entities.list);
router.post("/billing-entities", entities.create);
router.get("/billing-entities/members", entities.members);
router.put("/billing-entities/members", entities.grant);
router.get("/me", getCurrentBusiness);
router.get("/plan-recommendation", getPlanRecommendation);
router.post("/sample-data", permit("owner", "admin"), createBusinessSampleData);
router.delete("/sample-data", permit("owner", "admin"), removeBusinessSampleData);
router.put(
  "/setup",
  permit("owner", "admin"),
  logoUpload.fields([
    { name: "logo", maxCount: 1 },
    { name: "signature", maxCount: 1 },
  ]),
  validateUploadedBranding,
  validate(businessSetupValidator),
  updateBusinessSetup
);
router.put("/plan", permit("owner"), validate(planUpdateValidator), updateBusinessPlan);

module.exports = router;
