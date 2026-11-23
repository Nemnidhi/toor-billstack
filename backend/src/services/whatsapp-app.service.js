const crypto = require("crypto");

// The company's WhatsApp app (oor-whatsapp): BillStack asks it to send invoice, payment-reminder and
// payment-received messages, so they go from the company's one WhatsApp number with a Meta-approved
// template and show in the customer's chat there. Calls are signed: HMAC-SHA256 of
// "<timestamp>.<raw body>" with WHATSAPP_APP_SECRET, caller "billstack"; the app signs its status
// reports back the same way. See the WhatsApp app's docs/INTEGRATION.md.

const TIMEOUT_MS = 15000;
const MAX_SKEW_MS = 5 * 60 * 1000;

const whatsappAppConfig = () => {
  const url = String(process.env.WHATSAPP_APP_URL || "").trim().replace(/\/$/, "");
  const secret = String(process.env.WHATSAPP_APP_SECRET || "");
  return url && secret.length >= 32 ? { url, secret } : null;
};

// Which businesses send through the app: all of them, unless WHATSAPP_APP_BUSINESS_IDS lists some.
const whatsappAppServes = (businessId) => {
  if (!whatsappAppConfig()) return false;
  const list = String(process.env.WHATSAPP_APP_BUSINESS_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return !list.length || (businessId ? list.includes(String(businessId)) : false);
};

const signBody = (secret, timestamp, body) => crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

const verifyWhatsAppAppSignature = ({ timestamp, rawBody = "", signature = "", now = Date.now() }) => {
  const config = whatsappAppConfig();
  if (!config || !timestamp || !signature) return false;
  const at = Number(timestamp);
  if (!Number.isFinite(at) || Math.abs(now - at) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(signBody(config.secret, String(timestamp), rawBody), "hex");
  const given = Buffer.from(String(signature), "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

class WhatsAppAppError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = "WhatsAppAppError";
    this.retryable = retryable;
    this.status = status;
  }
}

const callWhatsAppApp = async (path, payload, { fetchImpl = fetch } = {}) => {
  const config = whatsappAppConfig();
  if (!config) throw new WhatsAppAppError("The WhatsApp app is not linked (WHATSAPP_APP_URL, WHATSAPP_APP_SECRET)");
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  let response;
  try {
    response = await fetchImpl(`${config.url}/integrations/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-oor-caller": "billstack", "x-oor-timestamp": timestamp, "x-oor-signature": signBody(config.secret, timestamp, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new WhatsAppAppError(`Could not reach the WhatsApp app: ${error?.message || error}`, { retryable: true });
  }
  const data = await response.json().catch(() => ({}));
  if (response.ok) return data;
  throw new WhatsAppAppError(`The WhatsApp app answered HTTP ${response.status}: ${String(data?.message || data?.error || "no details").slice(0, 200)}`, {
    retryable: response.status >= 500 || response.status === 429,
    status: response.status,
  });
};

// The app's request status -> BillStack's delivery status.
const APP_STATUS = { scheduled: "SENT", queued: "SENT", sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED", skipped: "SKIPPED", cancelled: "CANCELLED" };

/** Asks the app to send one message. Answers { key, status, reason } in BillStack's terms. */
const sendThroughWhatsAppApp = async ({ key, to, purpose, variables, consent, ref }, options) => {
  const data = await callWhatsAppApp("/messages", { key, to, purpose, variables, consent, ref }, options);
  const row = data?.data || {};
  return { key: row.key || key, status: APP_STATUS[row.status] || "SENT", reason: row.reason || "", appStatus: row.status || "" };
};

module.exports = { APP_STATUS, WhatsAppAppError, callWhatsAppApp, sendThroughWhatsAppApp, signBody, verifyWhatsAppAppSignature, whatsappAppConfig, whatsappAppServes };
