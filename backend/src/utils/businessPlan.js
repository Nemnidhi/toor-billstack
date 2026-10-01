const { PLAN_CODES, PLAN_DEFINITIONS } = require("../constants/plans");
const { getPlanEntitlements, isSubscriptionAccessible, isSubscriptionExpired, normalizeStatus } = require("./subscription");

const COMPATIBILITY_PLAN_MAP = {
  [PLAN_CODES.BASIC]: PLAN_CODES.STARTER,
};

const getPlanByCode = (code) => {
  const normalizedCode = String(code || PLAN_CODES.FREE).trim().toLowerCase();
  const mappedCode = COMPATIBILITY_PLAN_MAP[normalizedCode] || normalizedCode;
  return PLAN_DEFINITIONS[mappedCode] || PLAN_DEFINITIONS[PLAN_CODES.FREE];
};

const serializeBusinessWithPlan = (business, subscription = null) => {
  const plan = subscription ? getPlanByCode(subscription.planCode) : getPlanByCode(business.planCode);
  const entitlements = subscription ? getPlanEntitlements(subscription) : plan;

  return {
    id: business._id,
    name: business.name,
    billingEntityCode: business.billingEntityCode || "",
    billingParentId: business.billingParentId || null,
    gstConfiguration: business.gstConfiguration,
    industry: business.industry,
    billingEmail: business.billingEmail,
    email: business.email,
    phone: business.phone,
    address: business.address,
    logoUrl: business.logoUrl,
    signatureUrl: business.signatureUrl,
    gstTaxId: business.gstTaxId,
    bankDetails: business.bankDetails,
    invoiceTerms: business.invoiceTerms,
    defaultTaxSettings: business.defaultTaxSettings,
    invoiceNumbering: business.invoiceNumbering,
    onboardingCompleted: business.onboardingCompleted,
    deploymentMode: business.deploymentMode,
    businessProfile: business.businessProfile,
    planCode: subscription?.planCode || business.planCode,
    plan,
    entitlements,
    isDisabled: business.isDisabled,
    invoiceUsage: business.invoiceUsage,
    inventorySettings: business.inventorySettings,
    createdAt: business.createdAt,
    updatedAt: business.updatedAt,
    subscription: subscription
      ? {
          id: subscription._id,
          planCode: subscription.planCode,
          razorpayPlanId: subscription.razorpayPlanId,
          razorpaySubscriptionId: subscription.razorpaySubscriptionId,
          status: subscription.status,
          lifecycleStatus: normalizeStatus(subscription.status, subscription.planCode).toUpperCase(),
          quantity: subscription.quantity,
          totalCount: subscription.totalCount,
          paidCount: subscription.paidCount,
          currentStart: subscription.currentStart,
          currentEnd: subscription.currentEnd,
          expireBy: subscription.expireBy,
          shortUrl: subscription.shortUrl,
          pendingPlanCode: subscription.pendingPlanCode,
          scheduleChangeAt: subscription.scheduleChangeAt,
          lastPaymentId: subscription.lastPaymentId,
          verifiedAt: subscription.verifiedAt,
          cancelledAt: subscription.cancelledAt,
          isAccessible: isSubscriptionAccessible(subscription),
          isExpired: isSubscriptionExpired(subscription),
          trialEndsAt: subscription.trialEndsAt,
          graceEndsAt: subscription.graceEndsAt,
          failedPaymentAt: subscription.failedPaymentAt,
          addonEntitlements: subscription.addonEntitlements,
        }
      : null,
  };
};

module.exports = {
  getPlanByCode,
  serializeBusinessWithPlan,
};
