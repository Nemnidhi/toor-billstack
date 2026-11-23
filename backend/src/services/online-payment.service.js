const crypto = require("crypto");
const mongoose = require("mongoose");

const Business = require("../models/Business");
const Invoice = require("../models/Invoice");
const OnlinePaymentLink = require("../models/OnlinePaymentLink");
const WebhookEvent = require("../models/WebhookEvent");
const AppError = require("../utils/appError");
const { log } = require("../utils/logger");
const { canSeal, open, seal } = require("../utils/secretBox");
const { applyFinancialRead } = require("./financial-read.service");
const accountingService = require("./accounting.service");

// Customer payments online: each business links its OWN Razorpay account (the money goes to that
// company, never through BillStack). An invoice gets a Razorpay payment link for what is still due;
// when the customer pays, Razorpay calls the business's webhook, and the payment is recorded against
// the invoice (Dr Razorpay - Settlements Due 1030 / Cr customer), Razorpay's fee as a bank charge, and
// each settlement to the bank as Dr Bank 1020 / Cr 1030 with the UTR, so the bank line matches it.

const RAZORPAY_API = () => String(process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");
const TIMEOUT_MS = 15000;

let fetchImpl = (...args) => fetch(...args);
/** Tests replace the call to Razorpay. */
const setFetchForTests = (fn) => {
  fetchImpl = fn || ((...args) => fetch(...args));
};

const credentialsFor = async (businessId) => {
  const business = await Business.findById(businessId).select("+onlinePayments.keySecretSealed +onlinePayments.webhookSecretSealed");
  const settings = business?.onlinePayments || {};
  if (!business || !settings.enabled || !settings.keyId || !settings.keySecretSealed) return null;
  return { business, keyId: settings.keyId, keySecret: open(settings.keySecretSealed), webhookSecret: settings.webhookSecretSealed ? open(settings.webhookSecretSealed) : "", expiryDays: Number(settings.linkExpiryDays ?? 30) };
};

const razorpayCall = async ({ keyId, keySecret }, method, path, body) => {
  let response;
  try {
    response = await fetchImpl(`${RAZORPAY_API()}${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(`Could not reach Razorpay: ${error?.message || error}`, 502);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = data?.error?.description || data?.message || `HTTP ${response.status}`;
    throw new AppError(`Razorpay refused: ${String(reason).slice(0, 200)}`, response.status === 401 ? 400 : 502);
  }
  return data;
};

// ---------------------------------------------------------------------------
// Settings (owner / admin)
// ---------------------------------------------------------------------------

const settingsOut = (business) => {
  const settings = business?.onlinePayments || {};
  return {
    enabled: Boolean(settings.enabled),
    provider: "RAZORPAY",
    keyId: settings.keyId || "",
    keySecretSaved: Boolean(settings.keySecretSealed),
    webhookSecretSaved: Boolean(settings.webhookSecretSealed),
    linkExpiryDays: Number(settings.linkExpiryDays ?? 30),
    updatedAt: settings.updatedAt || null,
    canStoreSecrets: canSeal(),
    webhookPath: business ? `/api/online-payments/webhooks/razorpay/${business._id}` : "",
    webhookEvents: ["payment_link.paid", "refund.processed", "settlement.processed"],
  };
};

const getSettings = async ({ businessId }) => {
  const business = await Business.findById(businessId).select("+onlinePayments.keySecretSealed +onlinePayments.webhookSecretSealed");
  if (!business) throw new AppError("Business not found", 404);
  return settingsOut(business);
};

/**
 * Saves the business's Razorpay keys. A secret left empty keeps the saved one. Switching on checks the
 * keys with Razorpay first.
 */
const saveSettings = async ({ businessId, userId, body = {} }) => {
  const business = await Business.findById(businessId).select("+onlinePayments.keySecretSealed +onlinePayments.webhookSecretSealed");
  if (!business) throw new AppError("Business not found", 404);
  const current = business.onlinePayments || {};
  const keyId = body.keyId !== undefined ? String(body.keyId || "").trim() : current.keyId || "";
  if (keyId && !/^rzp_(live|test)_[A-Za-z0-9]{6,40}$/.test(keyId)) throw new AppError("Key ID looks like rzp_live_... or rzp_test_...", 400);
  const keySecret = String(body.keySecret || "").trim();
  const webhookSecret = String(body.webhookSecret || "").trim();
  if ((keySecret || webhookSecret) && !canSeal()) throw new AppError("The server cannot store secrets yet (BILLSTACK_DATA_KEY is not set).", 400);
  if (keySecret && keySecret.length < 10) throw new AppError("Key secret looks too short", 400);
  if (webhookSecret && webhookSecret.length < 8) throw new AppError("Webhook secret: at least 8 characters", 400);
  const expiry = body.linkExpiryDays !== undefined ? Number(body.linkExpiryDays) : Number(current.linkExpiryDays ?? 30);
  if (!Number.isInteger(expiry) || expiry < 0 || expiry > 180) throw new AppError("Link expiry: 0 (never) to 180 days", 400);
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : Boolean(current.enabled);

  const next = {
    enabled,
    provider: "RAZORPAY",
    keyId,
    keySecretSealed: keySecret ? seal(keySecret) : current.keySecretSealed || "",
    webhookSecretSealed: webhookSecret ? seal(webhookSecret) : current.webhookSecretSealed || "",
    linkExpiryDays: expiry,
    updatedAt: new Date(),
    updatedBy: userId || null,
  };
  if (enabled) {
    if (!next.keyId || !next.keySecretSealed) throw new AppError("Enter the Razorpay key ID and key secret to switch on payment links", 400);
    if (!next.webhookSecretSealed) throw new AppError("Enter the webhook secret too: without it paid links cannot be recorded automatically", 400);
    // The keys work: Razorpay answers a list call with them.
    await razorpayCall({ keyId: next.keyId, keySecret: keySecret || open(next.keySecretSealed) }, "GET", "/v1/payment_links?count=1");
  }
  business.onlinePayments = next;
  business.markModified("onlinePayments");
  await business.save();
  return settingsOut(business);
};

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const linkOut = (link) => (link ? {
  id: link._id,
  url: link.url,
  amount: Number(link.amountMinor || 0) / 100,
  status: link.status,
  paidAt: link.paidAt,
  paidAmount: Number(link.paidAmountMinor || 0) / 100,
  providerPaymentId: link.providerPaymentId,
  recordError: link.recordError,
  refunds: (link.refunds || []).map((row) => ({ refundId: row.refundId, amount: Number(row.amountMinor || 0) / 100, refundedAt: row.refundedAt, status: row.status, recordedHow: row.recordedHow, recordedAt: row.recordedAt })),
  fullRefund: (link.refunds || []).length === 1 && Number(link.refunds[0].amountMinor) === Number(link.paidAmountMinor),
  createdAt: link.createdAt,
} : null);

const contactNumber = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return digits ? `+${digits}` : "";
};

const cancelAtRazorpay = async (credentials, link) => {
  try {
    await razorpayCall(credentials, "POST", `/v1/payment_links/${encodeURIComponent(link.providerLinkId)}/cancel`);
  } catch (error) {
    log("warn", "Razorpay payment link could not be cancelled", { linkId: String(link._id), error: error.message });
  }
};

/**
 * The open payment link for an invoice's unpaid amount: the existing one when it is for the same
 * amount, otherwise a new one (the old one cancelled). Null when payment links are off for the
 * business or nothing is due. `quiet`: answer null instead of throwing when Razorpay fails (used while
 * sending messages, so a message still goes without a link).
 */
const ensureInvoiceLink = async ({ businessId, invoiceId, userId = null, quiet = false }) => {
  try {
    const credentials = await credentialsFor(businessId);
    if (!credentials) {
      if (quiet) return null;
      throw new AppError("Payment links are not switched on (Settings > Online payments)", 400);
    }
    const raw = await Invoice.findOne({ _id: invoiceId, businessId }).populate("customerId", "name email phone");
    if (!raw) throw new AppError("Invoice not found", 404);
    const invoice = await applyFinancialRead({ businessId, sourceType: "INVOICE", document: raw });
    if (invoice.status === "cancelled" || invoice.status === "draft") {
      if (quiet) return null;
      throw new AppError("Only an issued invoice can have a payment link", 400);
    }
    const dueMinor = Math.round(Number(invoice.balanceDue || 0) * 100);
    const openLink = await OnlinePaymentLink.findOne({ businessId, invoiceId, status: "OPEN" });
    if (dueMinor <= 0) {
      if (openLink) {
        await cancelAtRazorpay(credentials, openLink);
        openLink.status = "CANCELLED";
        openLink.cancelledAt = new Date();
        await openLink.save();
      }
      if (quiet) return null;
      throw new AppError("Nothing is due on this invoice", 400);
    }
    if (openLink && openLink.amountMinor === dueMinor) return openLink;
    if (openLink) {
      await cancelAtRazorpay(credentials, openLink);
      openLink.status = "CANCELLED";
      openLink.cancelledAt = new Date();
      await openLink.save();
    }

    const made = await OnlinePaymentLink.countDocuments({ businessId, invoiceId });
    const referenceId = `${String(invoice.invoiceNumber || invoice._id).replace(/[^A-Za-z0-9/_-]/g, "").slice(0, 30)}-${made + 1}`.slice(0, 40);
    const customer = raw.customerId || {};
    const contact = contactNumber(customer.phone || invoice.customerDetails?.phone);
    const email = customer.email || invoice.customerDetails?.email || "";
    const body = {
      amount: dueMinor,
      currency: "INR",
      accept_partial: false,
      reference_id: referenceId,
      description: `Invoice ${invoice.invoiceNumber} - ${credentials.business.name}`.slice(0, 2048),
      customer: { name: String(customer.name || invoice.customerDetails?.name || "Customer").slice(0, 100), ...(contact ? { contact } : {}), ...(email ? { email } : {}) },
      // BillStack sends the link itself (WhatsApp / email); Razorpay's own SMS / email stay off.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { billstack_business_id: String(businessId), billstack_invoice_id: String(invoiceId), invoice_number: String(invoice.invoiceNumber || "") },
    };
    if (credentials.expiryDays > 0) body.expire_by = Math.floor(Date.now() / 1000) + credentials.expiryDays * 86400;
    const created = await razorpayCall(credentials, "POST", "/v1/payment_links", body);
    if (!created?.id || !created?.short_url) throw new AppError("Razorpay did not return a payment link", 502);
    try {
      return await OnlinePaymentLink.create({ businessId, invoiceId, providerLinkId: created.id, referenceId, url: created.short_url, amountMinor: dueMinor, createdBy: userId });
    } catch (error) {
      // Two sends at once made two links: keep the first, cancel ours.
      if (error?.code === 11000) {
        await cancelAtRazorpay(credentials, { _id: "race", providerLinkId: created.id });
        return OnlinePaymentLink.findOne({ businessId, invoiceId, status: "OPEN" });
      }
      throw error;
    }
  } catch (error) {
    if (quiet) {
      log("warn", "Payment link not made", { invoiceId: String(invoiceId), error: error.message });
      return null;
    }
    throw error;
  }
};

const invoiceLinks = async ({ businessId, invoiceId }) => {
  const [rows, business] = await Promise.all([
    OnlinePaymentLink.find({ businessId, invoiceId }).sort({ createdAt: -1 }).limit(20),
    Business.findById(businessId).select("onlinePayments.enabled"),
  ]);
  return { enabled: Boolean(business?.onlinePayments?.enabled), open: linkOut(rows.find((row) => row.status === "OPEN")), history: rows.map(linkOut) };
};

const cancelInvoiceLink = async ({ businessId, invoiceId }) => {
  const link = await OnlinePaymentLink.findOne({ businessId, invoiceId, status: "OPEN" });
  if (!link) throw new AppError("This invoice has no open payment link", 404);
  const credentials = await credentialsFor(businessId);
  if (credentials) await cancelAtRazorpay(credentials, link);
  link.status = "CANCELLED";
  link.cancelledAt = new Date();
  await link.save();
  return linkOut(link);
};

// ---------------------------------------------------------------------------
// Recording a paid link
// ---------------------------------------------------------------------------

/**
 * Records a paid link once: the payment (idempotent by Razorpay's payment id), its allocation to the
 * invoice (up to what is still due; any extra stays as the customer's advance), and Razorpay's fee.
 */
const recordPaidLink = async ({ link }) => {
  // Lazy: payment.service requires communication.service, which requires this file.
  const { allocatePayment, createPayment } = require("./payment.service");
  const invoice = await Invoice.findOne({ _id: link.invoiceId, businessId: link.businessId });
  if (!invoice) throw new AppError("Invoice not found", 404);
  const userId = link.createdBy || invoice.createdBy;
  const payment = await createPayment({
    businessId: link.businessId,
    userId,
    payload: {
      direction: "RECEIVED",
      customerId: invoice.customerId,
      amount: link.paidAmountMinor / 100,
      paymentDate: link.paidAt || new Date(),
      paymentMethod: "RAZORPAY",
      referenceNumber: link.providerPaymentId,
      idempotencyKey: `RAZORPAY:${link.providerPaymentId}`,
      notes: `Paid online (Razorpay ${link.paymentMethod || "payment"}) through the payment link for invoice ${invoice.invoiceNumber}`,
    },
  });
  link.paymentId = payment._id;

  const PaymentAllocation = require("../models/PaymentAllocation");
  const already = await PaymentAllocation.findOne({ businessId: link.businessId, paymentId: payment._id, invoiceId: invoice._id });
  if (!already) {
    const derived = await applyFinancialRead({ businessId: link.businessId, sourceType: "INVOICE", document: invoice });
    const allocateMinor = Math.min(link.paidAmountMinor, Math.round(Number(derived.balanceDue || 0) * 100));
    if (allocateMinor > 0 && invoice.status !== "cancelled") {
      await allocatePayment({ businessId: link.businessId, userId, paymentId: payment._id, payload: { invoiceId: invoice._id, allocatedAmount: allocateMinor / 100 } });
    }
  }

  // Razorpay keeps its fee (with GST) from what it settles.
  const feeMinor = Number(link.feeMinor || 0);
  if (feeMinor > 0) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const accounts = await accountingService.ensureDefaultAccounts({ businessId: link.businessId, session });
        const JournalEntry = require("../models/JournalEntry");
        const sourceKey = `RAZORPAY_FEE:${link.providerPaymentId}`;
        if (await JournalEntry.findOne({ businessId: link.businessId, sourceKey }).session(session)) return;
        await accountingService.postJournalEntry({
          businessId: link.businessId,
          userId,
          entryDate: link.paidAt || new Date(),
          sourceType: "PAYMENT",
          sourceId: payment._id,
          sourceKey,
          description: `Razorpay fee on ${link.providerPaymentId} (invoice ${invoice.invoiceNumber}; includes GST ${(Number(link.taxMinor || 0) / 100).toFixed(2)})`,
          lines: [
            accountingService.postingLine(accounts.get("5140"), feeMinor, 0, `Razorpay fee ${link.providerPaymentId}`),
            accountingService.postingLine(accounts.get("1030"), 0, feeMinor, `Razorpay fee kept from settlement ${link.providerPaymentId}`),
          ],
          session,
        });
      });
    } finally {
      session.endSession();
    }
  }
  link.status = "PAID";
  link.recordError = "";
  await link.save();
  return link;
};

const recordAgain = async ({ businessId, invoiceId }) => {
  const link = await OnlinePaymentLink.findOne({ businessId, invoiceId, status: "PAID_NOT_RECORDED" }).sort({ paidAt: -1 });
  if (!link) throw new AppError("Nothing paid online is waiting to be recorded on this invoice", 404);
  try {
    return linkOut(await recordPaidLink({ link }));
  } catch (error) {
    link.recordError = error.message;
    await link.save();
    throw error;
  }
};

const handlePaidEvent = async ({ businessId, payload }) => {
  const linkEntity = payload?.payload?.payment_link?.entity || {};
  const paymentEntity = payload?.payload?.payment?.entity || {};
  if (!linkEntity.id || !paymentEntity.id) throw new AppError("payment_link.paid without a link or payment", 400);
  const link = await OnlinePaymentLink.findOne({ businessId, providerLinkId: linkEntity.id });
  if (!link) return { ignored: "not a BillStack link of this business" };
  if (link.status === "PAID" && link.providerPaymentId === paymentEntity.id) return { duplicate: true };
  link.status = "PAID_NOT_RECORDED";
  link.providerPaymentId = paymentEntity.id;
  link.paidAmountMinor = Number(paymentEntity.amount || linkEntity.amount_paid || 0);
  link.feeMinor = Number(paymentEntity.fee || 0);
  link.taxMinor = Number(paymentEntity.tax || 0);
  link.paymentMethod = String(paymentEntity.method || "");
  link.paidAt = paymentEntity.created_at ? new Date(Number(paymentEntity.created_at) * 1000) : new Date();
  await link.save();
  try {
    await recordPaidLink({ link });
    return { recorded: true };
  } catch (error) {
    // Paid, but not recordable now (books locked for that date, ...): shown on the invoice to record again.
    link.recordError = error.message;
    await link.save();
    log("error", "Paid Razorpay link could not be recorded", { linkId: String(link._id), error: error.message });
    return { recorded: false, reason: error.message };
  }
};

// ---------------------------------------------------------------------------
// Settlements: posted by themselves only when BillStack knows every line in them
// ---------------------------------------------------------------------------

const OnlinePaymentSettlement = require("../models/OnlinePaymentSettlement");

const IST_OFFSET_MS = 330 * 60 * 1000;
const dayParts = (date, offsetMs) => {
  const d = new Date(date.getTime() + offsetMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/** Razorpay's settlement recon lines for one settlement (looked up by the day it was made). */
const settlementLines = async (credentials, settlementId, settledAt) => {
  const days = [dayParts(settledAt, IST_OFFSET_MS), dayParts(settledAt, 0)]
    .filter((d, i, all) => all.findIndex((x) => x.year === d.year && x.month === d.month && x.day === d.day) === i);
  for (const d of days) {
    const lines = [];
    for (let skip = 0; skip < 10000; skip += 1000) {
      const page = await razorpayCall(credentials, "GET", `/v1/settlements/recon/combined?year=${d.year}&month=${d.month}&day=${d.day}&count=1000&skip=${skip}`);
      const items = Array.isArray(page?.items) ? page.items : [];
      lines.push(...items.filter((item) => item.settlement_id === settlementId));
      if (items.length < 1000) break;
    }
    if (lines.length) return lines;
  }
  return [];
};

/** Which recon lines BillStack already has in its books (payments of its links, refunds it recorded). */
const classifyLines = async (businessId, items) => {
  const lines = [];
  for (const item of items) {
    const type = String(item.type || "").toLowerCase();
    const line = {
      type,
      entityId: String(item.entity_id || ""),
      paymentId: String(item.payment_id || ""),
      creditMinor: Number(item.credit || 0),
      debitMinor: Number(item.debit || 0),
      feeMinor: Number(item.fee || 0),
      taxMinor: Number(item.tax || 0),
      description: String(item.description || "").slice(0, 200),
      inBillStack: false,
      invoiceId: null,
    };
    if (type === "payment") {
      const link = await OnlinePaymentLink.findOne({ businessId, providerPaymentId: line.entityId, status: "PAID" }).select("invoiceId");
      if (link) Object.assign(line, { inBillStack: true, invoiceId: link.invoiceId });
    } else if (type === "refund") {
      const link = await OnlinePaymentLink.findOne({ businessId, refunds: { $elemMatch: { refundId: line.entityId, status: "RECORDED" } } }).select("invoiceId");
      if (link) Object.assign(line, { inBillStack: true, invoiceId: link.invoiceId });
    }
    lines.push(line);
  }
  return lines;
};

const postSettlementJournal = async ({ businessId, settlement, userId }) => {
  const JournalEntry = require("../models/JournalEntry");
  const sourceKey = `RAZORPAY_SETTLEMENT:${settlement.settlementId}`;
  const existing = await JournalEntry.findOne({ businessId, sourceKey });
  if (existing) return existing;
  let entry = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const accounts = await accountingService.ensureDefaultAccounts({ businessId, session });
      entry = await accountingService.postJournalEntry({
        businessId,
        userId,
        entryDate: settlement.settledAt || new Date(),
        sourceType: "MANUAL",
        sourceKey,
        // The UTR in the description: the bank statement line carries it, so it matches exactly.
        description: `Razorpay settlement ${settlement.settlementId} UTR ${settlement.utr || "-"}`,
        lines: [
          accountingService.postingLine(accounts.get("1020"), settlement.amountMinor, 0, `Razorpay settlement ${settlement.utr || settlement.settlementId}`),
          accountingService.postingLine(accounts.get("1030"), 0, settlement.amountMinor, `Razorpay settlement ${settlement.settlementId}`),
        ],
        session,
      });
    });
  } finally {
    session.endSession();
  }
  return entry;
};

const rupees = (minor) => `Rs ${(Number(minor || 0) / 100).toFixed(2)}`;

const handleSettlementEvent = async ({ businessId, payload }) => {
  const entity = payload?.payload?.settlement?.entity || {};
  if (!entity.id || !Number(entity.amount)) return { ignored: "no settlement amount" };
  const already = await OnlinePaymentSettlement.findOne({ businessId, settlementId: entity.id });
  if (already && already.status !== "NEEDS_REVIEW") return { duplicate: true };
  const settledAt = entity.created_at ? new Date(Number(entity.created_at) * 1000) : new Date();
  const settlement = already || new OnlinePaymentSettlement({ businessId, settlementId: entity.id });
  Object.assign(settlement, { utr: String(entity.utr || ""), amountMinor: Number(entity.amount), settledAt });

  let reason = "";
  try {
    const credentials = await credentialsFor(businessId);
    if (!credentials) throw new AppError("payment links are switched off, so the breakdown could not be fetched", 400);
    settlement.lines = await classifyLines(businessId, await settlementLines(credentials, entity.id, settledAt));
    const net = settlement.lines.reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);
    const unknown = settlement.lines.filter((line) => !line.inBillStack);
    if (!settlement.lines.length) reason = "Razorpay's breakdown of this settlement was not found";
    else if (unknown.length) reason = `${unknown.length} line(s) in it are not in BillStack: ${unknown.slice(0, 5).map((line) => `${line.type} ${line.entityId} ${rupees(line.creditMinor || line.debitMinor)}`).join("; ")}`;
    else if (net !== settlement.amountMinor) reason = `the lines add up to ${rupees(net)}, the settlement is ${rupees(settlement.amountMinor)}`;
  } catch (error) {
    reason = `could not check the breakdown with Razorpay (${error.message})`;
  }

  if (reason) {
    settlement.status = "NEEDS_REVIEW";
    settlement.reason = reason;
    await settlement.save();
    log("warn", "Razorpay settlement waits for review", { businessId: String(businessId), settlementId: entity.id, reason });
    return { recorded: false, reason };
  }
  const business = await Business.findById(businessId).select("ownerUserId onlinePayments.updatedBy");
  const entry = await postSettlementJournal({ businessId, settlement, userId: business?.onlinePayments?.updatedBy || business?.ownerUserId });
  Object.assign(settlement, { status: "POSTED", reason: "", journalEntryId: entry?._id || null, decidedAt: new Date() });
  await settlement.save();
  return { recorded: true };
};

const settlementOut = (row) => ({
  id: row._id,
  settlementId: row.settlementId,
  utr: row.utr,
  amount: Number(row.amountMinor || 0) / 100,
  settledAt: row.settledAt,
  status: row.status,
  reason: row.reason,
  lines: (row.lines || []).map((line) => ({ type: line.type, entityId: line.entityId, credit: line.creditMinor / 100, debit: line.debitMinor / 100, fee: line.feeMinor / 100, inBillStack: line.inBillStack, invoiceId: line.invoiceId, description: line.description })),
  decidedAt: row.decidedAt,
});

const listSettlements = async ({ businessId }) => {
  const rows = await OnlinePaymentSettlement.find({ businessId }).sort({ settledAt: -1, createdAt: -1 }).limit(30);
  return rows.map(settlementOut);
};

/**
 * The accountant's decision on a settlement waiting for review: "post" moves the whole amount from
 * 1030 to the bank (after the lines BillStack didn't know are recorded, e.g. as Razorpay receipts);
 * "by_hand" means they booked it themselves and BillStack posts nothing.
 */
const decideSettlement = async ({ businessId, id, userId, action }) => {
  if (!mongoose.isValidObjectId(id)) throw new AppError("Settlement not found", 404);
  const settlement = await OnlinePaymentSettlement.findOne({ _id: id, businessId });
  if (!settlement) throw new AppError("Settlement not found", 404);
  if (settlement.status !== "NEEDS_REVIEW") throw new AppError("This settlement is already done", 409);
  if (action === "post") {
    const entry = await postSettlementJournal({ businessId, settlement, userId });
    Object.assign(settlement, { status: "POSTED", journalEntryId: entry?._id || null });
  } else if (action === "by_hand") {
    settlement.status = "RECORDED_BY_HAND";
  } else {
    throw new AppError("Choose post or by_hand", 400);
  }
  Object.assign(settlement, { decidedBy: userId || null, decidedAt: new Date() });
  await settlement.save();
  return settlementOut(settlement);
};

// ---------------------------------------------------------------------------
// Refunds made in Razorpay
// ---------------------------------------------------------------------------

const handleRefundEvent = async ({ businessId, payload }) => {
  const refund = payload?.payload?.refund?.entity || {};
  if (!refund.id || !refund.payment_id) return { ignored: "refund without an id" };
  const link = await OnlinePaymentLink.findOne({ businessId, providerPaymentId: refund.payment_id });
  if (!link) return { ignored: "not a payment of a BillStack link" };
  if ((link.refunds || []).some((row) => row.refundId === refund.id)) return { duplicate: true };
  link.refunds.push({ refundId: refund.id, amountMinor: Number(refund.amount || 0), refundedAt: refund.created_at ? new Date(Number(refund.created_at) * 1000) : new Date() });
  await link.save();
  log("warn", "Razorpay refund to record", { businessId: String(businessId), invoiceId: String(link.invoiceId), refundId: refund.id });
  return { refund: "waiting to be recorded on the invoice" };
};

/**
 * Records a refund on the invoice. "reverse" (full refund only): reverses the payment's allocations and
 * the payment, so the invoice is due again and Razorpay - Settlements Due goes down by the refund.
 * "done": the accountant recorded it another way (credit note and refund payment).
 */
const recordRefund = async ({ businessId, invoiceId, refundId, userId, how }) => {
  const link = await OnlinePaymentLink.findOne({ businessId, invoiceId, "refunds.refundId": refundId });
  if (!link) throw new AppError("Refund not found on this invoice", 404);
  const refund = link.refunds.find((row) => row.refundId === refundId);
  if (refund.status === "RECORDED") throw new AppError("This refund is already recorded", 409);
  if (how === "reverse") {
    if (!link.paymentId) throw new AppError("The payment was never recorded, so there is nothing to reverse", 400);
    const refundedMinor = link.refunds.reduce((sum, row) => sum + Number(row.amountMinor || 0), 0);
    if (link.refunds.length !== 1 || refundedMinor !== Number(link.paidAmountMinor)) {
      throw new AppError("Only a full refund can be reversed in one step; record a partial refund with a credit note, then mark it done", 400);
    }
    const { reverseAllocation, reversePayment } = require("./payment.service");
    const PaymentAllocation = require("../models/PaymentAllocation");
    const PaymentAllocationReversal = require("../models/PaymentAllocationReversal");
    const allocations = await PaymentAllocation.find({ businessId, paymentId: link.paymentId });
    for (const allocation of allocations) {
      if (await PaymentAllocationReversal.findOne({ businessId, allocationId: allocation._id })) continue;
      await reverseAllocation({ businessId, userId, allocationId: allocation._id, amount: allocation.allocatedAmount, reason: `Refunded through Razorpay (${refundId})` });
    }
    await reversePayment({ businessId, userId, paymentId: link.paymentId, reason: `Refunded through Razorpay (${refundId})` });
  } else if (how !== "done") {
    throw new AppError("Choose reverse or done", 400);
  }
  Object.assign(refund, { status: "RECORDED", recordedHow: how === "reverse" ? "payment reversed" : "recorded by hand", recordedBy: userId || null, recordedAt: new Date() });
  link.markModified("refunds");
  await link.save();
  return linkOut(link);
};

const verifyRazorpaySignature = (secret, rawBody, signature) => {
  if (!secret || !signature) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

/** Razorpay's call to a business's webhook: signature checked with that business's webhook secret. */
const handleWebhook = async ({ businessId, rawBody, signature, eventId }) => {
  if (!mongoose.isValidObjectId(businessId)) throw new AppError("Unknown business", 404);
  const credentials = await credentialsFor(businessId);
  if (!credentials?.webhookSecret || !verifyRazorpaySignature(credentials.webhookSecret, rawBody, signature)) throw new AppError("Invalid Razorpay webhook signature", 400);
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new AppError("Invalid JSON", 400);
  }
  const id = String(eventId || `${payload.event}:${payload.payload?.payment?.entity?.id || payload.payload?.refund?.entity?.id || payload.payload?.settlement?.entity?.id || payload.created_at}`);
  const key = { provider: "razorpay-links", eventId: `${businessId}:${id}` };
  await WebhookEvent.create({ ...key, eventType: payload.event || "unknown", payload, status: "RECEIVED" }).catch((error) => {
    if (error?.code !== 11000) throw error;
  });
  // Claim it in one step, so two copies of the same event arriving together are handled once. A claim
  // left by a crash is taken over after 5 minutes.
  const event = await WebhookEvent.findOneAndUpdate(
    { ...key, $or: [{ status: { $in: ["RECEIVED", "FAILED"] } }, { status: "PROCESSING", updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }] },
    { $set: { status: "PROCESSING" } },
    { new: true }
  );
  if (!event) return { duplicate: true };
  let result = { ignored: payload.event };
  try {
    if (payload.event === "payment_link.paid") result = await handlePaidEvent({ businessId, payload });
    else if (payload.event === "settlement.processed") result = await handleSettlementEvent({ businessId, payload });
    else if (payload.event === "refund.processed") result = await handleRefundEvent({ businessId, payload });
    else if (["payment_link.expired", "payment_link.cancelled"].includes(payload.event)) {
      const providerLinkId = payload?.payload?.payment_link?.entity?.id;
      if (providerLinkId) await OnlinePaymentLink.updateOne({ businessId, providerLinkId, status: "OPEN" }, { $set: { status: payload.event.endsWith("expired") ? "EXPIRED" : "CANCELLED", cancelledAt: new Date() } });
      result = { closed: true };
    }
  } catch (error) {
    // Razorpay retries a failed delivery; the claim is released for it.
    event.status = "FAILED";
    event.errorMessage = String(error.message || error).slice(0, 500);
    await event.save();
    throw error;
  }
  event.status = "PROCESSED";
  event.errorMessage = result.reason || "";
  await event.save();
  return result;
};

module.exports = { cancelInvoiceLink, decideSettlement, ensureInvoiceLink, getSettings, handleWebhook, invoiceLinks, linkOut, listSettlements, recordAgain, recordRefund, saveSettings, setFetchForTests, verifyRazorpaySignature };
