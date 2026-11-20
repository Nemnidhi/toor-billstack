const { log } = require("../utils/logger");
const { integrationLogUrl } = require('../utils/integrationLogUrl');
const AppError = require("../utils/appError");

const notFound = (req, _res, next) => {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

const FIELD_LABELS = {
  invoiceNumber: "invoice number",
  quoteNumber: "quote number",
  creditNoteNumber: "credit note number",
  email: "email",
  sourceKey: "reference",
  gstNumber: "GST number",
  slug: "name",
};

// Turn the database / parser errors people actually hit into plain, safe
// messages with the right status, instead of a 500 with internal details.
const normalizeKnownError = (error) => {
  if (error.name === "CastError") {
    error.statusCode = 400;
    error.message = `Invalid ${error.path}`;
    return;
  }
  if (error.name === "ValidationError" && error.errors) {
    error.statusCode = 400;
    error.message = Object.values(error.errors).map((item) => item.message).filter(Boolean).join(" ") || "Some details are not valid.";
    return;
  }
  if (error.code === 11000 || error.cause?.code === 11000) {
    const field = Object.keys(error.keyPattern || error.keyValue || {}).find((key) => key !== "businessId") || "";
    error.statusCode = 409;
    error.message = field
      ? `A record with this ${FIELD_LABELS[field] || field} already exists. Refresh and try again.`
      : "This record already exists. Refresh and try again.";
    error.code = "DUPLICATE";
    delete error.keyValue;
    return;
  }
  if (error.type === "entity.too.large") {
    error.statusCode = 413;
    error.message = "What was sent is too large. For a bank statement, import a shorter date range.";
    return;
  }
  if (error.type === "entity.parse.failed") {
    error.statusCode = 400;
    error.message = "The request could not be read.";
  }
};

const errorHandler = (error, req, res, _next) => {
  normalizeKnownError(error);

  const statusCode = error.statusCode || error.status || 500;
  const requestId = req.requestId || "unknown";
  const production = process.env.NODE_ENV === "production";

  if (statusCode >= 500) {
    log("error", integrationLogUrl({ url: error.message || 'Unhandled server error' }), {
      requestId,
      path: integrationLogUrl(req),
      method: req.method,
      stack: error.stack ? integrationLogUrl({ url: error.stack }) : undefined,
    });
  }

  // An unexpected server error's own text can name collections, fields or
  // internals. On the live server people get a plain message and the request id
  // (to find the full error in the log); messages written for people
  // (AppError) are kept.
  const unexpected = statusCode >= 500 && !(error instanceof AppError);
  const message = unexpected && production
    ? `Something went wrong on the server. If it keeps happening, quote reference ${requestId}.`
    : error.message || "Internal server error";

  res.status(statusCode).json({
    message,
    code: typeof error.code === "string" ? error.code : undefined,
    feature: error.feature,
    current: error.current,
    limit: error.limit,
    recommendedAction: error.recommendedAction,
    duplicates: error.duplicates,
    requestId,
    stack: production ? undefined : error.stack,
  });
};

module.exports = {
  notFound,
  errorHandler,
};
