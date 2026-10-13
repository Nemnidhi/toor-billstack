const crypto = require("crypto");
const Business = require("../models/Business");
const BusinessSubscription = require("../models/BusinessSubscription");
const Invoice = require("../models/Invoice");
const User = require("../models/User");
const ModuleRequest = require("../models/ModuleRequest");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const { signSuperAdminToken } = require("../services/super-admin.service");
const { getPlanByCode, serializeBusinessWithPlan } = require("../utils/businessPlan");
const { applyControlledPlanChange, getCommunicationUsage } = require("../utils/subscription");
const { writeAuditLog } = require("../services/audit.service");
const {
  buildPaginatedResponse,
  buildPagination,
  buildSearchFilter,
  buildSort,
} = require("../utils/queryFeatures");
const { moduleCatalog, setBusinessModuleState } = require("../services/module.service");
const { presets } = require("../constants/modules");
const { capabilityCatalog, industryCatalog } = require("../constants/industry-presets");
const CommercialModule = require("../models/CommercialModule");
const ModuleOffer = require("../models/ModuleOffer");
const ModuleOrder = require("../models/ModuleOrder");
const {
  createOffer,
  listCommercialCatalogue,
  syncCommercialCatalogue,
  updateCommercialModule,
  verifyManualOrder,
} = require("../services/commercial.service");
const {
  listCommercialPlans,
  syncCommercialPlans,
  updateCommercialPlan,
} = require("../services/commercial-plan.service");

const planMonthlyValue = {
  free: 0,
  starter: 999,
  basic: 999,
  growth: 1799,
  pro: 2499,
  enterprise: 9999,
};
const validPlanCodes = Object.keys(planMonthlyValue);

const listBusinessSortFields = ["name", "planCode", "createdAt"];
const buildPresetConfiguration = (presetConfig = {}) =>
  Object.entries(presetConfig || {}).map(([key, moduleKeys]) => ({
    key,
    moduleKeys: Array.isArray(moduleKeys) ? moduleKeys : [],
  }));

const superAdminLogin = asyncHandler(async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  const expectedEmail = (process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
  const expectedPassword = process.env.SUPER_ADMIN_PASSWORD || "";
  if (!expectedEmail || !expectedPassword) {
    throw new AppError("Super admin login is not configured", 503);
  }

  const hashStr = (s) => crypto.createHash("sha256").update(s).digest();

  const emailMatch = crypto.timingSafeEqual(hashStr(email), hashStr(expectedEmail));
  const passMatch = crypto.timingSafeEqual(hashStr(password), hashStr(expectedPassword));

  if (!emailMatch || !passMatch) {
    throw new AppError("Invalid super admin credentials", 401);
  }

  const accessToken = signSuperAdminToken({
    role: "super_admin",
    email,
  });

  res.status(200).json({
    message: "Super admin login successful",
    data: {
      accessToken,
      email,
    },
  });
});

const getSuperAdminOverview = asyncHandler(async (_req, res) => {
  const [businesses, totalUsers, activeSubscriptions, expiredSubscriptions, pendingModuleRequests, pendingCommercialPayments, revenueAnalytics] =
    await Promise.all([
      Business.find({}).sort("-createdAt"),
      User.countDocuments({}),
      BusinessSubscription.countDocuments({
        planCode: { $ne: "free" },
        status: { $in: ["active", "authenticated"] },
      }),
      BusinessSubscription.countDocuments({
        status: { $in: ["expired", "cancelled", "completed"] },
      }),
      ModuleRequest.countDocuments({ status: { $in: ["PENDING", "UNDER_REVIEW"] } }),
      ModuleOrder.countDocuments({ paymentStatus: "AWAITING_VERIFICATION" }),
      BusinessSubscription.aggregate([
        {
          $match: {
            planCode: { $ne: "free" },
          },
        },
        {
          $project: {
            planCode: 1,
            currentStart: 1,
          },
        },
      ]),
    ]);

  const totalBusinesses = businesses.length;
  const activeBusinesses = businesses.filter((business) => !business.isDisabled).length;
  const disabledBusinesses = totalBusinesses - activeBusinesses;
  const trialUsers = businesses.filter((business) => business.planCode === "free").length;
  const paidBusinesses = businesses.filter((business) => business.planCode && business.planCode !== "free").length;
  const monthlyRecurringRevenue = businesses.reduce(
    (sum, business) => sum + (planMonthlyValue[business.planCode] || 0),
    0
  );

  const monthBuckets = {};
  revenueAnalytics.forEach((item) => {
    const date = item.currentStart ? new Date(item.currentStart) : new Date();
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    monthBuckets[key] = (monthBuckets[key] || 0) + (planMonthlyValue[item.planCode] || 0);
  });

  const revenueChart = Object.entries(monthBuckets)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, revenue]) => ({ month, revenue }));

  res.status(200).json({
    message: "Super admin overview fetched successfully",
    data: {
      metrics: {
        totalBusinesses,
        activeBusinesses,
        disabledBusinesses,
        totalUsers,
        activeSubscriptions,
        monthlyRecurringRevenue,
        trialUsers,
        paidBusinesses,
        expiredSubscriptions,
        pendingModuleRequests,
        pendingCommercialPayments,
      },
      revenueChart,
    },
  });
});

