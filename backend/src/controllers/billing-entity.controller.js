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
  const users = await User.find({ businessId: home._id, isActive: true }).select("name email role");
  const entities = await service.listEntities(req.identityUser);
  const grants = await Membership.find({ businessId: { $in: entities.map(e => e.id) } }).select("userId businessId role");
  res.json({ data: { users, entities, grants } });
});
exports.grant = asyncHandler(async (req, res) => {
  await service.grantAccess(req.identityUser, req.body);
  await writeAuditLog({ req, action: "BILLING_ENTITY_ACCESS_CHANGED", entityType: "USER", entityId: req.body.userId, metadata: { businessId: req.body.businessId, role: req.body.role, removed: Boolean(req.body.remove) } });
  res.json({ message: "Billing entity access updated" });
});
