const express = require("express");

const {
  forgotPassword,
  getMe,
  login,
  googleAuth,
  logout,
  refresh,
  register,
  resetPassword,
  signupStatus,
} = require("../controllers/auth.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const tenantMiddleware = require("../middlewares/tenant.middleware");
const validate = require("../middlewares/validate.middleware");
const {
  forgotPasswordValidator,
  loginValidator,
  registerValidator,
  resetPasswordValidator,
} = require("../validators/auth.validation");
const {
  authRateLimiter,
  passwordRecoveryRateLimiter,
  registrationRateLimiter,
  tokenRateLimiter,
} = require("../middlewares/rate-limit.middleware");

const router = express.Router();

router.get("/signup-status", signupStatus);
router.post("/register", registrationRateLimiter, validate(registerValidator), register);
router.post("/login", authRateLimiter, validate(loginValidator), login);
router.post("/google", authRateLimiter, googleAuth);
router.post("/forgot-password", passwordRecoveryRateLimiter, validate(forgotPasswordValidator), forgotPassword);
router.post("/reset-password", passwordRecoveryRateLimiter, validate(resetPasswordValidator), resetPassword);
router.post("/refresh", tokenRateLimiter, refresh);
router.post("/logout", logout);
router.get("/me", authMiddleware, tenantMiddleware, getMe);

module.exports = router;
