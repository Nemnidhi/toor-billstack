const crypto = require("crypto");

const Business = require("../models/Business");
const User = require("../models/User");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const {
  buildAuthPayload,
  comparePassword,
  findRefreshToken,
  findValidRefreshToken,
  hashPassword,
  issueRefreshToken,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
  signAccessToken,
} = require("../services/auth.service");
const { sendEmail } = require("../services/email.service");
const { verifyGoogleIdentityToken } = require("../services/google-auth.service");
const { writeAuditLog } = require("../services/audit.service");
const { serializeBusinessWithPlan } = require("../utils/businessPlan");
const { startTrialForNewBusiness } = require("../services/commercial-plan.service");
const { getDeploymentMode } = require("../constants/modules");
const { ensureSelfHostedBusinessProfile } = require("../services/self-hosted-profile.service");

const refreshCookieName = process.env.REFRESH_COOKIE_NAME || "billstack_refresh_token";

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";

const buildUniqueBusinessSlug = async (businessName) => {
  const base = slugify(businessName);

  // Keep slug generation deterministic-ish but collision-safe.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 6)}`;
    const candidate = `${base}${suffix}`.slice(0, 48);
    // eslint-disable-next-line no-await-in-loop
    const exists = await Business.exists({ slug: candidate });
    if (!exists) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`.slice(0, 48);
};

const refreshCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 7) * 24 * 60 * 60 * 1000,
};

const getClientUrl = () => (process.env.CLIENT_URL || "http://localhost:5173").split(",")[0].trim();

const hashResetToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const resolvePasswordLoginUser = async (normalizedEmail) => {
  const users = await User.find({ email: normalizedEmail }).sort({ createdAt: -1 }).limit(10);
  if (!users.length) throw new AppError("Invalid credentials", 401);
  if (users.length === 1 || getDeploymentMode() !== "SELF_HOSTED") {
    if (users.length > 1) throw new AppError("Multiple accounts found for this email. Please contact your admin.", 409);
    return users[0];
  }

  const businesses = await Business.find({ _id: { $in: users.map((user) => user.businessId) }, deploymentMode: "SELF_HOSTED" }).select("_id deploymentMode onboardingCompleted businessProfile");
  const businessIds = new Set(businesses.map((business) => business._id.toString()));
  const candidates = users.filter((user) => user.isActive && businessIds.has(user.businessId.toString()));
  if (!candidates.length) throw new AppError("Invalid credentials", 401);
  return candidates[0];
};

const register = asyncHandler(async (req, res) => {
  const { name, email, password, businessName } = req.body;
  const slug = await buildUniqueBusinessSlug(businessName);

  let business = await Business.create({
    name: businessName.trim(),
    slug,
    deploymentMode: getDeploymentMode(),
  });

  const existingUser = await User.findOne({
    businessId: business._id,
    email: email.trim().toLowerCase(),
  });

  if (existingUser) {
    throw new AppError("A user with this email already exists for the business", 409);
  }

  const hashedPassword = await hashPassword(password);
  const user = await User.create({
    businessId: business._id,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password: hashedPassword,
    role: "owner",
  });

  business.ownerUserId = user._id;
  await business.save();
  business = await ensureSelfHostedBusinessProfile(business);
  await startTrialForNewBusiness({ businessId: business._id, trialSource: "email_signup" });
  const trialBusiness = await Business.findById(business._id);

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user, {
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.cookie(refreshCookieName, refreshToken, refreshCookieOptions);
  await writeAuditLog({ req, businessId: business._id, actor: { type: "USER", userId: user._id, email: user.email, role: user.role }, action: "USER_REGISTERED", entityType: "USER", entityId: user._id, metadata: { authProvider: user.authProvider } });
  res.status(201).json({
    message: "Registration successful",
    data: await buildAuthPayload({ user, business: trialBusiness || business, accessToken }),
  });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  const user = await resolvePasswordLoginUser(normalizedEmail);
  let business = await Business.findById(user.businessId);

  if (!business) {
    throw new AppError("Invalid credentials", 401);
  }

  if (!user.isActive) {
    throw new AppError("This user account has been deactivated", 403);
  }

  // Account lockout check — runs before bcrypt to fail fast
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const secondsLeft = Math.max(1, Math.ceil((user.lockedUntil - Date.now()) / 1000));
    const minutesLeft = Math.ceil((user.lockedUntil - Date.now()) / 60000);
    res.set("Retry-After", String(secondsLeft));
    throw new AppError(
      `Account temporarily locked, try again in ${minutesLeft} minute(s)`,
      423
    );
  }

  const passwordMatches = await comparePassword(password, user.password);

  if (!passwordMatches) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= 5) {
      user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
    }
    await user.save();
    throw new AppError("Invalid credentials", 401);
  }

  // Reset lockout state on successful login
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();
  business = await ensureSelfHostedBusinessProfile(business);

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user, {
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.cookie(refreshCookieName, refreshToken, refreshCookieOptions);
  await writeAuditLog({ req, businessId: business._id, actor: { type: "USER", userId: user._id, email: user.email, role: user.role }, action: "USER_LOGIN", entityType: "USER", entityId: user._id, metadata: { authProvider: user.authProvider } });
  res.status(200).json({
    message: "Login successful",
    data: await buildAuthPayload({ user, business, accessToken }),
  });
});

const googleAuth = asyncHandler(async (req, res) => {
  const identity = await verifyGoogleIdentityToken(req.body.idToken, req.body.nonce || "");
  const mode = req.body.mode === "signup" ? "signup" : "login";
  const normalizedEmail = identity.email;
  let users = await User.find({ email: normalizedEmail }).limit(2);

  if (users.length > 1) {
    throw new AppError("Multiple accounts found for this verified Google email. Please contact support to merge accounts.", 409);
  }

  let user = users[0] || null;
  let business = user ? await Business.findById(user.businessId) : null;

  if (user && user.googleSubject && user.googleSubject !== identity.subject) {
    throw new AppError("This email is already linked to another Google account.", 409);
  }

  if (!user && mode !== "signup") {
    throw new AppError("No BillStack account exists for this Google email. Please create an account first.", 404);
  }

  if (!user) {
    const businessName = (req.body.businessName || `${identity.name}'s Workspace`).trim();
    business = await Business.create({
      name: businessName,
      slug: await buildUniqueBusinessSlug(businessName),
      deploymentMode: getDeploymentMode(),
    });
    user = await User.create({
      businessId: business._id,
      name: (req.body.name || identity.name).trim(),
      email: normalizedEmail,
      password: "",
      role: "owner",
      authProvider: "google",
      googleSubject: identity.subject,
      googleEmailVerified: true,
      googleLinkedAt: new Date(),
    });
    business.ownerUserId = user._id;
    await business.save();
    business = await ensureSelfHostedBusinessProfile(business);
    await startTrialForNewBusiness({ businessId: business._id, trialSource: "google_signup" });
    business = await Business.findById(business._id);
  } else {
    if (!business) throw new AppError("Business context is invalid", 403);
    if (!user.isActive) throw new AppError("This user account has been deactivated", 403);
    user.googleSubject = identity.subject;
    user.googleEmailVerified = true;
    user.googleLinkedAt = user.googleLinkedAt || new Date();
    user.authProvider = user.password ? "password_google" : "google";
    await user.save();
  }

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user, {
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  res.cookie(refreshCookieName, refreshToken, refreshCookieOptions);
  await writeAuditLog({ req, businessId: business._id, actor: { type: "USER", userId: user._id, email: user.email, role: user.role }, action: mode === "signup" && !users.length ? "GOOGLE_USER_REGISTERED" : "GOOGLE_USER_LOGIN", entityType: "USER", entityId: user._id, metadata: { authProvider: user.authProvider, googleLinked: true } });
  res.status(mode === "signup" && !users.length ? 201 : 200).json({
    message: mode === "signup" && !users.length ? "Google registration successful" : "Google login successful",
    data: await buildAuthPayload({ user, business, accessToken }),
  });
});

