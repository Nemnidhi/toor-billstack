const mongoose = require("mongoose");
const os = require("os");

const Business = require("../models/Business");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const MessageDelivery = require("../models/MessageDelivery");
const MessageTemplate = require("../models/MessageTemplate");
const Payment = require("../models/Payment");
const PaymentAllocation = require("../models/PaymentAllocation");
const PaymentAllocationReversal = require("../models/PaymentAllocationReversal");
const Quote = require("../models/Quote");
const ReminderRule = require("../models/ReminderRule");
const ScheduledReminder = require("../models/ScheduledReminder");
const AppError = require("../utils/appError");
const { log } = require("../utils/logger");
const { sendEmail } = require("./email.service");
const { applyFinancialRead } = require("./financial-read.service");
const { getWhatsAppProviderStatus: legacyWhatsAppStatus, sendWhatsAppMessage } = require("./whatsapp-provider.service");
const { sendThroughWhatsAppApp, whatsappAppConfig, whatsappAppServes } = require("./whatsapp-app.service");

// WhatsApp goes through the company's WhatsApp app when it is linked (WHATSAPP_APP_URL / _SECRET):
// one number, Meta-approved templates, the customer's chat. Otherwise the older direct provider.
const getWhatsAppProviderStatus = (businessId = null) => {
  if (whatsappAppConfig()) {
    const serves = businessId ? whatsappAppServes(businessId) : true;
    return { configured: serves, provider: "WHATSAPP_APP", accountId: "", webhookConfigured: true, sendingEnabled: serves, whatsappApp: true, servesThisBusiness: serves };
  }
  return { ...legacyWhatsAppStatus(), whatsappApp: false };
};

// Which WhatsApp-app message a template category is. Others (quotes, credit notes) are not sent there.
const APP_PURPOSE_FOR_CATEGORY = {
  INVOICE_CREATED: "invoice_sent",
  INVOICE_DUE_SOON: "payment_reminder",
  DUE_TODAY: "payment_reminder",
  PAYMENT_OVERDUE: "payment_reminder",
  PAYMENT_REMINDER: "payment_reminder",
  PAYMENT_RECEIVED: "payment_received",
};
const NO_CONSENT_REASON = "The customer has not agreed to WhatsApp messages (tick it on the customer).";
const rupees = (value) => Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const daysPast = (date) => {
  if (!date) return 0;
  const due = new Date(date);
  due.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today - due) / 86400000));
};

/** The WhatsApp app's purpose and values for one message, or null when it has none. */
const appMessageFor = ({ category, invoice, customer, business, payment = {}, paymentLink = "" }) => {
  const purpose = APP_PURPOSE_FOR_CATEGORY[normalizeTemplateCategory(category)];
  if (!purpose) return null;
  const base = {
    name: customer?.name || invoice?.customerDetails?.name || "",
    company: business?.name || invoice?.businessDetails?.name || "",
    invoice_number: invoice?.invoiceNumber || "",
  };
  if (purpose === "invoice_sent") return { purpose, variables: { ...base, amount: rupees(invoice?.grandTotal), due_date: formatDate(invoice?.dueDate), link: paymentLink } };
  if (purpose === "payment_reminder") return { purpose, variables: { ...base, amount: rupees(invoice?.balanceDue), due_date: formatDate(invoice?.dueDate), days_overdue: String(daysPast(invoice?.dueDate)), link: paymentLink } };
  return { purpose, variables: { ...base, amount: rupees(payment.amount), date: formatDate(payment.paymentDate || new Date()), balance: rupees(invoice?.balanceDue) } };
};

const hasWhatsAppConsent = (customer) => Boolean(customer?.whatsappConsent?.given);
const consentOut = (customer) => {
  const consent = customer?.whatsappConsent;
  if (!consent?.given) return undefined;
  return { given: true, ...(consent.at ? { at: new Date(consent.at).toISOString() } : {}), source: String(consent.source || "recorded in BillStack").slice(0, 80) };
};

/**
 * For a WhatsApp message through the app: { app } with its purpose, values and the customer's
 * agreement, or { skip } with the reason it cannot go. Null when WhatsApp goes the older way.
 */
const appPlanFor = ({ businessId, channel, category, invoice, customer, business, payment, paymentLink }) => {
  if (channel !== "WHATSAPP" || !getWhatsAppProviderStatus(businessId).whatsappApp) return null;
  if (!hasWhatsAppConsent(customer)) return { skip: NO_CONSENT_REASON };
  const message = appMessageFor({ category, invoice, customer, business, payment, paymentLink });
  if (!message) return { skip: `The WhatsApp app has no message for ${normalizeTemplateCategory(category)} (only invoice, payment reminder and payment received).` };
  return { app: { ...message, consent: consentOut(customer) } };
};

// A payment link for the invoice's unpaid amount, when the business takes payments online. Never
// stops a message: without one the message goes without a link.
const paymentLinkFor = async ({ businessId, invoice, category }) => {
  const purpose = APP_PURPOSE_FOR_CATEGORY[normalizeTemplateCategory(category)];
  if (purpose === "payment_received" || Number(invoice?.balanceDue || 0) <= 0) return "";
  const { ensureInvoiceLink } = require("./online-payment.service");
  const link = await ensureInvoiceLink({ businessId, invoiceId: invoice._id, quiet: true });
  return link?.url || "";
};

const CHANNELS = ["WHATSAPP", "EMAIL", "SMS", "IN_APP"];
const REMINDER_TYPES = ["BEFORE_DUE_DATE", "ON_DUE_DATE", "AFTER_DUE_DATE", "RECURRING_OVERDUE"];
const EVENT_TYPES = ["INVOICE_ISSUED", "PAYMENT_RECORDED"];
const PAYMENT_CONDITIONS = ["ANY_PAYMENT", "PARTIAL_PAYMENT", "FULL_PAYMENT"];
const DELIVERY_STATES = ["QUEUED", "SCHEDULED", "PROCESSING", "SENT", "DELIVERED", "READ", "FAILED", "CANCELLED", "SKIPPED"];
const TEMPLATE_CATEGORIES = ["INVOICE_CREATED", "INVOICE_DUE_SOON", "DUE_TODAY", "PAYMENT_OVERDUE", "PAYMENT_REMINDER", "PAYMENT_RECEIVED", "QUOTATION", "CREDIT_NOTE", "SALES_RETURN", "CUSTOM"];
const ALLOWED_TEMPLATE_VARS = new Set([
  "customer_name",
  "invoice_number",
  "invoice_amount",
  "outstanding_amount",
  "due_date",
  "business_name",
  "business_phone",
  "business_email",
  "payment_link",
  "payment_amount",
  "payment_date",
  "payment_reference",
  "credit_note_number",
  "credit_note_amount",
  "return_amount",
  "quotation_number",
  "quotation_amount",
  "valid_until",
]);

