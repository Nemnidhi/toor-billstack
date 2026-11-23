const mongoose = require("mongoose");

const MessageDelivery = require("../models/MessageDelivery");
const MessageTemplate = require("../models/MessageTemplate");
const ReminderRule = require("../models/ReminderRule");
const ScheduledReminder = require("../models/ScheduledReminder");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const {
  createReminderRule,
  ensureDefaultTemplates,
  getWhatsAppProviderStatus,
  extractTemplateVariables,
  normalizeChannel,
  normalizeTemplateCategory,
  processDueReminders,
  scheduleReminder,
  sendInvoiceMessage,
  sendQuoteMessage,
  updateDeliveryStatus,
  updateProviderDeliveryStatus,
  validateTemplateVariables,
} = require("../services/communication.service");
const { mapDeliveryStatus, verifyWhatsAppWebhookSignature } = require("../services/whatsapp-provider.service");
const { writeAuditLog } = require("../services/audit.service");

const summary = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  await ensureDefaultTemplates({ businessId, createdBy: req.user._id });
  const [messagesSent, scheduledReminders, failedMessages, deliveredMessages, upcoming] = await Promise.all([
    MessageDelivery.countDocuments({ businessId, status: { $in: ["SENT", "DELIVERED", "READ"] } }),
    ScheduledReminder.countDocuments({ businessId, status: "SCHEDULED" }),
    MessageDelivery.countDocuments({ businessId, status: "FAILED" }),
    MessageDelivery.countDocuments({ businessId, status: { $in: ["DELIVERED", "READ"] } }),
    ScheduledReminder.find({ businessId, status: "SCHEDULED" }).populate("customerId", "name phone email").populate("invoiceId", "invoiceNumber dueDate balanceDue").sort("scheduledFor").limit(8),
  ]);
  res.json({ data: { messagesSent, scheduledReminders, failedMessages, deliveredMessages, upcoming, providerStatus: { whatsapp: getWhatsAppProviderStatus(req.tenant.businessId), email: { configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) }, sms: { configured: false } } } });
});

const templates = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  await ensureDefaultTemplates({ businessId, createdBy: req.user._id });
  res.json({ data: await MessageTemplate.find({ businessId }).sort("category channel name") });
});

const upsertTemplate = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  const channel = normalizeChannel(req.body.channel || "EMAIL");
  const category = normalizeTemplateCategory(req.body.category || "CUSTOM");
  const name = String(req.body.name || "").trim();
  const body = String(req.body.body || "").trim();
  const subject = String(req.body.subject || "").trim();
  if (!name) throw new AppError("Template name is required", 400);
  if (!body) throw new AppError("Template body is required", 400);
  validateTemplateVariables(`${subject}\n${body}`);
  const codeSeed = name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "TEMPLATE";
  const code = String(req.body.code || `${category}_${channel}_${codeSeed}_${Date.now()}`).toUpperCase();
  const isDefault = req.body.isDefault === true;
  if (isDefault) {
    await MessageTemplate.updateMany(
      { businessId, category, channel, code: { $ne: code }, isDefault: true },
      { $set: { isDefault: false } }
    );
  }
  const row = await MessageTemplate.findOneAndUpdate(
    { businessId, code, channel },
    { $set: { name, category, subject, body, variables: extractTemplateVariables(`${subject}\n${body}`), isActive: req.body.isActive !== false || isDefault, isDefault, createdBy: req.user._id } },
    { upsert: true, new: true }
  );
  res.status(201).json({ data: row });
});

const rules = asyncHandler(async (req, res) => {
  res.json({ data: await ReminderRule.find({ businessId: req.tenant.businessId }).populate("templateId", "name channel category").sort("-createdAt") });
});

const createRule = asyncHandler(async (req, res) => {
  const row = await createReminderRule({ businessId: req.tenant.businessId, body: req.body, createdBy: req.user._id });
  await writeAuditLog({ req, action: "REMINDER_RULE_CREATED", entityType: "REMINDER_RULE", entityId: row._id, metadata: { channel: row.channels?.[0], trigger: row.trigger } });
  res.status(201).json({ data: row });
});

const scheduled = asyncHandler(async (req, res) => {
  const filters = { businessId: req.tenant.businessId };
  if (req.query.customerId) filters.customerId = req.query.customerId;
  if (req.query.invoiceId) filters.invoiceId = req.query.invoiceId;
  if (req.query.status) filters.status = req.query.status;
  res.json({ data: await ScheduledReminder.find(filters).populate("customerId", "name phone email").populate("invoiceId", "invoiceNumber dueDate balanceDue paymentStatus").sort("scheduledFor").limit(100) });
});

const deliveries = asyncHandler(async (req, res) => {
  const filters = { businessId: req.tenant.businessId };
  if (req.query.customerId) filters.customerId = req.query.customerId;
  if (req.query.invoiceId) filters.invoiceId = req.query.invoiceId;
  if (req.query.channel) filters.channel = String(req.query.channel).toUpperCase();
  res.json({ data: await MessageDelivery.find(filters).populate("customerId", "name phone email").populate("invoiceId", "invoiceNumber dueDate").sort("-createdAt").limit(100) });
});

