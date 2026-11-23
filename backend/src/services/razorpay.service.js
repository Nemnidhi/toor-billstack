const crypto = require("crypto");
const Razorpay = require("razorpay");

let razorpayInstance = null;

const getRazorpayInstance = () => {
  if (razorpayInstance) {
    return razorpayInstance;
  }

  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return null;
  }

  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });

  return razorpayInstance;
};

const getRazorpayPlanIdForCode = (planCode) => {
  const planMap = {
    starter: process.env.RAZORPAY_PLAN_STARTER_ID || process.env.RAZORPAY_PLAN_BASIC_ID,
    growth: process.env.RAZORPAY_PLAN_GROWTH_ID,
    basic: process.env.RAZORPAY_PLAN_BASIC_ID,
    pro: process.env.RAZORPAY_PLAN_PRO_ID,
    enterprise: process.env.RAZORPAY_PLAN_ENTERPRISE_ID,
  };

  return planMap[planCode] || "";
};

const createRazorpaySubscription = async ({
  planCode,
  totalCount = 12,
  quantity = 1,
  customerNotify = true,
  notes = {},
}) => {
  const razorpay = getRazorpayInstance();

  if (!razorpay) {
    throw new Error("Razorpay is not configured");
  }

  const planId = getRazorpayPlanIdForCode(planCode);

  if (!planId) {
    throw new Error(`No Razorpay plan is configured for ${planCode}`);
  }

  const subscription = await razorpay.subscriptions.create({
    plan_id: planId,
    total_count: totalCount,
    quantity,
    customer_notify: customerNotify,
    notes,
  });

  return subscription;
};

const createRazorpayOrder = async ({ amount, currency = "INR", receipt, notes = {} }) => {
  const razorpay = getRazorpayInstance();

  if (!razorpay) {
    throw new Error("Razorpay is not configured");
  }

  return razorpay.orders.create({
    amount,
    currency,
    receipt,
    notes,
  });
};

const updateRazorpaySubscription = async ({
  subscriptionId,
  planCode,
  quantity = 1,
  remainingCount,
  scheduleChangeAt = "now",
  customerNotify = true,
}) => {
  const razorpay = getRazorpayInstance();

  if (!razorpay) {
    throw new Error("Razorpay is not configured");
  }

  const planId = getRazorpayPlanIdForCode(planCode);

  if (!planId) {
    throw new Error(`No Razorpay plan is configured for ${planCode}`);
  }

  return razorpay.subscriptions.update(subscriptionId, {
    plan_id: planId,
    quantity,
    remaining_count: remainingCount,
    schedule_change_at: scheduleChangeAt,
    customer_notify: customerNotify,
  });
};

const fetchRazorpaySubscription = async (subscriptionId) => {
  const razorpay = getRazorpayInstance();

  if (!razorpay) {
    throw new Error("Razorpay is not configured");
  }

  return razorpay.subscriptions.fetch(subscriptionId);
};

// Constant-time compare of a hex HMAC; false (never a throw) when the secret is not set.
const hmacMatches = (secret, data, signature) => {
  if (!secret || !signature) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(data).digest("hex"));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

const verifyRazorpaySubscriptionPayment = ({
  razorpayPaymentId,
  razorpaySubscriptionId,
  razorpaySignature,
}) => hmacMatches(process.env.RAZORPAY_KEY_SECRET, `${razorpayPaymentId}|${razorpaySubscriptionId}`, razorpaySignature);

const verifyRazorpayOrderPayment = ({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) => {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay is not configured");
  }

  return hmacMatches(process.env.RAZORPAY_KEY_SECRET, `${razorpayOrderId}|${razorpayPaymentId}`, razorpaySignature);
};

const verifyRazorpayWebhookSignature = ({ rawBody, signature }) => hmacMatches(process.env.RAZORPAY_WEBHOOK_SECRET, rawBody, signature);

module.exports = {
  createRazorpaySubscription,
  createRazorpayOrder,
  fetchRazorpaySubscription,
  getRazorpayInstance,
  getRazorpayPlanIdForCode,
  updateRazorpaySubscription,
  verifyRazorpaySubscriptionPayment,
  verifyRazorpayOrderPayment,
  verifyRazorpayWebhookSignature,
};