const DEFAULT_TEMPLATE_DEFINITIONS = [
  {
    category: "INVOICE_CREATED",
    channel: "EMAIL",
    name: "Invoice Created - Standard",
    subject: "Invoice {{invoice_number}} from {{business_name}}",
    body: "Hi {{customer_name}},\n\nYour invoice {{invoice_number}} has been generated by {{business_name}}.\n\nInvoice Amount: {{invoice_amount}}\nDue Date: {{due_date}}\n\nPlease review the invoice and complete the payment by the due date.\n\nIf you have any questions regarding this invoice, please contact us and we will be happy to assist you.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "INVOICE_CREATED",
    channel: "WHATSAPP",
    name: "Invoice Created - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nInvoice {{invoice_number}} from {{business_name}} is ready.\nAmount: {{invoice_amount}}\nDue date: {{due_date}}.\n\n- {{business_name}}",
  },
  {
    category: "DUE_TODAY",
    channel: "EMAIL",
    name: "Payment Due Today - Standard",
    subject: "Payment due today - Invoice {{invoice_number}}",
    body: "Hi {{customer_name}},\n\nThis is a friendly reminder that payment for invoice {{invoice_number}} is due today.\n\nInvoice Amount: {{invoice_amount}}\nOutstanding Amount: {{outstanding_amount}}\nDue Date: {{due_date}}\n\nPlease complete the payment at your convenience today.\n\nIf the payment has already been made, please ignore this reminder.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "DUE_TODAY",
    channel: "WHATSAPP",
    name: "Payment Due Today - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nPayment for invoice {{invoice_number}} is due today.\n\nOutstanding: {{outstanding_amount}}\n\nIf already paid, please ignore this message.\n\n- {{business_name}}",
  },
  {
    category: "PAYMENT_OVERDUE",
    channel: "EMAIL",
    name: "Payment Reminder - Standard",
    subject: "Payment Reminder - Invoice {{invoice_number}}",
    body: "Hi {{customer_name}},\n\nThis is a reminder regarding the outstanding payment for invoice {{invoice_number}}.\n\nInvoice Amount: {{invoice_amount}}\nOutstanding Amount: {{outstanding_amount}}\nDue Date: {{due_date}}\n\nOur records indicate that the payment is currently overdue. We request you to complete the outstanding payment at your earliest convenience.\n\nIf the payment has already been made, please ignore this reminder.\n\nFor any clarification regarding the invoice or payment, please feel free to contact us.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "PAYMENT_OVERDUE",
    channel: "WHATSAPP",
    name: "Payment Reminder - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nThis is a payment reminder for invoice {{invoice_number}}.\n\nOutstanding: {{outstanding_amount}}\nDue Date: {{due_date}}\n\nPlease complete the payment at your earliest convenience.\n\nIf already paid, please ignore this message.\n\n- {{business_name}}",
  },
  {
    category: "PAYMENT_REMINDER",
    channel: "EMAIL",
    name: "Payment Reminder - Friendly",
    subject: "Upcoming Payment Reminder - Invoice {{invoice_number}}",
    body: "Hi {{customer_name}},\n\nThis is a friendly reminder about the upcoming payment for invoice {{invoice_number}}.\n\nInvoice Amount: {{invoice_amount}}\nOutstanding Amount: {{outstanding_amount}}\nDue Date: {{due_date}}\n\nPlease ensure that the payment is completed by the due date to keep your account up to date.\n\nIf you have already completed the payment, please ignore this message.\n\nFor any questions or assistance, please feel free to contact us.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "PAYMENT_REMINDER",
    channel: "WHATSAPP",
    name: "Payment Reminder - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nUpcoming payment reminder for invoice {{invoice_number}}.\nOutstanding: {{outstanding_amount}}\nDue date: {{due_date}}.\n\nIf already paid, please ignore this message.\n\n- {{business_name}}",
  },
  {
    category: "PAYMENT_RECEIVED",
    channel: "EMAIL",
    name: "Payment Received - Standard",
    subject: "Payment Received - Invoice {{invoice_number}}",
    body: "Hi {{customer_name}},\n\nThank you. We have received your payment against invoice {{invoice_number}}.\n\nPayment Amount: {{payment_amount}}\nInvoice Number: {{invoice_number}}\nOutstanding Balance: {{outstanding_amount}}\n\nYour payment has been recorded successfully.\n\nThank you for your business with {{business_name}}.\n\nIf you have any questions regarding this payment, please feel free to contact us.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "PAYMENT_RECEIVED",
    channel: "WHATSAPP",
    name: "Payment Received - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nPayment for invoice {{invoice_number}} has been received. Thank you.\nOutstanding balance: {{outstanding_amount}}\n\n- {{business_name}}",
  },
  {
    category: "CREDIT_NOTE",
    channel: "EMAIL",
    name: "Credit Note - Standard",
    subject: "Credit Note Issued - {{credit_note_number}}",
    body: "Hi {{customer_name}},\n\nA credit note has been issued by {{business_name}} against your account.\n\nCredit Note Number: {{credit_note_number}}\nRelated Invoice: {{invoice_number}}\nCredit Amount: {{credit_note_amount}}\n\nThe credit has been recorded against the applicable invoice/account.\n\nPlease contact us if you require any clarification regarding this credit note.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "CREDIT_NOTE",
    channel: "WHATSAPP",
    name: "Credit Note - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nCredit note {{credit_note_number}} has been issued for invoice {{invoice_number}}.\nAmount: {{credit_note_amount}}\n\n- {{business_name}}",
  },
  {
    category: "SALES_RETURN",
    channel: "EMAIL",
    name: "Sales Return - Standard",
    subject: "Sales Return Confirmation - {{invoice_number}}",
    body: "Hi {{customer_name}},\n\nYour sales return related to invoice {{invoice_number}} has been recorded successfully.\n\nReturn Amount: {{return_amount}}\nRelated Invoice: {{invoice_number}}\n\nAny applicable credit or adjustment will be reflected in your account according to the recorded transaction.\n\nIf you have any questions regarding this return, please contact us.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "SALES_RETURN",
    channel: "WHATSAPP",
    name: "Sales Return - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nYour sales return for invoice {{invoice_number}} has been recorded.\nReturn amount: {{return_amount}}\n\n- {{business_name}}",
  },
  {
    category: "QUOTATION",
    channel: "EMAIL",
    name: "Quotation - Standard",
    subject: "Quotation {{quotation_number}} from {{business_name}}",
    body: "Hi {{customer_name}},\n\nThank you for your interest in {{business_name}}.\n\nWe have prepared quotation {{quotation_number}} for your requirement.\n\nQuotation Amount: {{quotation_amount}}\nValid Until: {{valid_until}}\n\nPlease review the quotation and let us know if you have any questions or would like to proceed.\n\nWe look forward to working with you.\n\nRegards,\n{{business_name}}\n{{business_phone}}\n{{business_email}}",
  },
  {
    category: "QUOTATION",
    channel: "WHATSAPP",
    name: "Quotation - WhatsApp",
    subject: "",
    body: "Hi {{customer_name}},\n\nQuotation {{quotation_number}} from {{business_name}} is ready.\nAmount: {{quotation_amount}}\nValid until: {{valid_until}}\n\n- {{business_name}}",
  },
];
const REMINDER_LOCK_TTL_MS = Math.max(Number(process.env.REMINDER_LOCK_TTL_MS || 5 * 60 * 1000), 60000);
const REMINDER_WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;

