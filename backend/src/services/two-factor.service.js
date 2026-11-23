const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const AppError = require("../utils/appError");
const { canSeal, open, seal } = require("../utils/secretBox");
const totp = require("../utils/totp");

// Two-step sign-in: after the password (or Google), a user who switched it on gives a 6-digit code
// from their authenticator app, or one of their one-time recovery codes.

const CHALLENGE_MINUTES = 5;
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODES = 10;

// The challenge is signed with a key derived from JWT_SECRET, so it can never pass as an access token.
const challengeKey = () => crypto.createHmac("sha256", String(process.env.JWT_SECRET || "")).update("billstack-2fa-challenge").digest();

const issueChallenge = (user, method = "password") =>
  jwt.sign({ sub: String(user._id), method }, challengeKey(), { expiresIn: `${CHALLENGE_MINUTES}m`, audience: "billstack-2fa" });

const readChallenge = (token) => {
  try {
    return jwt.verify(String(token || ""), challengeKey(), { audience: "billstack-2fa" });
  } catch {
    throw new AppError("The sign-in step expired. Sign in again.", 401);
  }
};

const hashRecovery = (code) => crypto.createHash("sha256").update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
const newRecoveryCodes = () =>
  Array.from({ length: RECOVERY_CODES }, () => {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });

const withSecrets = (userId) => User.findById(userId).select("+twoFactor.secretSealed +twoFactor.pendingSecretSealed +twoFactor.recoveryCodeHashes +twoFactor.lastStep");

/**
 * Checks a code for a user with two-step on: an authenticator code (each one usable once) or a
 * recovery code (crossed off). Five wrong codes lock it for 15 minutes.
 */
const checkCode = async (user, code) => {
  const tf = user.twoFactor || {};
  if (tf.lockedUntil && tf.lockedUntil > new Date()) {
    throw new AppError(`Too many wrong codes. Try again in ${Math.ceil((tf.lockedUntil - Date.now()) / 60000)} minute(s).`, 423);
  }
  const secret = tf.secretSealed ? open(tf.secretSealed) : "";
  const step = totp.verifyCode(secret, code, { afterStep: Number(tf.lastStep ?? -1) });
  let ok = step !== null;
  let usedRecovery = false;
  if (ok) {
    user.twoFactor.lastStep = step;
  } else {
    const hash = hashRecovery(code);
    const index = (tf.recoveryCodeHashes || []).indexOf(hash);
    if (String(code || "").replace(/\s/g, "").length > 6 && index >= 0) {
      user.twoFactor.recoveryCodeHashes.splice(index, 1);
      ok = true;
      usedRecovery = true;
    }
  }
  if (!ok) {
    user.twoFactor.failedAttempts = Number(tf.failedAttempts || 0) + 1;
    if (user.twoFactor.failedAttempts >= MAX_FAILURES) {
      user.twoFactor.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
      user.twoFactor.failedAttempts = 0;
    }
    user.markModified("twoFactor");
    await user.save();
    throw new AppError("That code is not right", 401);
  }
  user.twoFactor.failedAttempts = 0;
  user.twoFactor.lockedUntil = null;
  user.markModified("twoFactor");
  await user.save();
  return { usedRecovery, recoveryLeft: (user.twoFactor.recoveryCodeHashes || []).length };
};

/** Second step of sign-in: the challenge from the first step and a code. Answers the user. */
const completeChallenge = async ({ challengeToken, code }) => {
  const claims = readChallenge(challengeToken);
  const user = await withSecrets(claims.sub);
  if (!user || !user.isActive || !user.twoFactor?.enabled) throw new AppError("The sign-in step expired. Sign in again.", 401);
  const result = await checkCode(user, code);
  return { user, method: claims.method, ...result };
};

const status = async (userId) => {
  const user = await withSecrets(userId);
  if (!user) throw new AppError("User not found", 404);
  return { enabled: Boolean(user.twoFactor?.enabled), enabledAt: user.twoFactor?.enabledAt || null, recoveryLeft: (user.twoFactor?.recoveryCodeHashes || []).length, canStoreSecrets: canSeal() };
};

/** Starts setup: a new secret, kept pending until a code from the app proves it was added. */
const startSetup = async (userId) => {
  if (!canSeal()) throw new AppError("The server cannot store the secret yet (BILLSTACK_DATA_KEY is not set).", 400);
  const user = await withSecrets(userId);
  if (!user) throw new AppError("User not found", 404);
  if (user.twoFactor?.enabled) throw new AppError("Two-step sign-in is already on. Switch it off first to move it to a new phone.", 409);
  const secret = totp.generateSecret();
  user.twoFactor = { ...(user.twoFactor?.toObject?.() || user.twoFactor || {}), pendingSecretSealed: seal(secret) };
  user.markModified("twoFactor");
  await user.save();
  return { secret, otpauthUrl: totp.otpauthUrl({ secret, account: user.email }) };
};

/** Finishes setup with a code from the app; answers the recovery codes (shown once). */
const confirmSetup = async (userId, code) => {
  const user = await withSecrets(userId);
  if (!user) throw new AppError("User not found", 404);
  const pending = user.twoFactor?.pendingSecretSealed ? open(user.twoFactor.pendingSecretSealed) : "";
  if (!pending) throw new AppError("Start the setup first", 400);
  const step = totp.verifyCode(pending, code);
  if (step === null) throw new AppError("That code is not right. Check the phone's time is set automatically and try the newest code.", 400);
  const codes = newRecoveryCodes();
  user.twoFactor = { enabled: true, secretSealed: seal(pending), pendingSecretSealed: "", recoveryCodeHashes: codes.map(hashRecovery), lastStep: step, failedAttempts: 0, lockedUntil: null, enabledAt: new Date() };
  user.markModified("twoFactor");
  await user.save();
  return { enabled: true, recoveryCodes: codes };
};

/** Switching off needs a current code (or a recovery code), not just a signed-in browser. */
const disable = async (userId, code) => {
  const user = await withSecrets(userId);
  if (!user?.twoFactor?.enabled) throw new AppError("Two-step sign-in is not on", 400);
  await checkCode(user, code);
  user.twoFactor = { enabled: false, secretSealed: "", pendingSecretSealed: "", recoveryCodeHashes: [], lastStep: -1, failedAttempts: 0, lockedUntil: null, enabledAt: null };
  user.markModified("twoFactor");
  await user.save();
  return { enabled: false };
};

/** For an owner / admin helping someone who lost their phone and recovery codes. */
const resetForUser = async ({ actor, userId }) => {
  const user = await User.findOne({ _id: userId, businessId: actor.businessId });
  if (!user) throw new AppError("User not found", 404);
  if (String(user._id) === String(actor._id)) throw new AppError("Use your own recovery codes, or ask another owner / admin", 400);
  if (user.role === "owner" && actor.role !== "owner") throw new AppError("Only an owner can reset an owner's two-step sign-in", 403);
  user.twoFactor = { enabled: false, secretSealed: "", pendingSecretSealed: "", recoveryCodeHashes: [], lastStep: -1, failedAttempts: 0, lockedUntil: null, enabledAt: null };
  user.markModified("twoFactor");
  await user.save();
  return { enabled: false };
};

module.exports = { checkCode, completeChallenge, confirmSetup, disable, hashRecovery, issueChallenge, readChallenge, resetForUser, startSetup, status };
