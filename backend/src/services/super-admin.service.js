const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const SUPER_ADMIN_AUDIENCE = "billstack-super-admin";

// Super-admin tokens are never signed with the same key as ordinary sign-ins.
// If SUPER_ADMIN_JWT_SECRET is not set, a separate key is derived from
// JWT_SECRET, so a leaked or confused user token can never pass as a super-admin one.
const getSuperAdminSecret = () => {
  if (process.env.SUPER_ADMIN_JWT_SECRET) return process.env.SUPER_ADMIN_JWT_SECRET;
  if (!process.env.JWT_SECRET) {
    throw new Error("Super admin token secret is not configured");
  }
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update("billstack-super-admin-token-key").digest("hex");
};

const signSuperAdminToken = (payload) =>
  jwt.sign(payload, getSuperAdminSecret(), { expiresIn: "12h", audience: SUPER_ADMIN_AUDIENCE });

const verifySuperAdminToken = (token) => jwt.verify(token, getSuperAdminSecret(), { audience: SUPER_ADMIN_AUDIENCE });

module.exports = {
  signSuperAdminToken,
  verifySuperAdminToken,
};