const normalizeChannel = (channel) => {
  const value = String(channel || "").toUpperCase();
  if (!CHANNELS.includes(value)) throw new AppError("Invalid communication channel", 400);
  return value;
};

const normalizeTemplateCategory = (category = "CUSTOM") => {
  const value = String(category || "CUSTOM").toUpperCase();
  if (!TEMPLATE_CATEGORIES.includes(value)) throw new AppError("Invalid communication template category", 400);
  return value;
};

const normalizeReminderType = (value) => {
  const trigger = String(value || "BEFORE_DUE_DATE").toUpperCase();
  if (trigger === "BEFORE_DUE") return "BEFORE_DUE_DATE";
  if (trigger === "AFTER_DUE") return "AFTER_DUE_DATE";
  if (!REMINDER_TYPES.includes(trigger)) throw new AppError("Invalid reminder type", 400);
  return trigger;
};

const normalizeAutomationTrigger = (value) => {
  const trigger = String(value || "").toUpperCase();
  if (EVENT_TYPES.includes(trigger)) return trigger;
  return normalizeReminderType(trigger);
};

const normalizePaymentCondition = (value) => {
  const condition = String(value || "ANY_PAYMENT").toUpperCase();
  if (!PAYMENT_CONDITIONS.includes(condition)) throw new AppError("Invalid payment automation condition", 400);
  return condition;
};

const isScheduledReminderTrigger = (trigger) => {
  try {
    normalizeReminderType(trigger);
    return true;
  } catch (_error) {
    return false;
  }
};

const validateSendTime = (sendTime) => {
  const value = String(sendTime || "").trim();
  if (!/^\d{2}:\d{2}$/.test(value)) throw new AppError("Send time must use HH:mm format", 400);
  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 23 || minutes > 59) throw new AppError("Send time is invalid", 400);
  return value;
};

const generateReminderRuleName = ({ trigger, offsetDays = 0, repeatEveryDays = 0 }) => {
  const type = normalizeReminderType(trigger);
  if (type === "ON_DUE_DATE") return "On due date";
  if (type === "BEFORE_DUE_DATE") return `${Number(offsetDays)} ${Number(offsetDays) === 1 ? "day" : "days"} before due date`;
  if (type === "AFTER_DUE_DATE") return `${Number(offsetDays)} ${Number(offsetDays) === 1 ? "day" : "days"} after due date`;
  return `Every ${Number(repeatEveryDays)} ${Number(repeatEveryDays) === 1 ? "day" : "days"} after overdue`;
};

const defaultCategoryForReminderTrigger = (trigger) => {
  const type = normalizeReminderType(trigger);
  if (type === "BEFORE_DUE_DATE") return "PAYMENT_REMINDER";
  if (type === "ON_DUE_DATE") return "DUE_TODAY";
  return "PAYMENT_OVERDUE";
};

const normalizeReminderRuleInput = (body = {}) => {
  const trigger = normalizeAutomationTrigger(body.reminderType || body.trigger);
  const channel = normalizeChannel(body.channel || body.channels?.[0] || "EMAIL");
  const isEventRule = EVENT_TYPES.includes(trigger);
  const category = normalizeTemplateCategory(body.category || (trigger === "INVOICE_ISSUED" ? "INVOICE_CREATED" : trigger === "PAYMENT_RECORDED" ? "PAYMENT_RECEIVED" : defaultCategoryForReminderTrigger(trigger)));
  const sendTime = isEventRule ? "" : validateSendTime(body.sendTime || "10:00");
  const offsetDays = isEventRule || trigger === "ON_DUE_DATE" || trigger === "RECURRING_OVERDUE" ? 0 : Number(body.offsetDays || body.days || 0);
  const repeatEveryDays = isEventRule || trigger !== "RECURRING_OVERDUE" ? 0 : Number(body.repeatEveryDays || body.offsetDays || 0);
  if (!isEventRule) {
    if (["BEFORE_DUE_DATE", "AFTER_DUE_DATE"].includes(trigger) && (!(offsetDays > 0) || !Number.isFinite(offsetDays))) {
      throw new AppError("Reminder days must be positive", 400);
    }
    if (trigger === "RECURRING_OVERDUE" && (!(repeatEveryDays >= 1) || !Number.isFinite(repeatEveryDays))) {
      throw new AppError("Recurring overdue interval must be at least 1 day", 400);
    }
  }
  const condition = trigger === "PAYMENT_RECORDED" ? normalizePaymentCondition(body.condition) : "ANY_PAYMENT";
  const name = body.name || (trigger === "INVOICE_ISSUED" ? "Invoice Issued" : trigger === "PAYMENT_RECORDED" ? `Payment Successfully Recorded - ${condition.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase())}` : generateReminderRuleName({ trigger, offsetDays, repeatEveryDays }));
  return {
    trigger,
    channel,
    sendTime,
    offsetDays,
    repeatEveryDays,
    name,
    timezone: body.timezone || "Asia/Kolkata",
    templateId: body.templateId || null,
    category,
    condition,
    isEnabled: isEventRule ? body.isEnabled === true : body.isEnabled !== false,
    sourceKey: body.sourceKey || `RULE:${trigger}:${offsetDays}:${repeatEveryDays}:${channel}:${category}:${body.templateId || "DEFAULT"}:${sendTime || "EVENT"}:${condition}`,
  };
};

const extractTemplateVariables = (templateBody = "") => Array.from(new Set(
  Array.from(String(templateBody || "").matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)).map((match) => match[1])
));

const validateTemplateVariables = (templateBody = "", variables = null) => {
  for (const key of extractTemplateVariables(templateBody)) {
    if (!ALLOWED_TEMPLATE_VARS.has(key)) throw new AppError(`Unsupported template variable: ${key}`, 400);
    if (variables && (variables[key] === undefined || variables[key] === null || variables[key] === "")) {
      throw new AppError(`Template variable is unavailable: ${key}`, 400);
    }
  }
};

const renderTemplate = (templateBody, variables = {}) => {
  validateTemplateVariables(templateBody, variables);
  return String(templateBody || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key) => String(variables[key]));
};

const ensureDefaultTemplates = async ({ businessId, createdBy, session }) => {
  const rows = [];
  for (const definition of DEFAULT_TEMPLATE_DEFINITIONS) {
    validateTemplateVariables(`${definition.subject || ""}\n${definition.body || ""}`);
    const code = `${definition.category}_${definition.channel}_DEFAULT`;
    const existingDefault = await MessageTemplate.findOne({
      businessId,
      category: definition.category,
      channel: definition.channel,
      isDefault: true,
    }).session(session);
    const existingStandard = await MessageTemplate.findOne({
      businessId,
      channel: definition.channel,
      $or: [{ code }, { code: `${definition.category}_${definition.channel}` }, { code: `${definition.category}_${definition.channel}_SYSTEM` }],
    }).session(session);
    const shouldBeDefault = !existingDefault || String(existingDefault._id) === String(existingStandard?._id);
    if (shouldBeDefault) {
      await MessageTemplate.updateMany(
        { businessId, category: definition.category, channel: definition.channel, isDefault: true, _id: { $ne: existingStandard?._id || new mongoose.Types.ObjectId() } },
        { $set: { isDefault: false } },
        { session }
      );
    }
    const update = await MessageTemplate.findOneAndUpdate(
      existingStandard ? { _id: existingStandard._id, businessId } : { businessId, code, channel: definition.channel },
      {
        $set: {
          name: definition.name,
          body: definition.body,
          subject: definition.subject,
          category: definition.category,
          variables: extractTemplateVariables(`${definition.subject || ""}\n${definition.body || ""}`),
          isDefault: shouldBeDefault,
          isActive: true,
          isSystem: true,
        },
        $setOnInsert: {
          businessId,
          code,
          channel: definition.channel,
          createdBy,
        },
      },
      { upsert: true, new: true, session }
    );
    rows.push(update);
  }
  return rows;
};

