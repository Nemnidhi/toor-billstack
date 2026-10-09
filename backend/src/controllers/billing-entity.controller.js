const asyncHandler = require("../utils/asyncHandler");
const service = require("../services/billing-entity.service");
const User = require("../models/User");
const Membership = require("../models/BusinessMembership");
const { writeAuditLog } = require("../services/audit.service");
exports.list = asyncHandler(async (req, res) => res.json({ data: await service.listEntities(req.identityUser) }));
exports.create = asyncHandler(async (req, res) => {
  const entity = await service.ensureGoldhawk(req.identityUser);
  await writeAuditLog({ req, action: "BILLING_ENTITY_CONFIGURED", entityType: "BUSINESS", entityId: entity._id });
  res.json({ data: { id: entity._id, name: entity.name } });
});
exports.members = asyncHandler(async (req, res) => {
  const home = await service.requireGroupOwner(req.identityUser);
  const users = await User.find({ businessId: home._id, isActive: true }).select("name email role").sort("name");
  const entities = await service.listEntities(req.identityUser);
  // Everyone in the primary company already has access to it, so only grants to the
  // other companies mean anything. Grants for deleted/inactive users are hidden.
  const secondaryIds = entities.filter((e) => String(e.id) !== String(home._id)).map((e) => e.id);
  const rawGrants = await Membership.find({ businessId: { $in: secondaryIds } }).select("userId businessId role").lean();
  const grantUsers = await User.find({ _id: { $in: rawGrants.map((g) => g.userId) }, isActive: true }).select("name email role").lean();
  const userById = new Map(grantUsers.map((u) => [String(u._id), u]));
  const grants = rawGrants
    .filter((g) => userById.has(String(g.userId)))
    .map((g) => {
      const user = userById.get(String(g.userId));
      return { ...g, user: { _id: user._id, name: user.name, email: user.email, isOwner: String(user._id) === String(home.ownerUserId || req.identityUser._id) } };
    })
    .sort((a, b) => String(a.user.name).localeCompare(String(b.user.name)));
  res.json({ data: { users, entities, grants } });
});
exports.grant = asyncHandler(async (req, res) => {
  await service.grantAccess(req.identityUser, req.body);
  await writeAuditLog({ req, action: "BILLING_ENTITY_ACCESS_CHANGED", entityType: "USER", entityId: req.body.userId, metadata: { businessId: req.body.businessId, role: req.body.role, removed: Boolean(req.body.remove) } });
  res.json({ message: "Billing entity access updated" });
});
