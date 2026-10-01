const User = require("../models/User");
const Business = require("../models/Business");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const { verifyAccessToken } = require("../services/auth.service");
const { ensureBusinessSubscription } = require("../utils/subscription");

const authMiddleware = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    throw new AppError("Authentication required", 401);
  }

  let decoded;

  try {
    decoded = verifyAccessToken(token);
  } catch (_error) {
    throw new AppError("Invalid or expired access token", 401);
  }

  const user = await User.findById(decoded.sub).select("-password");

  if (!user) {
    throw new AppError("User not found", 401);
  }

  if (!user.isActive) {
    throw new AppError("This user account has been deactivated", 403);
  }

  req.identityUser = user;
  req.user = await require("../services/billing-entity.service").resolveEntityUser(user, req.headers["x-business-id"] || decoded.businessId);
  const business = await Business.findById(req.user.businessId);
  if (!business) throw new AppError("Business not found", 403);
  if (business?.isDisabled) {
    throw new AppError("This business has been disabled by the platform owner", 403);
  }
  req.subscription = await ensureBusinessSubscription({
    businessId: req.user.businessId,
    planCode: business?.planCode || "free",
  });
  req.business = business;
  next();
});

module.exports = authMiddleware;