const getInvoiceContext = async ({ businessId, invoiceId, session }) => {
  const [invoice, business] = await Promise.all([
    Invoice.findOne({ _id: invoiceId, businessId }).populate("customerId", "name email phone whatsappConsent").session(session),
    Business.findOne({ _id: businessId }).select("name email billingEmail phone").session(session),
  ]);
  if (!invoice) throw new AppError("Invoice not found", 404);
  const derived = await applyFinancialRead({ businessId, sourceType: "INVOICE", document: invoice });
  const customer = invoice.customerId;
  return { invoice: derived, customer, business };
};

const getQuoteContext = async ({ businessId, quoteId, session }) => {
  const [quote, business] = await Promise.all([
    Quote.findOne({ _id: quoteId, businessId }).populate("customerId", "name email phone").session(session),
    Business.findOne({ _id: businessId }).select("name email billingEmail phone").session(session),
  ]);
  if (!quote) throw new AppError("Quote not found", 404);
  return { quote, customer: quote.customerId, business };
};

const formatAmount = (value) => Number(value || 0).toFixed(2);
const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-IN") : "");

const buildVariables = ({ businessName = "BillStack", business, invoice, customer, payment = {}, creditNote = {}, salesReturn = {}, quote = {}, paymentLink = "" }) => ({
  customer_name: customer?.name || invoice?.customerDetails?.name || "Customer",
  invoice_number: invoice?.invoiceNumber || "",
  invoice_amount: formatAmount(invoice?.grandTotal),
  outstanding_amount: formatAmount(invoice?.balanceDue),
  due_date: formatDate(invoice?.dueDate),
  business_name: business?.name || invoice?.businessDetails?.name || businessName,
  business_phone: business?.phone || invoice?.businessDetails?.phone || "",
  business_email: business?.email || business?.billingEmail || invoice?.businessDetails?.email || "",
  payment_link: paymentLink,
  payment_amount: payment.amount !== undefined ? formatAmount(payment.amount) : formatAmount(invoice?.amountPaid || invoice?.grandTotal - invoice?.balanceDue || 0),
  payment_date: formatDate(payment.paymentDate),
  payment_reference: payment.referenceNumber || payment.reference || "",
  credit_note_number: creditNote.creditNoteNumber || "",
  credit_note_amount: creditNote.totalAmount !== undefined ? formatAmount(creditNote.totalAmount) : "",
  return_amount: salesReturn.totalAmount !== undefined ? formatAmount(salesReturn.totalAmount) : "",
  quotation_number: quote.quoteNumber || "",
  quotation_amount: quote.grandTotal !== undefined ? formatAmount(quote.grandTotal) : "",
  valid_until: formatDate(quote.validUntil),
});

const findTemplate = async ({ businessId, channel, category, templateId, session }) => {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedCategory = normalizeTemplateCategory(category);
  if (templateId) {
    const template = await MessageTemplate.findOne({ _id: templateId, businessId, channel: normalizedChannel, category: normalizedCategory, isActive: true }).session(session);
    if (!template) throw new AppError("Message template not found", 404);
    return template;
  }
  const defaultTemplate = await MessageTemplate.findOne({ businessId, channel: normalizedChannel, category: normalizedCategory, isActive: true, isDefault: true }).session(session);
  if (defaultTemplate) return defaultTemplate;
  return MessageTemplate.findOne({ businessId, channel: normalizedChannel, category: normalizedCategory, isActive: true }).session(session);
};

const createDelivery = async ({ businessId, customerId, invoiceId, paymentId = null, channel, template, content, recipient, sourceKey, status = "QUEUED", failureReason = "", reminderJobId = null, createdBy, session, metadata = {} }) => {
  const row = await MessageDelivery.findOneAndUpdate(
    { businessId, sourceKey },
    {
      $setOnInsert: {
        businessId,
        customerId,
        invoiceId,
        paymentId,
        channel,
        templateId: template?._id || null,
        subject: template?.subject || "",
        content,
        recipient,
        sourceKey,
        reminderJobId,
        status,
        failureReason,
        provider: channel === "WHATSAPP" ? getWhatsAppProviderStatus(businessId).provider : channel,
        usageTimestamp: ["SENT", "DELIVERED", "READ"].includes(status) ? new Date() : null,
        metadata,
        createdBy,
      },
    },
    { upsert: true, new: true, session }
  );
  return row;
};

const scheduleWorkflowMessage = async ({ businessId, customerId = null, channel = "EMAIL", scheduledFor, subject, content, recipient = "", sourceKey, metadata = {}, createdBy, session }) => {
  const normalizedChannel = normalizeChannel(channel);
  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) throw new AppError("Workflow reminder schedule date is invalid", 400);
  if (!sourceKey) throw new AppError("Workflow reminder source key is required", 400);
  return createDelivery({
    businessId,
    customerId,
    invoiceId: null,
    channel: normalizedChannel,
    template: subject ? { subject } : null,
    content,
    recipient,
    sourceKey,
    status: "SCHEDULED",
    createdBy,
    session,
    metadata: { ...metadata, scheduledFor: when },
  });
};