const createClientWorkspaceByAdmin = asyncHandler(async (req, res) => {
  const { createClientWorkspace } = require("../services/workspace-provisioning.service");
  const result = await createClientWorkspace(req.body || {});
  await writeAuditLog({
    req,
    businessId: result.business.id,
    actor: { type: "SYSTEM", email: req.superAdmin?.email || "super-admin", role: "super_admin" },
    action: "WORKSPACE_CREATED",
    entityType: "BUSINESS",
    entityId: result.business.id,
    metadata: { ownerEmail: result.owner.email },
  }).catch(() => {});
  res.status(201).json({ message: "Client workspace created", data: result });
});

const listBusinesses = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const sort = buildSort(req.query.sortBy, req.query.sortOrder, listBusinessSortFields, "-createdAt");
  const searchFilter = buildSearchFilter(req.query.search, ["name", "email", "billingEmail"]);

  const filters = {
    ...searchFilter,
  };

  if (req.query.planCode) {
    filters.planCode = req.query.planCode;
  }

  if (req.query.isDisabled === "true") {
    filters.isDisabled = true;
  }

  if (req.query.isDisabled === "false") {
    filters.isDisabled = false;
  }

  const [items, total] = await Promise.all([
    Business.find(filters).sort(sort).skip(skip).limit(limit),
    Business.countDocuments(filters),
  ]);

  const businessIds = items.map((business) => business._id);
  const subscriptions = await BusinessSubscription.find({
    businessId: { $in: businessIds },
  });
  const subscriptionMap = new Map(
    subscriptions.map((subscription) => [subscription.businessId.toString(), subscription])
  );

  res.status(200).json({
    message: "Businesses fetched successfully",
    data: buildPaginatedResponse({
      items: items.map((business) =>
        serializeBusinessWithPlan(
          business,
          subscriptionMap.get(business._id.toString()) || null
        )
      ),
      total,
      page,
      limit,
    }),
  });
});

const toggleBusinessStatus = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.params.businessId);

  if (!business) {
    throw new AppError("Business not found", 404);
  }

  business.isDisabled = !business.isDisabled;
  await business.save();

  const subscription = await BusinessSubscription.findOne({ businessId: business._id });

  res.status(200).json({
    message: `Business ${business.isDisabled ? "disabled" : "enabled"} successfully`,
    data: serializeBusinessWithPlan(business, subscription),
  });
});

const updateBusinessPlanBySuperAdmin = asyncHandler(async (req, res) => {
  const business = await Business.findById(req.params.businessId);

  if (!business) {
    throw new AppError("Business not found", 404);
  }

  const planCode = String(req.body.planCode || "").trim().toLowerCase();
  if (!validPlanCodes.includes(planCode)) {
    throw new AppError("Invalid plan code", 400);
  }

  const { business: updatedBusiness, subscription } = await applyControlledPlanChange({
    businessId: business._id,
    planCode,
    status: planCode === "free" ? "free" : req.body.status || "active",
    source: "super_admin",
  });

  res.status(200).json({
    message: "Business plan updated successfully",
    data: {
      ...serializeBusinessWithPlan(updatedBusiness, subscription),
      usage: await getCommunicationUsage({ businessId: business._id }),
    },
  });
});

