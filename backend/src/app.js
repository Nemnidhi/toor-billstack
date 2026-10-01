const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const morgan = require("morgan");
const mongoSanitize = require("express-mongo-sanitize");

const { buildCorsOptions } = require("./config/cors");
const { logoUploadDirectory, signatureUploadDirectory } = require("./config/upload");
const { requestContext } = require("./middlewares/request-context.middleware");
const { apiRateLimiter } = require("./middlewares/rate-limit.middleware");
const { log } = require("./utils/logger");
const accountingRoutes = require("./routes/accounting.routes");
const auditRoutes = require("./routes/audit.routes");
const authRoutes = require("./routes/auth.routes");
const businessRoutes = require("./routes/business.routes");
const customerRoutes = require("./routes/customer.routes");
const communicationRoutes = require("./routes/communication.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const billingRoutes = require("./routes/billing.routes");
const featureRoutes = require("./routes/feature.routes");
const healthRoutes = require("./routes/health.routes");
const hrRoutes = require("./routes/hr.routes");
const invoiceRoutes = require("./routes/invoice.routes");
const integrationRoutes = require("./routes/integration.routes");
const planRoutes = require("./routes/plan.routes");
const moduleRoutes = require("./routes/module.routes");
  const paymentRoutes = require("./routes/payment.routes");
  const quoteRoutes = require("./routes/quote.routes");
  const salesLifecycleRoutes = require("./routes/sales-lifecycle.routes");
const sharedOperationsRoutes = require("./routes/shared-operations.routes");
const workflowRoutes = require("./routes/workflow.routes");
const gstRoutes = require("./routes/gst.routes");
const expenseRoutes = require("./routes/expense.routes");
const productRoutes = require("./routes/product.routes");
const purchaseRoutes = require("./routes/purchase.routes");
const reportRoutes = require("./routes/report.routes");
const supplierRoutes = require("./routes/supplier.routes");
const teamRoutes = require("./routes/team.routes");
const superAdminRoutes = require("./routes/super-admin.routes");
const { notFound, errorHandler } = require("./middlewares/error.middleware");

const app = express();
app.set("trust proxy", 1);
const jsonParser = express.json({
  limit: "1mb",
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
});
const corsMiddleware = cors(buildCorsOptions());

morgan.token("requestId", (req) => req.requestId);
morgan.token('safeUrl', require('./utils/integrationLogUrl').integrationLogUrl);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use((req, res, next) => {
  if (
    req.originalUrl.startsWith("/api/billing/webhook") ||
    req.originalUrl.startsWith("/api/billing/subscription/callback")
  ) {
    return next();
  }

  return corsMiddleware(req, res, next);
});
app.use(cookieParser());
app.use(requestContext);
app.use((req, res, next) => {
  if (req.originalUrl.startsWith("/api/billing/webhook")) {
    return next();
  }

  return jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(mongoSanitize());
app.use(
  morgan(":method :safeUrl :status :response-time ms req=:requestId", {
    stream: {
      write: (message) => log("info", message.trim()),
    },
  })
);
app.use(
  "/uploads/logos",
  express.static(logoUploadDirectory, {
    immutable: true,
    maxAge: "1d",
    setHeaders: (res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);
app.use(
  "/uploads/signatures",
  express.static(signatureUploadDirectory, {
    immutable: true,
    maxAge: "1d",
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  })
);
app.use("/api", apiRateLimiter);

app.use("/api/health", healthRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api/audit-logs", auditRoutes);
app.use("/api/hr", hrRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/super-admin", superAdminRoutes);
app.use("/api/business", businessRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/communications", communicationRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/plans", planRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/quotes", quoteRoutes);
  app.use("/api/sales", salesLifecycleRoutes);
app.use("/api/shared-operations", sharedOperationsRoutes);
app.use("/api/gst", gstRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/products", productRoutes);
app.use("/api/purchases", purchaseRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/features", featureRoutes);
app.use("/api/modules", moduleRoutes);
app.use("/api/workflows", workflowRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
