const express = require("express");

const {
  createTeamMember,
  deleteTeamMember,
  listTeamMembers,
  updateTeamMember,
} = require("../controllers/team.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { validateObjectIdParam } = require("../middlewares/object-id.middleware");
const { permit } = require("../middlewares/role.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  teamMemberCreateValidator,
  teamMemberUpdateValidator,
} = require("../validators/resource.validation");

const router = express.Router();

router.use(authMiddleware, tenantMiddleware, requireActiveSubscription());

router.get("/", permit("owner", "admin"), listTeamMembers);
router.post("/", permit("owner", "admin"), validate(teamMemberCreateValidator), createTeamMember);
router.put(
  "/:userId",
  validateObjectIdParam("userId"),
  permit("owner", "admin"),
  validate(teamMemberUpdateValidator),
  updateTeamMember
);
router.delete("/:userId", validateObjectIdParam("userId"), permit("owner", "admin"), deleteTeamMember);
// Someone lost their phone and recovery codes: switch their two-step sign-in off so they can set it up again.
router.post("/:userId/two-factor/reset", validateObjectIdParam("userId"), permit("owner", "admin"), require("../utils/asyncHandler")(async (req, res) => {
  const data = await require("../services/two-factor.service").resetForUser({ actor: req.user, userId: req.params.userId });
  await require("../services/audit.service").writeAuditLog({ req, businessId: req.user.businessId, actor: { type: "USER", userId: req.user._id, email: req.user.email, role: req.user.role }, action: "TWO_FACTOR_RESET", entityType: "USER", entityId: req.params.userId, metadata: {} });
  res.json({ data });
}));

module.exports = router;
