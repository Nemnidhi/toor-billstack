const asyncHandler = require("../utils/asyncHandler");
const mongoose = require("mongoose");
const { validateEnvironment } = require("../config/env");
const { getWhatsAppProviderStatus } = require("../services/whatsapp-provider.service");
const { getMongoTransactionReadiness } = require("../utils/mongo-readiness");

// Anyone on the internet can call these. Outsiders get only up / ready; the
// details (configuration warnings, which providers are set up, memory) are for
// checks run on the server itself (curl 127.0.0.1:<port>) or callers that send
// the HEALTH_DETAILS_TOKEN.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const canSeeDetails = (req) => {
  const token = process.env.HEALTH_DETAILS_TOKEN || "";
  if (token && req.get("x-health-token") === token) return true;
  return LOOPBACK.has(req.ip) && LOOPBACK.has(req.socket?.remoteAddress || "");
};

const getHealth = asyncHandler(async (req, res) => {
  if (!canSeeDetails(req)) {
    return res.status(200).json({ status: "ok", service: "billstack-backend", timestamp: new Date().toISOString() });
  }
  const memory = process.memoryUsage();

  res.status(200).json({
    status: "ok",
    service: "billstack-backend",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    environment: process.env.NODE_ENV || "development",
    memory: {
      rssMb: Number((memory.rss / 1024 / 1024).toFixed(2)),
      heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(2)),
      heapTotalMb: Number((memory.heapTotal / 1024 / 1024).toFixed(2)),
    },
  });
});

const getReadiness = asyncHandler(async (req, res) => {
  const dbReady = mongoose.connection.readyState === 1;
  const env = validateEnvironment({ throwOnError: false });
  const ready = dbReady && env.ok;
  if (!canSeeDetails(req)) {
    return res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", service: "billstack-backend", timestamp: new Date().toISOString() });
  }
  const transactionReadiness = await getMongoTransactionReadiness();

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    service: "billstack-backend",
    timestamp: new Date().toISOString(),
    checks: {
      api: {
        ready: true,
      },
      database: {
        ready: dbReady,
        state: mongoose.connection.readyState,
        topology: transactionReadiness.topology,
        transactionCapable: transactionReadiness.transactionCapable,
      },
      env: {
        ready: env.ok,
        missingRequiredCount: env.missing.length,
        warnings: env.warnings,
        productionFrontendOriginsConfigured: env.origins.frontend.length,
        productionBackendOriginsConfigured: env.origins.backend.length,
      },
      providers: {
        google: {
          enabled: env.features.googleLogin,
          configured: Boolean(process.env.GOOGLE_CLIENT_ID),
        },
        razorpay: {
          liveBillingEnabled: env.features.liveBilling,
          configured: Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET),
        },
        whatsapp: getWhatsAppProviderStatus(),
        email: { configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) },
      },
      worker: {
        reminderWorkerSupported: true,
        pollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS || 30000),
        batchSize: Number(process.env.WORKER_BATCH_SIZE || 25),
      },
    },
  });
});

module.exports = {
  getHealth,
  getReadiness,
};
