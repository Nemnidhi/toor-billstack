const mongoose = require("mongoose");
const Business = require("../models/Business");
const User = require("../models/User");
const Membership = require("../models/BusinessMembership");
const AppError = require("../utils/appError");

/**
 * A company group should hold one business per billingEntityCode, but older setup scripts
 * and the Settings button could each create a Goldhawk record, leaving duplicates. Every
 * caller must agree on which one is real, so the rule lives here: prefer an entity inside
 * the group, then the one that actually holds invoices, then the oldest.
 * Entities without a code, and any IDs listed in `keep`, are never dropped.
 */
const pickCanonicalEntities = async (rows, { rootId = null, keep = [] } = {}) => {
  const Invoice = require("../models/Invoice");
  const keepIds = new Set(keep.filter(Boolean).map(String));
  const inGroup = (row) => rootId && (String(row._id) === String(rootId) || String(row.billingParentId || "") === String(rootId));
  const byCode = new Map();
  const result = [];
  for (const row of rows) {
    if (!row.billingEntityCode) { result.push(row); continue; }
    if (!byCode.has(row.billingEntityCode)) byCode.set(row.billingEntityCode, []);
    byCode.get(row.billingEntityCode).push(row);
  }
  for (const list of byCode.values()) {
    if (list.length === 1) { result.push(list[0]); continue; }
    const scored = await Promise.all(list.map(async (row) => ({
      row,
      group: inGroup(row) ? 0 : 1,
      invoices: await Invoice.countDocuments({ businessId: row._id }),
      created: new Date(row.createdAt || row._id.getTimestamp()).getTime(),
    })));
    scored.sort((a, b) => a.group - b.group || b.invoices - a.invoices || a.created - b.created);
    result.push(scored[0].row);
    scored.slice(1).forEach(({ row }) => { if (keepIds.has(String(row._id))) result.push(row); });
  }
  return result;
};

/** Active entities of a company group (root + children), one per billing entity code. */
const canonicalGroupEntities = async (rootId) => {
  const rows = await Business.find({ $or: [{ _id: rootId }, { billingParentId: rootId }], isDisabled: { $ne: true } }).sort({ createdAt: 1, _id: 1 });
  return pickCanonicalEntities(rows, { rootId });
};

/** The single entity for a code (e.g. GOLDHAWK) inside a company group, or null. */
const findGroupEntity = async (rootId, code) =>
  (await canonicalGroupEntities(rootId)).find((row) => row.billingEntityCode === code) || null;

// The original home business/role is never changed by switching workspace.
const resolveEntityUser = async (identity, requestedId) => {
  const id = String(requestedId || identity.businessId);
  if (!mongoose.isValidObjectId(id)) throw new AppError("Invalid billing entity", 403);
  if (id === String(identity.businessId)) return identity;

  const membership = await Membership.findOne({ userId: identity._id, businessId: id });
  if (membership) {
    return {
      ...(identity.toObject ? identity.toObject() : identity),
      businessId: membership.businessId,
      role: membership.role,
      permissions: { canManageHR: false, canViewHR: false },
    };
  }

  // Check if target entity belongs to the user's company group and user is owner/admin
  const targetBusiness = await Business.findById(id);
  const homeBusiness = await Business.findById(identity.businessId);
  const rootId = String(homeBusiness?.billingParentId || homeBusiness?._id || "");
  const targetRootId = String(targetBusiness?.billingParentId || targetBusiness?._id || "");

  if (targetBusiness && rootId && rootId === targetRootId && (identity.role === "owner" || identity.role === "admin")) {
    return {
      ...(identity.toObject ? identity.toObject() : identity),
      businessId: targetBusiness._id,
      role: identity.role,
      permissions: { canManageHR: false, canViewHR: false },
    };
  }

  throw new AppError("Billing entity access denied", 403);
};