const dispatchDelivery = async ({ delivery, session }) => {
  if (delivery.status === "SENT") return delivery;
  try {
    if (delivery.channel === "WHATSAPP" && delivery.provider === "WHATSAPP_APP") {
      const app = delivery.metadata?.app;
      if (!app?.purpose) throw new AppError("Only invoice, payment-reminder and payment-received messages go through the WhatsApp app", 400);
      // A new key only after the app gave a final answer (skipped / failed), so a retry after a lost
      // answer is not sent twice.
      const attempt = Number(delivery.metadata?.appAttempt || 1);
      const key = `bs-${delivery._id}-${attempt}`;
      const result = await sendThroughWhatsAppApp({
        key,
        to: delivery.recipient,
        purpose: app.purpose,
        variables: app.variables || {},
        consent: app.consent || undefined,
        ref: { type: delivery.invoiceId ? "invoice" : "message", id: String(delivery.invoiceId || delivery._id) },
      });
      delivery.providerMessageId = result.key;
      delivery.providerReference = JSON.stringify({ appStatus: result.appStatus, key: result.key });
      if (["SKIPPED", "FAILED", "CANCELLED"].includes(result.status)) {
        delivery.metadata = { ...(delivery.metadata || {}), appAttempt: attempt + 1 };
        delivery.markModified("metadata");
        delivery.status = result.status;
        delivery.failureReason = result.reason || "The WhatsApp app did not send it";
        await delivery.save({ session });
        return delivery;
      }
      delivery.status = result.status;
    } else if (delivery.channel === "WHATSAPP") {
      const providerResult = await sendWhatsAppMessage({ to: delivery.recipient, body: delivery.content, sourceKey: delivery.sourceKey });
      delivery.providerMessageId = providerResult.providerMessageId || delivery.providerMessageId;
      delivery.providerReference = providerResult.providerReference ? JSON.stringify(providerResult.providerReference) : delivery.providerReference;
      if (providerResult.status) delivery.status = providerResult.status;
    } else if (delivery.channel === "EMAIL") {
      await sendEmail({ to: delivery.recipient, subject: delivery.subject || "BillStack reminder", text: delivery.content, html: `<p>${delivery.content}</p>` });
    } else if (delivery.channel === "SMS") {
      throw new AppError("SMS provider is not configured", 503);
    }
    if (["QUEUED", "SCHEDULED", "PROCESSING"].includes(delivery.status)) delivery.status = "SENT";
    delivery.sentAt = new Date();
    delivery.usageTimestamp = delivery.sentAt;
    delivery.failureReason = "";
  } catch (error) {
    delivery.status = "FAILED";
    delivery.failureReason = error.message;
    log("warn", "Communication delivery failed", {
      channel: delivery.channel,
      provider: delivery.provider,
      sourceKey: delivery.sourceKey,
      error: error.message,
    });
  }
  await delivery.save({ session });
  return delivery;
};

const scheduleReminder = async ({ businessId, invoiceId, channel, scheduledFor, templateId, ruleId = null, createdBy, session }) => {
  const normalizedChannel = normalizeChannel(channel);
  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) throw new AppError("Reminder schedule date is invalid", 400);
  const { invoice, customer, business } = await getInvoiceContext({ businessId, invoiceId, session });
  if (Number(invoice.balanceDue || 0) <= 0) throw new AppError("Invoice has no outstanding amount", 400);
  if (templateId) await findTemplate({ businessId, channel: normalizedChannel, category: "PAYMENT_OVERDUE", templateId, session });
  const sourceKey = `REMINDER:${invoice._id}:${normalizedChannel}:${when.toISOString()}:${ruleId || "MANUAL"}`;
  const reminder = await ScheduledReminder.findOneAndUpdate(
    { businessId, sourceKey },
    {
      $setOnInsert: {
        businessId,
        invoiceId: invoice._id,
        customerId: customer?._id || invoice.customerId,
        ruleId,
        templateId,
        channel: normalizedChannel,
        scheduledFor: when,
        outstandingAmountSnapshot: invoice.balanceDue,
        sourceKey,
        createdBy,
      },
    },
    { upsert: true, new: true, session }
  );
  return reminder;
};

const sendInvoiceMessage = async ({ businessId, invoiceId, channel, category = "INVOICE_CREATED", templateId, createdBy, session }) => {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedCategory = normalizeTemplateCategory(category);
  const { invoice, customer, business } = await getInvoiceContext({ businessId, invoiceId, session });
  const template = await findTemplate({ businessId, channel: normalizedChannel, category: normalizedCategory, templateId, session });
  if (!template) throw new AppError("Message template is not configured", 404);
  const paymentLink = await paymentLinkFor({ businessId, invoice, category: normalizedCategory });
  const plan = appPlanFor({ businessId, channel: normalizedChannel, category: normalizedCategory, invoice, customer, business, paymentLink });
  if (plan?.skip) throw new AppError(plan.skip, 400);
  const content = renderTemplate(template.body, buildVariables({ invoice, customer, business, paymentLink }));
  const recipient = normalizedChannel === "EMAIL" ? customer?.email || invoice.customerDetails?.email || "" : customer?.phone || invoice.customerDetails?.phone || "";
  if (!recipient) throw new AppError(`Customer ${normalizedChannel === "EMAIL" ? "email" : "phone"} is required to send this`, 400);
  const sourceKey = `SEND:${invoice._id}:${normalizedChannel}:${normalizedCategory}:${template?._id || "DEFAULT"}`;
  const metadata = plan?.app ? { app: plan.app, category: normalizedCategory } : {};
  const delivery = await createDelivery({ businessId, customerId: customer?._id || invoice.customerId, invoiceId: invoice._id, channel: normalizedChannel, template, content, recipient, sourceKey, createdBy, session, metadata });
  // Sent again after it did not go: with the current amount, link and number.
  if (!["SENT", "DELIVERED", "READ"].includes(delivery.status)) {
    delivery.content = content;
    delivery.recipient = recipient;
    if (plan?.app) {
      delivery.metadata = { ...(delivery.metadata || {}), ...metadata };
      delivery.markModified("metadata");
    }
  }
  return dispatchDelivery({ delivery, session });
};

const sendQuoteMessage = async ({ businessId, quoteId, channel, templateId, createdBy, session }) => {
  const normalizedChannel = normalizeChannel(channel);
  const { quote, customer, business } = await getQuoteContext({ businessId, quoteId, session });
  if (["REJECTED", "EXPIRED"].includes(quote.status)) throw new AppError("Only active quotes can be sent", 400);
  const template = await findTemplate({ businessId, channel: normalizedChannel, category: "QUOTATION", templateId, session });
  if (!template) throw new AppError("Quotation template is not configured", 404);
  const recipient = normalizedChannel === "EMAIL" ? customer?.email || quote.customerSnapshot?.email || "" : customer?.phone || quote.customerSnapshot?.phone || "";
  if (!recipient) throw new AppError(`Customer ${normalizedChannel === "EMAIL" ? "email" : "phone"} is required to send quotation`, 400);
  const content = renderTemplate(template.body, buildVariables({ quote, customer, business }));
  const sourceKey = `SEND:QUOTE:${quote._id}:${normalizedChannel}:${template?._id || "DEFAULT"}`;
  const delivery = await createDelivery({
    businessId,
    customerId: customer?._id || quote.customerId,
    invoiceId: null,
    channel: normalizedChannel,
    template,
    content,
    recipient,
    sourceKey,
    createdBy,
    session,
    metadata: { quoteId: quote._id, category: "QUOTATION" },
  });
  const sent = await dispatchDelivery({ delivery, session });
  if (quote.status === "DRAFT" && ["SENT", "DELIVERED", "READ"].includes(sent.status)) {
    quote.status = "SENT";
    await quote.save({ session });
  }
  return sent;
};

const isChannelConfigured = (channel, businessId = null) => {
  if (channel === "EMAIL") return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  if (channel === "WHATSAPP") return Boolean(getWhatsAppProviderStatus(businessId).configured);
  if (channel === "SMS") return false;
  if (channel === "IN_APP") return true;
  return false;
};

const recipientForChannel = ({ channel, customer, invoice }) => (
  channel === "EMAIL"
    ? customer?.email || invoice.customerDetails?.email || ""
    : channel === "WHATSAPP" || channel === "SMS"
      ? customer?.phone || invoice.customerDetails?.phone || ""
      : customer?._id?.toString?.() || invoice.customerId?.toString?.() || ""
);

