const mongoose = require("mongoose");
const Business = require("../models/Business");
const User = require("../models/User");
const Membership = require("../models/BusinessMembership");
const AppError = require("../utils/appError");

// The original home business/role is never changed by switching workspace.
const resolveEntityUser = async (identity, requestedId) => {
  const id = String(requestedId || identity.businessId);
  if (!mongoose.isValidObjectId(id)) throw new AppError("Invalid billing entity", 403);
  if (id === String(identity.businessId)) return identity;
  const membership = await Membership.findOne({ userId: identity._id, businessId: id });
  if (!membership) throw new AppError("Billing entity access denied", 403);
  return { ...(identity.toObject ? identity.toObject() : identity), businessId: membership.businessId, role: membership.role, permissions: { canManageHR: false, canViewHR: false } };
};
const listEntities = async (identity) => {
  const memberships = await Membership.find({ userId: identity._id });
  const rows = await Business.find({ _id: { $in: [identity.businessId, ...memberships.map(m => m.businessId)] }, isDisabled: { $ne: true } }).select("name billingEntityCode billingParentId gstConfiguration");
  return rows.map(b => ({ id: b._id, name: b.name, billingEntityCode: b.billingEntityCode, gstEnabled: Boolean(b.gstConfiguration?.enabled) }));
};
const requireGroupOwner = async identity => {
  const home = await Business.findById(identity.businessId);
  if (identity.role !== "owner" || home?.deploymentMode !== "SELF_HOSTED" || home.billingParentId) throw new AppError("Only the primary billing company owner can manage entity access", 403);
  return home;
};
const ensureGoldhawk = async identity => {
  const home = await requireGroupOwner(identity);
  const session = await mongoose.startSession();
  let entity;
  try {
    await session.withTransaction(async () => {
      entity = await Business.findOne({ billingParentId: home._id, billingEntityCode: "GOLDHAWK" }).session(session);
      if (!entity) {
        [entity] = await Business.create([{
          name: "Goldhawk Infrabulls Pvt. Ltd.", slug: `goldhawk-${home._id}`,
          billingParentId: home._id, billingEntityCode: "GOLDHAWK", deploymentMode: "SELF_HOSTED",
          ownerUserId: identity._id, industry: home.industry, onboardingCompleted: true,
          businessProfile: { ...home.businessProfile.toObject(), gstRegistered: false },
          gstConfiguration: { enabled: false }, defaultTaxSettings: { taxName: "", taxRate: 0, taxMode: "exclusive" },
          invoiceNumbering: { prefix: "GH", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
        }], { session });
        const Config = require("../models/BusinessModuleConfig");
        const configs = await Config.find({ businessId: home._id }).session(session);
        if (configs.length) await Config.insertMany(configs.map(c => ({ businessId: entity._id, moduleKey: c.moduleKey, state: c.state, source: "SYSTEM", configuredBy: identity._id })), { session });
      }
      await Membership.updateOne({ userId: identity._id, businessId: entity._id }, { $setOnInsert: { role: "admin" } }, { upsert: true, session });
    });
    return entity;
  } catch (error) {
    if (error.code === 11000) {
      const existing = await Business.findOne({ billingParentId: home._id, billingEntityCode: "GOLDHAWK" });
      if (existing) {
        await Membership.updateOne({ userId: identity._id, businessId: existing._id }, { $setOnInsert: { role: "admin" } }, { upsert: true });
        return existing;
      }
    }
    throw error;
  } finally { await session.endSession(); }
};
const grantAccess = async (identity, { userId, businessId, role, remove }) => {
  const home = await requireGroupOwner(identity);
  if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(businessId)) throw new AppError("Invalid user or entity", 400);
  const target = await Business.findOne({ _id: businessId, billingParentId: home._id });
  const user = await User.findOne({ _id: userId, businessId: home._id, isActive: true });
  if (!target || !user) throw new AppError("User or billing entity is outside this company group", 403);
  if (String(userId) === String(identity._id)) throw new AppError("The primary owner's entity access cannot be removed here", 400);
  if (remove) return Membership.deleteOne({ userId, businessId });
  if (!["admin", "accountant", "staff"].includes(role)) throw new AppError("Invalid entity role", 400);
  return Membership.findOneAndUpdate({ userId, businessId }, { $set: { role } }, { upsert: true, new: true, runValidators: true });
};
module.exports = { resolveEntityUser, listEntities, ensureGoldhawk, grantAccess, requireGroupOwner };