const listEntities = async (identity) => {
  const memberships = await Membership.find({ userId: identity._id });
  const currentBusiness = await Business.findById(identity.businessId);
  const rootId = currentBusiness?.billingParentId || identity.businessId;

  const candidateIds = new Set([
    identity.businessId.toString(),
    rootId.toString(),
    ...memberships.map((m) => m.businessId.toString()),
  ]);

  if (identity.role === "owner" || identity.role === "admin") {
    const groupChildren = await Business.find({ billingParentId: rootId, isDisabled: { $ne: true } }).select("_id");
    groupChildren.forEach((c) => candidateIds.add(c._id.toString()));
  }

  const rows = await Business.find({
    _id: { $in: Array.from(candidateIds).map((id) => new mongoose.Types.ObjectId(id)) },
    isDisabled: { $ne: true },
  }).select("name billingEntityCode billingParentId gstConfiguration createdAt").sort({ createdAt: 1, _id: 1 });

  const picked = await pickCanonicalEntities(rows, { rootId, keep: [identity.businessId] });
  // Primary company first, then the rest by name.
  picked.sort((a, b) => (String(a._id) === String(rootId) ? -1 : String(b._id) === String(rootId) ? 1 : String(a.name).localeCompare(String(b.name))));

  return picked.map((b) => ({
    id: b._id,
    name: b.name,
    billingEntityCode: b.billingEntityCode,
    isPrimary: String(b._id) === String(rootId),
    gstEnabled: Boolean(b.gstConfiguration?.enabled),
  }));
};

const requireGroupOwner = async (identity) => {
  const home = await Business.findById(identity.businessId);
  if (identity.role !== "owner" || home?.deploymentMode !== "SELF_HOSTED" || home.billingParentId) {
    throw new AppError("Only the primary billing company owner can manage entity access", 403);
  }
  return home;
};

const ensureGoldhawk = async (identity) => {
  const home = await requireGroupOwner(identity);
  const existingEntity = await findGroupEntity(home._id, "GOLDHAWK");
  if (existingEntity) {
    await Membership.updateOne({ userId: identity._id, businessId: existingEntity._id }, { $setOnInsert: { role: "admin" } }, { upsert: true });
    return existingEntity;
  }
  const session = await mongoose.startSession();
  let entity;
  try {
    await session.withTransaction(async () => {
      entity = await Business.findOne({ billingParentId: home._id, billingEntityCode: "GOLDHAWK" }).session(session);
      if (!entity) {
        [entity] = await Business.create([
          {
            name: "Goldhawk Infrabulls Pvt. Ltd.",
            slug: "goldhawk-" + home._id,
            billingParentId: home._id,
            billingEntityCode: "GOLDHAWK",
            deploymentMode: "SELF_HOSTED",
            ownerUserId: identity._id,
            industry: home.industry,
            onboardingCompleted: true,
            businessProfile: { ...home.businessProfile.toObject(), gstRegistered: false },
            gstConfiguration: { enabled: false },
            defaultTaxSettings: { taxName: "", taxRate: 0, taxMode: "exclusive" },
            invoiceNumbering: { prefix: "GH", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
          },
        ], { session });

        const Config = require("../models/BusinessModuleConfig");
        const configs = await Config.find({ businessId: home._id }).session(session);
        if (configs.length) {
          await Config.insertMany(
            configs.map((c) => ({
              businessId: entity._id,
              moduleKey: c.moduleKey,
              state: c.state,
              source: "SYSTEM",
              configuredBy: identity._id,
            })),
            { session }
          );
        }
      }
      await Membership.updateOne(
        { userId: identity._id, businessId: entity._id },
        { $setOnInsert: { role: "admin" } },
        { upsert: true, session }
      );
    });
    return entity;
  } catch (error) {
    if (error.code === 11000) {
      const existing = await findGroupEntity(home._id, "GOLDHAWK");
      if (existing) {
        await Membership.updateOne(
          { userId: identity._id, businessId: existing._id },
          { $setOnInsert: { role: "admin" } },
          { upsert: true }
        );
        return existing;
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const grantAccess = async (identity, { userId, businessId, role, remove }) => {
  const home = await requireGroupOwner(identity);
  if (!mongoose.isValidObjectId(userId) || !mongoose.isValidObjectId(businessId)) {
    throw new AppError("Invalid user or entity", 400);
  }
  const target = (await canonicalGroupEntities(home._id)).find((row) => String(row._id) === String(businessId) && String(row._id) !== String(home._id));
  const user = await User.findOne({ _id: userId, businessId: home._id, isActive: true });
  if (!target || !user) throw new AppError("User or billing entity is outside this company group", 403);
  if (String(userId) === String(identity._id)) {
    throw new AppError("The primary owner's entity access cannot be removed here", 400);
  }
  if (remove) return Membership.deleteOne({ userId, businessId });
  if (!["admin", "accountant", "staff"].includes(role)) throw new AppError("Invalid entity role", 400);
  return Membership.findOneAndUpdate(
    { userId, businessId },
    { $set: { role } },
    { upsert: true, new: true, runValidators: true }
  );
};

module.exports = { resolveEntityUser, listEntities, ensureGoldhawk, grantAccess, requireGroupOwner, pickCanonicalEntities, canonicalGroupEntities, findGroupEntity };