const createSkippedAutomationDelivery = ({ businessId, customerId, invoiceId, paymentId = null, channel, template = null, sourceKey, reason, createdBy, session, metadata = {} }) => createDelivery({
  businessId,
  customerId,
  invoiceId,
  paymentId,
  channel,
  template,
  content: reason,
  recipient: "",
  sourceKey,
  status: "SKIPPED",
  failureReason: reason,
  createdBy,
  session,
  metadata,
});

const dispatchAutomationDelivery = async ({ businessId, invoice, customer, business, rule, template, payment = {}, allocation = null, eventType, sourceKey, createdBy, session }) => {
  const channel = rule.channels?.[0] || "EMAIL";
  const metadata = { eventType, ruleId: rule._id, condition: rule.condition || "ANY_PAYMENT" };
  if (!isChannelConfigured(channel, businessId)) {
    return createSkippedAutomationDelivery({ businessId, customerId: customer?._id || invoice.customerId, invoiceId: invoice._id, paymentId: payment?._id || null, channel, template, sourceKey, reason: `${channel} provider is not configured`, createdBy, session, metadata });
  }
  const recipient = recipientForChannel({ channel, customer, invoice });
  if (!recipient) {
    return createSkippedAutomationDelivery({ businessId, customerId: customer?._id || invoice.customerId, invoiceId: invoice._id, paymentId: payment?._id || null, channel, template, sourceKey, reason: `Recipient is missing for ${channel}`, createdBy, session, metadata });
  }
  const category = template?.category || rule.category || (eventType === "PAYMENT_RECORDED" ? "PAYMENT_RECEIVED" : "INVOICE_CREATED");
  const paymentLink = await paymentLinkFor({ businessId, invoice, category });
  const plan = appPlanFor({ businessId, channel, category, invoice, customer, business, payment, paymentLink });
  if (plan?.skip) {
    return createSkippedAutomationDelivery({ businessId, customerId: customer?._id || invoice.customerId, invoiceId: invoice._id, paymentId: payment?._id || null, channel, template, sourceKey, reason: plan.skip, createdBy, session, metadata });
  }
  const content = renderTemplate(template.body, buildVariables({ invoice, customer, business, payment, paymentLink }));
  const delivery = await createDelivery({ businessId, customerId: customer?._id || invoice.customerId, invoiceId: invoice._id, paymentId: payment?._id || null, channel, template, content, recipient, sourceKey, createdBy, session, metadata: { ...metadata, allocationId: allocation?._id || null, ...(plan?.app ? { app: plan.app, category } : {}) } });
  if (delivery.status !== "QUEUED") return delivery;
  return dispatchDelivery({ delivery, session });
};

const dispatchInvoiceIssuedAutomation = async ({ businessId, invoiceId, createdBy, session }) => {
  const { invoice, customer, business } = await getInvoiceContext({ businessId, invoiceId, session });
  if (invoice.status !== "issued" || invoice.isSampleData === true) return [];
  const rules = await ReminderRule.find({ businessId, trigger: "INVOICE_ISSUED", isEnabled: true }).session(session);
  const deliveries = [];
  for (const rule of rules) {
    const channel = normalizeChannel(rule.channels?.[0] || "EMAIL");
    const template = await findTemplate({ businessId, channel, category: rule.category || "INVOICE_CREATED", templateId: rule.templateId, session });
    const sourceKey = `AUTO:INVOICE_ISSUED:${invoice._id}:${rule._id}:${channel}:${template?._id || "DEFAULT"}`;
    deliveries.push(await dispatchAutomationDelivery({ businessId, invoice, customer, business, rule, template, eventType: "INVOICE_ISSUED", sourceKey, createdBy, session }));
  }
  return deliveries;
};

const matchesPaymentCondition = ({ condition, invoice }) => {
  const normalized = normalizePaymentCondition(condition);
  if (normalized === "ANY_PAYMENT") return true;
  const balanceDue = Number(invoice.balanceDue || 0);
  if (normalized === "FULL_PAYMENT") return balanceDue <= 0;
  return balanceDue > 0;
};

const dispatchPaymentRecordedAutomation = async ({ businessId, allocationId, createdBy, session }) => {
  const allocation = await PaymentAllocation.findOne({ _id: allocationId, businessId }).session(session);
  if (!allocation || !allocation.invoiceId) return [];
  const [payment, reversal] = await Promise.all([
    Payment.findOne({ _id: allocation.paymentId, businessId }).session(session),
    PaymentAllocationReversal.findOne({ businessId, allocationId: allocation._id }).session(session),
  ]);
  if (!payment || payment.status !== "POSTED" || payment.direction !== "RECEIVED" || reversal) return [];
  const { invoice, customer, business } = await getInvoiceContext({ businessId, invoiceId: allocation.invoiceId, session });
  if (invoice.status === "cancelled") return [];
  if (!payment.customerId || payment.customerId.toString() !== invoice.customerId.toString()) return [];
  const rules = await ReminderRule.find({ businessId, trigger: "PAYMENT_RECORDED", isEnabled: true }).session(session);
  const deliveries = [];
  for (const rule of rules) {
    if (!matchesPaymentCondition({ condition: rule.condition, invoice })) continue;
    const channel = normalizeChannel(rule.channels?.[0] || "EMAIL");
    const template = await findTemplate({ businessId, channel, category: rule.category || "PAYMENT_RECEIVED", templateId: rule.templateId, session });
    const sourceKey = `AUTO:PAYMENT_RECORDED:${allocation._id}:${rule._id}:${channel}:${template?._id || "DEFAULT"}`;
    deliveries.push(await dispatchAutomationDelivery({ businessId, invoice, customer, business, rule, template, payment: { ...payment.toObject(), amount: allocation.allocatedAmount }, allocation, eventType: "PAYMENT_RECORDED", sourceKey, createdBy, session }));
  }
  return deliveries;
};