const forgotPassword = asyncHandler(async (req, res) => {
  const normalizedEmail = req.body.email.trim().toLowerCase();
  const users = await User.find({ email: normalizedEmail }).limit(2).select("+passwordResetToken +passwordResetExpiresAt");

  if (users.length === 1 && users[0].isActive) {
    const user = users[0];
    const token = crypto.randomBytes(32).toString("hex");
    const resetUrl = `${getClientUrl().replace(/\/$/, "")}/reset-password?token=${token}`;

    user.passwordResetToken = hashResetToken(token);
    user.passwordResetExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    sendEmail({
      to: user.email,
      subject: "Reset your BillStack password",
      text: `Reset your BillStack password using this link: ${resetUrl}\n\nThis link expires in 30 minutes.`,
      html: `
        <p>Hello ${user.name},</p>
        <p>Use the link below to reset your BillStack password. This link expires in 30 minutes.</p>
        <p><a href="${resetUrl}">Reset password</a></p>
        <p>If you did not request this, you can ignore this email.</p>
      `,
    }).catch((err) => console.error("Failed to send reset email:", err));
  }

  res.status(200).json({
    message: "If an account exists for this email, a reset link has been sent.",
  });
});

const resetPassword = asyncHandler(async (req, res) => {
  const resetToken = hashResetToken(req.body.token.trim());
  const user = await User.findOne({
    passwordResetToken: resetToken,
    passwordResetExpiresAt: { $gt: new Date() },
  }).select("+passwordResetToken +passwordResetExpiresAt");

  if (!user) {
    throw new AppError("Password reset link is invalid or expired", 400);
  }

  user.password = await hashPassword(req.body.password);
  user.passwordResetToken = "";
  user.passwordResetExpiresAt = null;
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();

  res.status(200).json({
    message: "Password reset successfully. Please sign in with your new password.",
  });
});