const getProductConfiguration = asyncHandler(async (_req, res) => {
  const commercialCatalogue = await listCommercialCatalogue();
  const commercialPlans = await listCommercialPlans();
  const requests = await ModuleRequest.find({})
    .populate("businessId", "name email billingEmail")
    .populate("requestedBy", "name email")
    .sort("-createdAt")
    .limit(50);

  res.status(200).json({
    message: "Product configuration fetched successfully",
    data: {
      modules: moduleCatalog,
      industries: industryCatalog,
      capabilities: capabilityCatalog,
      commercialModules: commercialCatalogue,
      commercialPlans,
      presets: buildPresetConfiguration(presets),
      requests,
      offers: await ModuleOffer.find({}).populate("businessId", "name email billingEmail").sort("-createdAt").limit(50),
      orders: await ModuleOrder.find({}).populate("businessId", "name email billingEmail").populate("offerId").sort("-createdAt").limit(50),
    },
  });
});

const reviewModuleRequest = asyncHandler(async (req, res) => {
  const request = await ModuleRequest.findById(req.params.requestId);
  if (!request) {
    throw new AppError("Module request not found", 404);
  }

  const nextStatus = String(req.body.status || "").trim().toUpperCase();
  if (!["UNDER_REVIEW", "APPROVED", "REJECTED", "COMPLETED"].includes(nextStatus)) {
    throw new AppError("Invalid module request status", 400);
  }

  request.status = nextStatus;
  request.adminNote = req.body.adminNote?.trim() || request.adminNote || "";
  await request.save();

  await syncCommercialCatalogue();
  const commercial = request.moduleKey ? await CommercialModule.findOne({ moduleKey: request.moduleKey }) : null;
  if (
    nextStatus === "APPROVED" &&
    request.moduleKey &&
    (!commercial || ["FREE", "PLAN_INCLUDED"].includes(commercial.commercialType))
  ) {
    await setBusinessModuleState({
      businessId: request.businessId,
      moduleKey: request.moduleKey,
      state: "ACTIVE",
      source: "SUPER_ADMIN",
    });
  }

  res.status(200).json({ message: "Module request updated", data: request });
});

const syncCommercialModules = asyncHandler(async (req, res) => {
  const modules = await syncCommercialCatalogue();
  const plans = await syncCommercialPlans();
  await writeAuditLog({ req, action: "COMMERCIAL_CATALOGUE_SYNCED", entityType: "COMMERCIAL_MODULE", metadata: { count: modules.length } });
  res.status(200).json({ message: "Commercial catalogue synced", data: { modules, plans } });
});

const updateCommercialModuleByAdmin = asyncHandler(async (req, res) => {
  const data = await updateCommercialModule({ moduleKey: req.params.moduleKey, payload: req.body, req });
  res.status(200).json({ message: "Commercial module updated", data });
});

const updateCommercialPlanByAdmin = asyncHandler(async (req, res) => {
  const data = await updateCommercialPlan({ code: req.params.planCode, payload: req.body, req });
  res.status(200).json({ message: "Commercial plan updated", data });
});

const createModuleOfferByAdmin = asyncHandler(async (req, res) => {
  const request = req.body.moduleRequestId ? await ModuleRequest.findById(req.body.moduleRequestId) : null;
  const businessId = req.body.businessId || request?.businessId;
  const moduleKey = req.body.moduleKey || request?.moduleKey;
  if (!businessId || !moduleKey) throw new AppError("Business and module are required", 400);
  const offer = await createOffer({
    businessId,
    moduleKey,
    moduleRequestId: req.body.moduleRequestId,
    negotiatedPrice: req.body.negotiatedPrice,
    adminNote: req.body.adminNote,
    validUntil: req.body.validUntil ? new Date(req.body.validUntil) : null,
    offeredBy: req.superAdmin?.email || "super_admin",
    req,
  });
  res.status(201).json({ message: "Module offer created", data: offer });
});

const reviewCommercialOrderByAdmin = asyncHandler(async (req, res) => {
  const order = await verifyManualOrder({
    orderId: req.params.orderId,
    status: req.body.status,
    adminNote: req.body.adminNote,
    req,
  });
  res.status(200).json({ message: "Commercial payment reviewed", data: order });
});

module.exports = {
  createClientWorkspaceByAdmin,
  getSuperAdminOverview,
  listBusinesses,
  superAdminLogin,
  toggleBusinessStatus,
  getProductConfiguration,
  createModuleOfferByAdmin,
  reviewCommercialOrderByAdmin,
  reviewModuleRequest,
  syncCommercialModules,
  updateCommercialModuleByAdmin,
  updateCommercialPlanByAdmin,
  updateBusinessPlanBySuperAdmin,
  _private: {
    buildPresetConfiguration,
  },
};
