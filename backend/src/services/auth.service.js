const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const RefreshToken = require("../models/RefreshToken");
const { ensureBusinessSubscription } = require("../utils/subscription");
const { serializeBusinessWithPlan } = require("../utils/businessPlan");

const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "15m";
const REFRESH_TOKEN_DAYS = Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 7);

const signAccessToken = (user) =>
  jwt.sign(
    {
      sub: user._id.toString(),
      businessId: user.businessId.toString(),
      role: user.role,
      email: user.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );

const verifyAccessToken = (token) => jwt.verify(token, process.env.JWT_SECRET);

const hashPassword = (password) => bcrypt.hash(password, 12);

const comparePassword = (password, hashedPassword) =>
  bcrypt.compare(password, hashedPassword);

const generateRefreshTokenValue = () => crypto.randomBytes(48).toString("hex");
const generateTokenFamilyId = () => crypto.randomUUID();

const issueRefreshToken = async (user, meta = {}) => {
  const token = generateRefreshTokenValue();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);

  await RefreshToken.create({
    userId: user._id,
    businessId: user.businessId,
    token,
    familyId: meta.familyId || generateTokenFamilyId(),
    expiresAt,
    replacedByToken: "",
    ipAddress: meta.ipAddress || "",
    userAgent: meta.userAgent || "",
  });

  return token;
};

const revokeRefreshToken = async (token, updates = {}) => {
  if (!token) {
    return;
  }

  await RefreshToken.findOneAndUpdate(
    { token },
    {
      isRevoked: true,
      revokedAt: new Date(),
      ...updates,
    }
  );
};

const findRefreshToken = async (token) => RefreshToken.findOne({ token });

const findValidRefreshToken = async (token) => {
  const tokenRecord = await findRefreshToken(token);

  if (!tokenRecord) {
    return null;
  }

  if (tokenRecord.isRevoked || tokenRecord.expiresAt <= new Date()) {
    return null;
  }

  return tokenRecord;
};

const revokeRefreshTokenFamily = async (familyId) => {
  if (!familyId) {
    return;
  }

  await RefreshToken.updateMany(
    { familyId, isRevoked: false },
    {
      isRevoked: true,
      revokedAt: new Date(),
    }
  );
};

// After a password is reset or changed by an admin, every device signed in as
// that person is signed out (their refresh tokens stop working).
const revokeAllUserRefreshTokens = async (userId) => {
  if (!userId) return;
  await RefreshToken.updateMany({ userId, isRevoked: false }, { isRevoked: true, revokedAt: new Date() });
};

// Two tabs (or a tab and a retry) often refresh at the same moment with the same
// cookie. The first one rotates it; the second must not be treated as a stolen
// token. For a short window after a rotation, the old token leads to its
// replacement instead of revoking the whole sign-in.
const REFRESH_GRACE_MS = Number(process.env.REFRESH_TOKEN_GRACE_MS || 30000);
const findGraceReplacement = async (record) => {
  let current = record;
  for (let hop = 0; hop < 3; hop += 1) {
    if (!current?.isRevoked || !current.replacedByToken || !current.revokedAt) return null;
    if (Date.now() - new Date(current.revokedAt).getTime() > REFRESH_GRACE_MS) return null;
    const next = await findRefreshToken(current.replacedByToken);
    if (!next || String(next.familyId) !== String(record.familyId)) return null;
    if (!next.isRevoked && next.expiresAt > new Date()) return next;
    current = next;
  }
  return null;
};

const buildAuthPayload = async ({ user, business, accessToken }) => {
  const subscription = await ensureBusinessSubscription({
    businessId: business._id,
    planCode: business.planCode,
  });

  return ({
  accessToken,
  user: {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: {
      canManageHR: Boolean(user.permissions?.canManageHR),
      canViewHR: Boolean(user.permissions?.canViewHR),
    },
    isActive: user.isActive,
    businessId: user.businessId,
    authProvider: user.authProvider,
    googleLinked: Boolean(user.googleSubject && user.googleEmailVerified),
  },
  business: serializeBusinessWithPlan(business, subscription),
});
};

module.exports = {
  revokeAllUserRefreshTokens,
  findGraceReplacement,
  buildAuthPayload,
  comparePassword,
  findRefreshToken,
  findValidRefreshToken,
  generateTokenFamilyId,
  hashPassword,
  issueRefreshToken,
  revokeRefreshToken,
  revokeRefreshTokenFamily,
  signAccessToken,
  verifyAccessToken,
};
