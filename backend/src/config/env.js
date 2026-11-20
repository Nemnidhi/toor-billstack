const parseBoolean = (value) => String(value || "").toLowerCase() === "true";

const splitOrigins = (value) =>
  String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const isProduction = () => process.env.NODE_ENV === "production";
const isLiveBillingEnabled = () => parseBoolean(process.env.RAZORPAY_LIVE_BILLING_ENABLED || process.env.BILLING_LIVE_ENABLED);
const isGoogleLoginEnabled = () => parseBoolean(process.env.GOOGLE_LOGIN_ENABLED) || Boolean(process.env.GOOGLE_CLIENT_ID);
const isEmailEnabled = () => parseBoolean(process.env.EMAIL_SEND_ENABLED || process.env.SMTP_ENABLED) || Boolean(process.env.SMTP_HOST || process.env.SMTP_USER || process.env.SMTP_PASS);
const isWhatsAppSendingEnabled = () => parseBoolean(process.env.WHATSAPP_SEND_ENABLED);

const getConfiguredOrigins = () => splitOrigins([process.env.CLIENT_URL, process.env.FRONTEND_ORIGINS, process.env.PRODUCTION_FRONTEND_ORIGINS].filter(Boolean).join(","));

const getBackendOrigins = () => splitOrigins([process.env.API_BASE_URL, process.env.BASE_URL, process.env.BACKEND_ORIGINS, process.env.PRODUCTION_BACKEND_ORIGINS].filter(Boolean).join(","));

const requireGroup = (missing, enabled, keys) => {
  if (!enabled) return;
  for (const key of keys) {
    if (!process.env[key]) missing.push(key);
  }
};

const validateEnvironment = ({ throwOnError = true } = {}) => {
  const missing = [];
  const warnings = [];

  for (const key of ["MONGO_URI", "JWT_SECRET"]) {
    if (!process.env[key]) missing.push(key);
  }

  if (isProduction()) {
    if (!getConfiguredOrigins().length) missing.push("CLIENT_URL or FRONTEND_ORIGINS");
    if (!getBackendOrigins().length) missing.push("API_BASE_URL or BASE_URL");
    if (String(process.env.JWT_SECRET || "").length < 32) warnings.push("JWT_SECRET should be at least 32 characters in production.");
    if (!process.env.SUPER_ADMIN_JWT_SECRET) warnings.push("SUPER_ADMIN_JWT_SECRET is not set; super admin tokens use a key derived from JWT_SECRET.");
    if (process.env.SUPER_ADMIN_PASSWORD && !process.env.SUPER_ADMIN_PASSWORD_HASH) warnings.push("SUPER_ADMIN_PASSWORD is stored in plain text; set SUPER_ADMIN_PASSWORD_HASH (bcrypt) instead and remove it.");
  } else if (!getConfiguredOrigins().length) {
    warnings.push("No frontend origin configured; localhost development origins will be used.");
  }

  requireGroup(missing, isLiveBillingEnabled(), ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]);
  requireGroup(missing, isGoogleLoginEnabled(), ["GOOGLE_CLIENT_ID"]);
  requireGroup(missing, isEmailEnabled(), ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]);
  requireGroup(missing, isWhatsAppSendingEnabled(), ["WHATSAPP_API_BASE_URL", "WHATSAPP_API_TOKEN", "WHATSAPP_ACCOUNT_ID", "WHATSAPP_WEBHOOK_SECRET"]);

  if (parseBoolean(process.env.INTEGRATION_API_ENABLED) && !process.env.INTEGRATION_WEBHOOK_SECRET) {
    missing.push("INTEGRATION_WEBHOOK_SECRET");
  }

  const result = {
    ok: missing.length === 0,
    missing,
    warnings,
    features: {
      liveBilling: isLiveBillingEnabled(),
      googleLogin: isGoogleLoginEnabled(),
      email: isEmailEnabled(),
      whatsappSending: isWhatsAppSendingEnabled(),
      integrationApi: parseBoolean(process.env.INTEGRATION_API_ENABLED),
    },
    origins: {
      frontend: getConfiguredOrigins(),
      backend: getBackendOrigins(),
    },
  };

  if (!result.ok && throwOnError) {
    const error = new Error(`Missing required environment variables: ${missing.join(", ")}`);
    error.code = "ENV_VALIDATION_FAILED";
    error.details = result;
    throw error;
  }

  return result;
};

module.exports = {
  getBackendOrigins,
  getConfiguredOrigins,
  isEmailEnabled,
  isGoogleLoginEnabled,
  isLiveBillingEnabled,
  isProduction,
  isWhatsAppSendingEnabled,
  parseBoolean,
  validateEnvironment,
};
