const mongoose = require("mongoose");
const Business = require("../models/Business");
const AppError = require("../utils/appError");
const { listEntities, resolveEntityUser } = require("../services/billing-entity.service");

const ALLOWED_ACCOUNTING_ROLES = ["owner", "admin", "accountant"];

/**
 * Middleware for Accounting Reports authorization & entity routing.
 * Ensures:
 * 1. Only owner, admin, and accountant can access financial reports.
 * 2. Entity-restricted user cannot access another entity's reports.
 * 3. Consolidated reporting strictly requires authorized access to all entities in the group.
 */
const authorizeAccountingReport = async (req, _res, next) => {
  try {
    if (!req.user) {
      throw new AppError("Authentication required", 401);
    }

    if (!ALLOWED_ACCOUNTING_ROLES.includes(req.user.role)) {
      throw new AppError("You do not have permission to access financial reports", 403);
    }

    const requestedEntity = (req.query.entity || req.query.entityId || req.headers["x-billing-entity-id"] || "").trim();
    const isConsolidatedRequest = requestedEntity.toLowerCase() === "all" || requestedEntity.toLowerCase() === "consolidated";

    const userEntities = await listEntities(req.user);
    const homeBusiness = await Business.findById(req.user.businessId);
    if (!homeBusiness) {
      throw new AppError("Business not found", 404);
    }
    const rootBusinessId = homeBusiness.billingParentId || homeBusiness._id;

    if (isConsolidatedRequest) {
      // Find the group's entities
      const groupEntities = await Business.find({
        $or: [{ _id: rootBusinessId }, { billingParentId: rootBusinessId }],
        isDisabled: { $ne: true },
      });

      // User must have access to all entities in the group
      const accessibleIds = new Set(userEntities.map((e) => e.id.toString()));
      const missingEntities = groupEntities.filter((g) => !accessibleIds.has(g._id.toString()));

      if (missingEntities.length > 0) {
        throw new AppError("Consolidated reporting requires authorized access to all billing entities in the group", 403);
      }

      // Check role in each entity
      for (const entity of groupEntities) {
        const scoped = await resolveEntityUser(req.user, entity._id);
        if (!ALLOWED_ACCOUNTING_ROLES.includes(scoped.role)) {
          throw new AppError(`Insufficient permissions for entity: ${entity.name}`, 403);
        }
      }

      req.accountingScope = {
        isConsolidated: true,
        homeBusinessId: rootBusinessId,
        groupEntities,
      };

      return next();
    }

    // Specific entity request
    let targetBusinessId = req.user.businessId;

    if (requestedEntity && requestedEntity.toUpperCase() === "GOLDHAWK") {
      const gh = await Business.findOne({
        $or: [
          { billingParentId: rootBusinessId, billingEntityCode: "GOLDHAWK" },
          { _id: rootBusinessId, billingEntityCode: "GOLDHAWK" },
        ],
        isDisabled: { $ne: true },
      });
      if (!gh) throw new AppError("Goldhawk entity not found in your company group", 404);
      targetBusinessId = gh._id;
    } else if (requestedEntity && requestedEntity.toUpperCase() === "TOOR") {
      targetBusinessId = rootBusinessId;
    } else if (requestedEntity && mongoose.isValidObjectId(requestedEntity)) {
      targetBusinessId = new mongoose.Types.ObjectId(requestedEntity);
    }

    const scopedUser = await resolveEntityUser(req.user, targetBusinessId);
    if (!ALLOWED_ACCOUNTING_ROLES.includes(scopedUser.role)) {
      throw new AppError("You do not have permission to access financial reports for this entity", 403);
    }

    req.accountingScope = {
      isConsolidated: false,
      businessId: targetBusinessId,
      role: scopedUser.role,
    };

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = {
  authorizeAccountingReport,
  ALLOWED_ACCOUNTING_ROLES,
};
