const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const retryAfterSeconds = (req) => Math.max(
  1,
  Math.ceil(((req.rateLimit?.resetTime?.getTime?.() || Date.now() + 60000) - Date.now()) / 1000)
);

const createAuthLimiter = ({ windowMs, max, message }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfter = retryAfterSeconds(req);
    res.set("Retry-After", String(retryAfter));
    res.status(429).json({ message, retryAfter });
  },
});

// Only failed sign-ins count: the whole office signs in from one address each
// morning, and that must not lock anyone out.
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const retryAfter = retryAfterSeconds(req);
    res.set("Retry-After", String(retryAfter));
    res.status(429).json({ message: "Too many failed sign-in attempts. Please wait before trying again.", retryAfter });
  },
});

const passwordRecoveryRateLimiter = createAuthLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.PASSWORD_RECOVERY_RATE_LIMIT_MAX || 5),
  message: "Too many password recovery requests. Please wait before trying again.",
});

const registrationRateLimiter = createAuthLimiter({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTRATION_RATE_LIMIT_MAX || 10),
  message: "Too many registration attempts. Please wait before trying again.",
});

const tokenRateLimiter = createAuthLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.TOKEN_RATE_LIMIT_MAX || 120),
  message: "Too many session requests. Please wait before trying again.",
});

// Everyone in the office reaches the server from the same public address, so the
// API limit is counted per signed-in session (address + token), with a much
// higher ceiling per address as a backstop against abuse.
const sessionKey = (req) => {
  const ip = ipKeyGenerator(req.ip || "");
  const authorization = req.get("authorization") || "";
  if (!authorization) return ip;
  return `${ip}:${crypto.createHash("sha256").update(authorization).digest("hex").slice(0, 24)}`;
};

const apiSessionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 300),
  keyGenerator: sessionKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: "Too many API requests. Please slow down and try again.",
  },
});

const apiAddressRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_PER_ADDRESS_MAX || 3000),
  standardHeaders: false,
  legacyHeaders: false,
  message: {
    message: "Too many API requests from this network. Please slow down and try again.",
  },
});

const apiRateLimiter = [apiAddressRateLimiter, apiSessionRateLimiter];

module.exports = {
  apiRateLimiter,
  authRateLimiter,
  passwordRecoveryRateLimiter,
  registrationRateLimiter,
  tokenRateLimiter,
};