const scheduleInvoiceReminder = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let row;
    await session.withTransaction(async () => {
      row = await scheduleReminder({ businessId: req.tenant.businessId, invoiceId: req.params.invoiceId, channel: req.body.channel || "EMAIL", scheduledFor: req.body.scheduledFor, templateId: req.body.templateId, createdBy: req.user._id, session });
    });
    await writeAuditLog({ req, action: "REMINDER_SCHEDULED", entityType: "SCHEDULED_REMINDER", entityId: row._id, metadata: { invoiceId: req.params.invoiceId, channel: row.channel, scheduledFor: row.scheduledFor } });
    res.status(201).json({ data: row });
  } finally {
    session.endSession();
  }
});

const sendInvoice = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let row;
    await session.withTransaction(async () => {
      row = await sendInvoiceMessage({ businessId: req.tenant.businessId, invoiceId: req.params.invoiceId, channel: req.body.channel || "EMAIL", category: req.body.category || "INVOICE_CREATED", templateId: req.body.templateId, createdBy: req.user._id, session });
    });
    await writeAuditLog({ req, action: "INVOICE_COMMUNICATION_SENT", entityType: "MESSAGE_DELIVERY", entityId: row._id, metadata: { invoiceId: req.params.invoiceId, channel: row.channel, status: row.status } });
    res.status(row.status === "SENT" ? 200 : 202).json({ data: row });
  } finally {
    session.endSession();
  }
});

const sendQuote = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let row;
    await session.withTransaction(async () => {
      row = await sendQuoteMessage({ businessId: req.tenant.businessId, quoteId: req.params.quoteId, channel: req.body.channel || "EMAIL", templateId: req.body.templateId, createdBy: req.user._id, session });
    });
    await writeAuditLog({ req, action: "QUOTE_COMMUNICATION_SENT", entityType: "MESSAGE_DELIVERY", entityId: row._id, metadata: { quoteId: req.params.quoteId, channel: row.channel, status: row.status } });
    res.status(row.status === "SENT" ? 200 : 202).json({ data: row });
  } finally {
    session.endSession();
  }
});

const processDue = asyncHandler(async (req, res) => {
  res.json({ data: await processDueReminders({ businessId: req.tenant.businessId, limit: Number(req.body.limit || 25) }) });
});

const webhookStatus = asyncHandler(async (req, res) => {
  const row = await updateDeliveryStatus({ businessId: req.tenant.businessId, providerMessageId: req.body.providerMessageId, status: String(req.body.status || "").toUpperCase(), failureReason: req.body.failureReason || "" });
  res.json({ data: row });
});

// The WhatsApp app telling BillStack how a message went: signed with the shared secret.
const whatsappAppStatusWebhook = asyncHandler(async (req, res) => {
  const { verifyWhatsAppAppSignature } = require("../services/whatsapp-app.service");
  const rawBody = req.rawBody || "";
  if (!verifyWhatsAppAppSignature({ timestamp: req.get("x-oor-timestamp"), rawBody, signature: req.get("x-oor-signature") || "" })) throw new AppError("Invalid signature", 401);
  const { updateWhatsAppAppDeliveryStatus } = require("../services/communication.service");
  const row = await updateWhatsAppAppDeliveryStatus({ key: req.body?.key, status: req.body?.status, reason: req.body?.reason || "" });
  res.json({ ok: true, found: Boolean(row) });
});

const whatsappProviderWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.rawBody || JSON.stringify(req.body || {});
  const signature = req.get("x-whatsapp-signature") || req.get("x-hub-signature-256") || "";
  if (!verifyWhatsAppWebhookSignature({ rawBody, signature })) throw new AppError("Invalid WhatsApp webhook signature", 401);
  const providerMessageId = req.body.providerMessageId || req.body.messageId || req.body.id || req.body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]?.id;
  const providerStatus = req.body.status || req.body.entry?.[0]?.changes?.[0]?.value?.statuses?.[0]?.status;
  if (!providerMessageId || !providerStatus) throw new AppError("Invalid WhatsApp webhook payload", 400);
  const row = await updateProviderDeliveryStatus({ providerMessageId, status: mapDeliveryStatus(providerStatus), failureReason: req.body.failureReason || req.body.error || "" });
  res.json({ data: row });
});

const settings = asyncHandler(async (req, res) => {
  res.json({ data: { whatsapp: getWhatsAppProviderStatus(req.tenant.businessId), email: { configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) }, sms: { configured: false }, timezone: process.env.BILLSTACK_DEFAULT_TIMEZONE || "Asia/Kolkata" } });
});

module.exports = { createRule, deliveries, processDue, rules, scheduleInvoiceReminder, scheduled, sendInvoice, sendQuote, settings, summary, templates, upsertTemplate, webhookStatus, whatsappAppStatusWebhook, whatsappProviderWebhook };
