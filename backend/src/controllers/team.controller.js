const User = require("../models/User");
const AppError = require("../utils/appError");
const asyncHandler = require("../utils/asyncHandler");
const { ensureBusinessSubscription, getPlanEntitlements, isSubscriptionAccessible } = require("../utils/subscription");
const {
  buildPaginatedResponse,
  buildPagination,
  buildSearchFilter,
  buildSort,
} = require("../utils/queryFeatures");
const { hashPassword } = require("../services/auth.service");

const userSortFields = ["name", "email", "role", "createdAt", "updatedAt"];

const listTeamMembers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const sort = buildSort(req.query.sortBy, req.query.sortOrder, userSortFields);
  const searchFilter = buildSearchFilter(req.query.search, ["name", "email", "role"]);

  const filters = {
    businessId: req.tenant.businessId,
    ...searchFilter,
  };

  if (req.query.role) {
    filters.role = req.query.role;
  }

  if (req.query.status === "active") {
    filters.isActive = true;
  }

  if (req.query.status === "inactive") {
    filters.isActive = false;
  }

  const [items, total] = await Promise.all([
    User.find(filters).select("-password").sort(sort).skip(skip).limit(limit),
    User.countDocuments(filters),
  ]);

  res.status(200).json({
    message: "Team members fetched successfully",
    data: buildPaginatedResponse({ items, total, page, limit }),
  });
});

const createTeamMember = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  if (req.business?.deploymentMode !== "SELF_HOSTED") {
    const subscription = await ensureBusinessSubscription({ businessId, planCode: req.business.planCode });
    if (!isSubscriptionAccessible(subscription)) {
      throw new AppError("Your subscription is inactive or expired", 402);
    }
    const plan = getPlanEntitlements(subscription);
    const currentUserCount = await User.countDocuments({ businessId });

    if (currentUserCount >= plan.staffUserLimit) {
      throw new AppError(
        `Staff user limit reached for the ${plan.name} plan. Allowed users: ${plan.staffUserLimit}`,
        403,
        {
          code: "LIMIT_REACHED",
          feature: "staff",
          current: currentUserCount,
          limit: plan.staffUserLimit,
          recommendedAction: "UPGRADE_PLAN",
        }
      );
    }
  }

  const email = req.body.email.trim().toLowerCase();
  let user = await User.findOne({ email });
  const Membership = require("../models/BusinessMembership");
  const Business = require("../models/Business");

  if (user) {
    await Membership.findOneAndUpdate(
      { userId: user._id, businessId },
      { $set: { role: req.body.role || "staff" } },
      { upsert: true, new: true }
    );
    if (req.body.password) {
      user.password = await hashPassword(req.body.password);
    }
    if (req.body.name) user.name = req.body.name.trim();
    if (req.body.isActive !== undefined) user.isActive = `${req.body.isActive}` === "true";
    await user.save();
  } else {
    const password = await hashPassword(req.body.password);
    user = await User.create({
      businessId,
      name: req.body.name.trim(),
      email,
      password,
      role: req.body.role,
      isActive: req.body.isActive === undefined ? true : `${req.body.isActive}` === "true",
    });
  }

  const childEntities = await Business.find({ billingParentId: businessId });
  for (const child of childEntities) {
    await Membership.findOneAndUpdate(
      { userId: user._id, businessId: child._id },
      { $set: { role: req.body.role || "staff" } },
      { upsert: true, new: true }
    );
  }

  res.status(201).json({
    message: "Team member created successfully",
    data: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      businessId: user.businessId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  });
});

const updateTeamMember = asyncHandler(async (req, res) => {
  const teamMember = await User.findOne({
    _id: req.params.userId,
    businessId: req.tenant.businessId,
  });

  if (!teamMember) {
    throw new AppError("Team member not found", 404);
  }

  if (teamMember._id.toString() === req.user._id.toString() && req.body.role && req.body.role !== req.user.role) {
    throw new AppError("You cannot change your own role from this screen", 400);
  }

  if (teamMember._id.toString() === req.user._id.toString() && req.body.isActive !== undefined && `${req.body.isActive}` === "false") {
    throw new AppError("You cannot deactivate your own account", 400);
  }

  if (req.body.email) {
    const duplicate = await User.findOne({
      businessId: req.tenant.businessId,
      email: req.body.email.trim().toLowerCase(),
      _id: { $ne: teamMember._id },
    });

    if (duplicate) {
      throw new AppError("A user with this email already exists for the business", 409);
    }

    teamMember.email = req.body.email.trim().toLowerCase();
  }

  if (req.body.name) {
    teamMember.name = req.body.name.trim();
  }

  if (req.body.role) {
    teamMember.role = req.body.role;
  }

  if (req.body.password) {
    teamMember.password = await hashPassword(req.body.password);
  }

  if (req.body.isActive !== undefined) {
    teamMember.isActive = `${req.body.isActive}` === "true";
  }

  await teamMember.save();

  res.status(200).json({
    message: "Team member updated successfully",
    data: {
      id: teamMember._id,
      name: teamMember.name,
      email: teamMember.email,
      role: teamMember.role,
      isActive: teamMember.isActive,
      businessId: teamMember.businessId,
      createdAt: teamMember.createdAt,
      updatedAt: teamMember.updatedAt,
    },
  });
});

const deleteTeamMember = asyncHandler(async (req, res) => {
  const teamMember = await User.findOne({
    _id: req.params.userId,
    businessId: req.tenant.businessId,
  });

  if (!teamMember) {
    throw new AppError("Team member not found", 404);
  }

  if (teamMember._id.toString() === req.user._id.toString()) {
    throw new AppError("You cannot delete your own account", 400);
  }

  await teamMember.deleteOne();

  res.status(200).json({
    message: "Team member deleted successfully",
  });
});

module.exports = {
  createTeamMember,
  deleteTeamMember,
  listTeamMembers,
  updateTeamMember,
};