const processDueReminder = async ({ reminder, session }) => {
  const { invoice, customer, business } = await getInvoiceContext({ businessId: reminder.businessId, invoiceId: reminder.invoiceId, session });
  if (Number(invoice.balanceDue || 0) <= 0) {
    reminder.status = "SKIPPED";
    reminder.cancellationReason = "Invoice no longer has outstanding amount";
    reminder.lockedAt = null;
    reminder.lockedBy = "";
    await reminder.save({ session });
    return reminder;
  }
  const rule = reminder.ruleId ? await ReminderRule.findOne({ _id: reminder.ruleId, businessId: reminder.businessId, isEnabled: true }).session(session) : null;
  const category = rule?.category || "PAYMENT_OVERDUE";
  const template = await findTemplate({ businessId: reminder.businessId, channel: reminder.channel, category, templateId: reminder.templateId || rule?.templateId, session });
  if (!template) throw new AppError("Message template is not configured", 404);
  reminder.outstandingAmountSnapshot = invoice.balanceDue;
  const paymentLink = await paymentLinkFor({ businessId: reminder.businessId, invoice, category });
  const plan = appPlanFor({ businessId: reminder.businessId, channel: reminder.channel, category, invoice, customer, business, paymentLink });
  if (plan?.skip) {
    // Not something a retry fixes (the customer's agreement, a message the app does not send).
    reminder.status = "SKIPPED";
    reminder.failureReason = plan.skip;
    reminder.cancellationReason = plan.skip;
    reminder.lockedAt = null;
    reminder.lockedBy = "";
    await reminder.save({ session });
    return reminder;
  }
  const content = renderTemplate(template.body, buildVariables({ invoice, customer, business, paymentLink }));
  const recipient = reminder.channel === "EMAIL" ? customer?.email || invoice.customerDetails?.email || "" : customer?.phone || invoice.customerDetails?.phone || "";
  const delivery = await createDelivery({ businessId: reminder.businessId, customerId: customer?._id || invoice.customerId, invoiceId: invoice._id, channel: reminder.channel, template, content, recipient, sourceKey: `REMINDER_DELIVERY:${reminder._id}`, status: "QUEUED", reminderJobId: reminder._id, createdBy: reminder.createdBy, session, metadata: plan?.app ? { app: plan.app, category } : {} });
  const sent = await dispatchDelivery({ delivery, session });
  reminder.status = ["SENT", "DELIVERED", "READ"].includes(sent.status) ? "SENT" : sent.status === "SKIPPED" ? "SKIPPED" : "FAILED";
  reminder.sentAt = sent.sentAt;
  reminder.failureReason = sent.failureReason;
  reminder.retryCount += reminder.status === "FAILED" ? 1 : 0;
  reminder.nextRetryAt = reminder.status === "FAILED" ? nextRetryAfterFailure(reminder.retryCount) : null;
  reminder.lockedAt = null;
  reminder.lockedBy = "";
  await reminder.save({ session });
  if (reminder.status === "SENT" && reminder.ruleId && isScheduledReminderTrigger(rule?.trigger)) {
    if (rule && normalizeReminderType(rule.trigger) === "RECURRING_OVERDUE") {
      await scheduleRecurringOverdueOccurrence({ businessId: reminder.businessId, invoice, rule, channel: reminder.channel, previousScheduledFor: reminder.scheduledFor, createdBy: reminder.createdBy, session });
    }
  }
  return reminder;
};

// A message that keeps failing (wrong number, provider not set up) is retried a
// few times with a growing wait, then left as FAILED for a person to look at -
// never retried for ever.
const MAX_DELIVERY_ATTEMPTS = Math.max(Number(process.env.BILLSTACK_MAX_DELIVERY_ATTEMPTS || 6), 1);
const nextRetryAfterFailure = (retryCount) =>
  retryCount >= MAX_DELIVERY_ATTEMPTS ? null : new Date(Date.now() + Math.min(60, retryCount + 1) * 60000);

const processDueReminders = async ({ businessId, limit = 25 }) => {
  const processed = [];
  const safeLimit = Math.min(Number(limit || 25), 100);
  for (let index = 0; index < safeLimit; index += 1) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - REMINDER_LOCK_TTL_MS);
    const row = await ScheduledReminder.findOneAndUpdate(
      {
        businessId,
        $or: [
          { status: "SCHEDULED", scheduledFor: { $lte: now } },
          { status: "FAILED", nextRetryAt: { $lte: now } },
          { status: "PROCESSING", lockedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: {
          status: "PROCESSING",
          lockedAt: now,
          lockedBy: REMINDER_WORKER_ID,
          lastAttemptAt: now,
        },
      },
      { sort: { scheduledFor: 1 }, new: true }
    );
    if (!row) break;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        processed.push(await processDueReminder({ reminder: row, session }));
      });
    } catch (error) {
      await ScheduledReminder.updateOne(
        { _id: row._id, businessId, lockedBy: REMINDER_WORKER_ID, status: "PROCESSING" },
        {
          $set: {
            status: "FAILED",
            failureReason: error.message,
            nextRetryAt: nextRetryAfterFailure(Number(row.retryCount || 0) + 1),
            lockedAt: null,
            lockedBy: "",
          },
          $inc: { retryCount: 1 },
        }
      );
      log("error", "Reminder processing failed after claim", { reminderId: row._id.toString(), error: error.message });
    } finally {
      session.endSession();
    }
  }
  return processed;
};

const processScheduledWorkflowDeliveries = async ({ businessId, limit = 25 }) => {
  const processed = [];
  const safeLimit = Math.min(Number(limit || 25), 100);
  for (let index = 0; index < safeLimit; index += 1) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - REMINDER_LOCK_TTL_MS);
    const row = await MessageDelivery.findOneAndUpdate(
      {
        businessId,
        invoiceId: null,
        $or: [
          { status: "SCHEDULED", "metadata.scheduledFor": { $lte: now } },
          { status: "FAILED", nextRetryAt: { $lte: now } },
          { status: "PROCESSING", lockedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: {
          status: "PROCESSING",
          lockedAt: now,
          lockedBy: REMINDER_WORKER_ID,
          lastAttemptAt: now,
        },
      },
      { sort: { "metadata.scheduledFor": 1 }, new: true }
    );
    if (!row) break;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const sent = await dispatchDelivery({ delivery: row, session });
        sent.lockedAt = null;
        sent.lockedBy = "";
        if (sent.status === "FAILED") {
          sent.retryCount += 1;
          sent.nextRetryAt = nextRetryAfterFailure(sent.retryCount);
        }
        await sent.save({ session });
        processed.push(sent);
      });
    } catch (error) {
      await MessageDelivery.updateOne(
        { _id: row._id, businessId, lockedBy: REMINDER_WORKER_ID, status: "PROCESSING" },
        { $set: { status: "FAILED", failureReason: error.message, nextRetryAt: nextRetryAfterFailure(Number(row.retryCount || 0) + 1), lockedAt: null, lockedBy: "" }, $inc: { retryCount: 1 } }
      );
      log("error", "Workflow delivery processing failed after claim", { deliveryId: row._id.toString(), error: error.message });
    } finally {
      session.endSession();
    }
  }
  return processed;
};

const createReminderRule = async ({ businessId, body, createdBy }) => {
  const normalized = normalizeReminderRuleInput(body);
  if (normalized.templateId) {
    await findTemplate({ businessId, channel: normalized.channel, category: normalized.category, templateId: normalized.templateId });
  }
  const rule = await ReminderRule.findOneAndUpdate(
    { businessId, sourceKey: normalized.sourceKey },
    {
      $set: {
        name: normalized.name,
        trigger: normalized.trigger,
        offsetDays: normalized.offsetDays,
        repeatEveryDays: normalized.repeatEveryDays,
        channels: [normalized.channel],
        category: normalized.category,
        templateId: normalized.templateId,
        timezone: normalized.timezone,
        sendTime: normalized.sendTime,
        isEnabled: normalized.isEnabled,
      },
      $setOnInsert: { businessId, sourceKey: normalized.sourceKey, createdBy },
    },
    { upsert: true, new: true }
  );
  if (rule.isEnabled && isScheduledReminderTrigger(rule.trigger)) {
    await materializeReminderRule({ businessId, rule, createdBy });
  }
  return rule;
};