const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies[refreshCookieName];

  if (!refreshToken) {
    throw new AppError("Refresh token is required", 401);
  }

  const tokenRecord = await findRefreshToken(refreshToken);

  if (!tokenRecord) {
    throw new AppError("Refresh token is invalid or expired", 401);
  }

  if (tokenRecord.isRevoked) {
    await revokeRefreshTokenFamily(tokenRecord.familyId);
    res.clearCookie(refreshCookieName, refreshCookieOptions);
    throw new AppError("Refresh token reuse detected. Please sign in again.", 401);
  }

  if (tokenRecord.expiresAt <= new Date()) {
    await revokeRefreshToken(refreshToken);
    res.clearCookie(refreshCookieName, refreshCookieOptions);
    throw new AppError("Refresh token is invalid or expired", 401);
  }

  const validTokenRecord = await findValidRefreshToken(refreshToken);
  const user = await User.findById(validTokenRecord.userId);
  let business = await Business.findById(tokenRecord.businessId);

  if (!user || !business || user.businessId.toString() !== business._id.toString()) {
    throw new AppError("Refresh session is no longer valid", 401);
  }

  if (!user.isActive) {
    throw new AppError("This user account has been deactivated", 403);
  }
  business = await ensureSelfHostedBusinessProfile(business);

  const scopedUser = await require("../services/billing-entity.service").resolveEntityUser(user, req.headers["x-business-id"]);
  const scopedBusiness = await Business.findById(scopedUser.businessId);
  if (!scopedBusiness || scopedBusiness.isDisabled) throw new AppError("Billing entity unavailable", 403);

  const nextRefreshToken = await issueRefreshToken(user, {
    familyId: tokenRecord.familyId,
    ipAddress: req.ip,
    userAgent: req.get("user-agent"),
  });

  await revokeRefreshToken(refreshToken, {
    replacedByToken: nextRefreshToken,
  });

  const nextAccessToken = signAccessToken(scopedUser);

  res.cookie(refreshCookieName, nextRefreshToken, refreshCookieOptions);
  res.status(200).json({
    message: "Token refreshed",
    data: await buildAuthPayload({ user: scopedUser, business: scopedBusiness, accessToken: nextAccessToken }),
  });
});

const getMe = asyncHandler(async (req, res) => {
  let business = await Business.findById(req.user.businessId);

  if (!business || business._id.toString() !== req.tenant.businessId) {
    throw new AppError("Business context is invalid", 403);
  }
  business = await ensureSelfHostedBusinessProfile(business);

  res.status(200).json({
    message: "Current session",
    data: {
      user: req.user,
      business: serializeBusinessWithPlan(business, req.subscription),
    },
  });
});

const logout = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies[refreshCookieName];
  await revokeRefreshToken(refreshToken);
  await writeAuditLog({ req, businessId: req.user?.businessId, action: "USER_LOGOUT", entityType: "USER", entityId: req.user?._id });

  res.clearCookie(refreshCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  res.status(200).json({
    message: "Logged out successfully",
  });
});

module.exports = {
  forgotPassword,
  getMe,
  login,
  googleAuth,
  logout,
  refresh,
  register,
  resetPassword,
};