const scheduledDateForRule = ({ dueDate, trigger, offsetDays = 0, repeatEveryDays = 0, sendTime = "10:00", previousScheduledFor = null }) => {
  const normalizedTrigger = normalizeReminderType(trigger);
  const date = new Date(dueDate);
  const base = normalizedTrigger === "RECURRING_OVERDUE" && previousScheduledFor ? new Date(previousScheduledFor) : date;
  const days = normalizedTrigger === "BEFORE_DUE_DATE" ? -Math.abs(Number(offsetDays || 0)) : normalizedTrigger === "AFTER_DUE_DATE" ? Math.abs(Number(offsetDays || 0)) : normalizedTrigger === "RECURRING_OVERDUE" ? Math.abs(Number(repeatEveryDays || offsetDays || 1)) : 0;
  base.setDate(base.getDate() + days);
  const [hours, minutes] = String(sendTime || "10:00").split(":").map((value) => Number(value || 0));
  base.setHours(hours || 0, minutes || 0, 0, 0);
  return base;
};

const scheduleRecurringOverdueOccurrence = async ({ businessId, invoice, rule, channel, previousScheduledFor, createdBy, session }) => {
  if (Number(invoice.balanceDue || 0) <= 0 || invoice.status === "cancelled") return null;
  const scheduledFor = scheduledDateForRule({ dueDate: invoice.dueDate, trigger: rule.trigger, repeatEveryDays: rule.repeatEveryDays || rule.offsetDays || 1, sendTime: rule.sendTime, previousScheduledFor });
  const sourceKey = `REMINDER:${invoice._id}:${channel}:${scheduledFor.toISOString()}:${rule._id}`;
  return ScheduledReminder.findOneAndUpdate(
    { businessId, sourceKey },
        { $setOnInsert: { businessId, invoiceId: invoice._id, customerId: invoice.customerId?._id || invoice.customerId, ruleId: rule._id, templateId: rule.templateId || null, channel, scheduledFor, timezone: rule.timezone, outstandingAmountSnapshot: invoice.balanceDue, sourceKey, createdBy } },
    { upsert: true, new: true, session }
  );
};

const materializeReminderRule = async ({ businessId, rule, createdBy }) => {
  if (!isScheduledReminderTrigger(rule?.trigger)) return [];
  const invoices = await Invoice.find({ businessId, status: { $ne: "cancelled" } }).populate("customerId", "name email phone");
  const created = [];
  for (const invoice of invoices) {
    const derived = await applyFinancialRead({ businessId, sourceType: "INVOICE", document: invoice });
    if (Number(derived.balanceDue || 0) <= 0) {
      await ScheduledReminder.updateMany({ businessId, invoiceId: invoice._id, ruleId: rule._id, status: "SCHEDULED" }, { $set: { status: "CANCELLED", cancellationReason: "Invoice has no outstanding amount" } });
      continue;
    }
    const scheduledFor = scheduledDateForRule({ dueDate: invoice.dueDate, trigger: rule.trigger, offsetDays: rule.offsetDays, repeatEveryDays: rule.repeatEveryDays, sendTime: rule.sendTime });
    if (scheduledFor.getTime() < Date.now() && !["AFTER_DUE_DATE", "AFTER_DUE", "RECURRING_OVERDUE"].includes(rule.trigger)) continue;
    for (const channel of rule.channels || []) {
      const sourceKey = `REMINDER:${invoice._id}:${channel}:${scheduledFor.toISOString()}:${rule._id}`;
      const row = await ScheduledReminder.findOneAndUpdate(
        { businessId, sourceKey },
        { $setOnInsert: { businessId, invoiceId: invoice._id, customerId: invoice.customerId?._id || invoice.customerId, ruleId: rule._id, templateId: rule.templateId || null, channel, scheduledFor, timezone: rule.timezone, outstandingAmountSnapshot: derived.balanceDue, sourceKey, createdBy } },
        { upsert: true, new: true }
      );
      created.push(row);
    }
  }
  return created;
};

const updateDeliveryStatus = async ({ businessId, providerMessageId, status, failureReason = "" }) => {
  if (!DELIVERY_STATES.includes(status)) throw new AppError("Invalid delivery status", 400);
  const row = await MessageDelivery.findOne({ businessId, providerMessageId });
  if (!row) throw new AppError("Message delivery not found", 404);
  row.status = status;
  row.failureReason = failureReason;
  if (status === "DELIVERED") row.deliveredAt = new Date();
  if (status === "READ") row.readAt = new Date();
  await row.save();
  return row;
};

// The WhatsApp app's report on a message it was asked to send (key = providerMessageId). Moves
// forward only: a late "delivered" never undoes "read".
const DELIVERY_ORDER = ["QUEUED", "SCHEDULED", "PROCESSING", "SENT", "DELIVERED", "READ"];
const updateWhatsAppAppDeliveryStatus = async ({ key, status, reason = "" }) => {
  const { APP_STATUS } = require("./whatsapp-app.service");
  const mapped = APP_STATUS[String(status || "").toLowerCase()];
  if (!mapped) throw new AppError("Unknown status", 400);
  const row = await MessageDelivery.findOne({ provider: "WHATSAPP_APP", providerMessageId: String(key || "") });
  if (!row) return null;
  if (row.status === "READ") return row;
  const terminal = ["FAILED", "SKIPPED", "CANCELLED"];
  if (!terminal.includes(mapped) && DELIVERY_ORDER.indexOf(mapped) <= DELIVERY_ORDER.indexOf(row.status)) return row;
  row.status = mapped;
  row.failureReason = terminal.includes(mapped) ? String(reason || "").slice(0, 300) : "";
  if (mapped === "DELIVERED") row.deliveredAt = new Date();
  if (mapped === "READ") row.readAt = new Date();
  await row.save();
  return row;
};

const updateProviderDeliveryStatus = async ({ providerMessageId, status, failureReason = "" }) => {
  if (!DELIVERY_STATES.includes(status)) throw new AppError("Invalid delivery status", 400);
  const row = await MessageDelivery.findOne({ providerMessageId });
  if (!row) throw new AppError("Message delivery not found", 404);
  return updateDeliveryStatus({ businessId: row.businessId, providerMessageId, status, failureReason });
};

module.exports = {
  CHANNELS,
  TEMPLATE_CATEGORIES,
  REMINDER_TYPES,
  ALLOWED_TEMPLATE_VARS,
  DEFAULT_TEMPLATE_DEFINITIONS,
  createReminderRule,
  defaultCategoryForReminderTrigger,
  dispatchInvoiceIssuedAutomation,
  dispatchPaymentRecordedAutomation,
  ensureDefaultTemplates,
  extractTemplateVariables,
  findTemplate,
  buildVariables,
  generateReminderRuleName,
  getWhatsAppProviderStatus,
  normalizeChannel,
  normalizeReminderRuleInput,
  normalizePaymentCondition,
  normalizeTemplateCategory,
  processDueReminders,
  processScheduledWorkflowDeliveries,
  renderTemplate,
  scheduleWorkflowMessage,
  scheduledDateForRule,
  scheduleReminder,
  sendInvoiceMessage,
  sendQuoteMessage,
  updateDeliveryStatus,
  updateProviderDeliveryStatus,
  updateWhatsAppAppDeliveryStatus,
  validateTemplateVariables,
};
