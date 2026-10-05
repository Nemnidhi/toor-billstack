import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  changeSubscriptionPlanRequest,
  communicationSummaryRequest,
  createSampleDataRequest,
  createSubscriptionRequest,
  currentPlanRequest,
  currentSubscriptionRequest,
  listPlansRequest,
  removeSampleDataRequest,
} from "../../auth/api";
import { authStore } from "../../../store/authStore";

const getApiOrigin = () => {
  const apiBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api";
  return apiBase.replace(/\/api$/, "");
};

const planRank = {
  free: 0,
  starter: 1,
  basic: 1,
  growth: 2,
  pro: 3,
  enterprise: 4,
};

const formatPrice = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const formatLimit = (value, suffix = "") =>
  Number(value) === Number.MAX_SAFE_INTEGER ? "Unlimited" : `${Number(value || 0)}${suffix}`;

const getTrialDaysRemaining = (trialEndsAt) => {
  if (!trialEndsAt) return null;
  const remaining = Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return Math.max(0, remaining);
};

const mergePlanIntoBusiness = (business, planData) => ({
  ...(business || {}),
  planCode: planData?.planCode || business?.planCode || "free",
  plan: planData?.plan || business?.plan,
  entitlements: planData?.entitlements || business?.entitlements,
  subscription: planData?.subscription || business?.subscription,
  invoiceUsage: planData?.invoiceUsage || business?.invoiceUsage,
});

let razorpayScriptPromise = null;

const ensureRazorpayCheckout = () => {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);

  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }

  return razorpayScriptPromise;
};

const SubscriptionPage = () => {
  const { business, updateBusiness, user } = authStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [plans, setPlans] = useState([]);
  const [currentPlan, setCurrentPlan] = useState(null);
  const [subscriptionState, setSubscriptionState] = useState(business?.subscription || null);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [selectedPlanCode, setSelectedPlanCode] = useState(business?.planCode || "free");
  const [isPlanSaving, setIsPlanSaving] = useState(false);
  const [planError, setPlanError] = useState("");
  const [planSuccess, setPlanSuccess] = useState("");
  const [communicationSummary, setCommunicationSummary] = useState(null);
  const [billingCycle, setBillingCycle] = useState("monthly");
  const [sampleMessage, setSampleMessage] = useState("");

  const refreshSubscriptionState = async () => {
    try {
      const data = await currentSubscriptionRequest();
      updateBusiness(data);
      setCurrentPlan({
        planCode: data.planCode,
        plan: data.plan,
        invoiceUsage: data.invoiceUsage,
        usage: data.usage,
        recommendation: data.recommendation,
      });
      setSubscriptionState(data.subscription);
      setSelectedPlanCode(data.subscription?.pendingPlanCode || data.planCode);
    } catch (error) {
      setPlanError(error.response?.data?.message || "Unable to refresh subscription");
    }
  };

  useEffect(() => {
    const loadPlanData = async () => {
      setIsLoadingPlans(true);
      setPlanError("");

      try {
        const [availablePlans, activePlan] = await Promise.all([
          listPlansRequest(),
          currentPlanRequest(),
        ]);

        setPlans(availablePlans);
        setCurrentPlan(activePlan);
        setSelectedPlanCode(activePlan.subscription?.pendingPlanCode || activePlan.planCode);
        setSubscriptionState(activePlan.subscription);
        updateBusiness(mergePlanIntoBusiness(business, activePlan));
      } catch (error) {
        setPlanError(error.response?.data?.message || "Unable to load plan data");
      } finally {
        setIsLoadingPlans(false);
      }
    };

    loadPlanData();
    communicationSummaryRequest()
      .then(setCommunicationSummary)
      .catch(() => setCommunicationSummary(null));
  }, []);

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const billingStatus = searchParams.get("billing");
    const billingMessage = searchParams.get("message");

    if (!billingStatus) return;

    const consumeCallbackState = async () => {
      if (billingStatus === "success") {
        setPlanSuccess("Payment verified successfully. Your subscription is now active.");
        setPlanError("");
        await refreshSubscriptionState();
      } else {
        setPlanSuccess("");
        setPlanError(billingMessage || "Razorpay payment could not be verified.");
      }

      navigate(location.pathname, { replace: true });
    };

    consumeCallbackState();
  }, [location.pathname, location.search, navigate]);

  const handlePlanSubmit = async () => {
    setIsPlanSaving(true);
    setPlanError("");
    setPlanSuccess("");

    try {
      let data;

      if (selectedPlanCode === "free") {
        data = await changeSubscriptionPlanRequest({
          planCode: "free",
          scheduleChangeAt: "now",
        });
        setPlanSuccess("Downgraded to Free plan.");
      } else if (!subscriptionState?.razorpaySubscriptionId || business?.planCode === "free") {
        const subscriptionData = await createSubscriptionRequest({
          planCode: selectedPlanCode,
          totalCount: 12,
          quantity: 1,
        });
        data = subscriptionData.business;
        setPlanSuccess("Opening Razorpay checkout to authorize your subscription.");

        const hasCheckout = await ensureRazorpayCheckout();

        if (hasCheckout && subscriptionData.subscriptionId && subscriptionData.razorpayKeyId) {
          const checkout = new window.Razorpay({
            key: subscriptionData.razorpayKeyId,
            subscription_id: subscriptionData.subscriptionId,
            name: "BillStack",
            description: `Activate ${selectedPlanCode} plan`,
            callback_url: `${getApiOrigin()}/api/billing/subscription/callback`,
            redirect: true,
            prefill: {
              name: business?.name || "",
              email: business?.billingEmail || business?.email || "",
              contact: business?.phone || "",
            },
            notes: {
              businessId: business?.id || "",
              businessName: business?.name || "",
              targetPlanCode: selectedPlanCode,
            },
            modal: {
              ondismiss: () => setPlanSuccess("Checkout closed. You can retry plan activation anytime."),
            },
            theme: { color: "#3B82F6" },
          });

          checkout.open();
        } else if (subscriptionData.shortUrl) {
          window.location.href = subscriptionData.shortUrl;
        } else {
          throw new Error("Unable to open Razorpay checkout");
        }
      } else {
        data = await changeSubscriptionPlanRequest({
          planCode: selectedPlanCode,
          scheduleChangeAt:
            (planRank[selectedPlanCode] || 0) > (planRank[business?.planCode] || 0)
              ? "now"
              : "cycle_end",
        });
        setPlanSuccess("Subscription change scheduled successfully.");
      }

      updateBusiness(data);
      setCurrentPlan({
        planCode: data.planCode,
        plan: data.plan,
        invoiceUsage: data.invoiceUsage,
        usage: data.usage,
        recommendation: currentPlan?.recommendation,
      });
      setSubscriptionState(data.subscription);
      setSelectedPlanCode(data.subscription?.pendingPlanCode || data.planCode);
    } catch (error) {
      setPlanError(error.response?.data?.message || "Unable to update plan");
    } finally {
      setIsPlanSaving(false);
    }
  };

  const handleSampleData = async (action) => {
    setSampleMessage("");
    setPlanError("");
    try {
      const data = action === "create" ? await createSampleDataRequest() : await removeSampleDataRequest();
      setSampleMessage(data.message || (action === "create" ? "Sample data created." : "Sample data removed."));
    } catch (error) {
      setPlanError(error.response?.data?.message || "Unable to update sample data");
    }
  };

  const recommendation = currentPlan?.recommendation;
  const trialDaysRemaining = getTrialDaysRemaining(subscriptionState?.trialEndsAt);

  if (business?.deploymentMode === "SELF_HOSTED") {
    return (
      <div className="space-y-6">
        <section className="theme-hero rounded-[2rem] p-6 sm:p-8">
          <p className="theme-hero-kicker text-sm uppercase tracking-[0.3em]">Workspace Provisioning</p>
          <h2 className="theme-hero-title mt-3 text-3xl font-semibold">Enterprise Deployment • Powered by NEMNIDHI</h2>
          <p className="theme-hero-copy mt-3 max-w-3xl text-sm leading-relaxed">
            This workspace is dedicatedly provisioned and managed by NEMNIDHI. All multi-entity accounting engines, real-estate workflows, and enterprise modules are fully licensed and active.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="theme-hero rounded-[2rem] p-6 sm:p-8">
        <p className="theme-hero-kicker text-sm uppercase tracking-[0.3em]">Subscription</p>
        <h2 className="theme-hero-title mt-3 text-3xl font-semibold">Plan, billing, and usage</h2>
        <p className="theme-hero-copy mt-3 max-w-3xl text-sm">
          Manage the authoritative BillStack subscription, plan limits, Razorpay checkout,
          and communications quota from one focused place.
        </p>
        {subscriptionState?.status === "trial" ? (
          <div className="mt-5 rounded-2xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            You are on a Pro trial
            {trialDaysRemaining !== null ? ` with ${trialDaysRemaining} day${trialDaysRemaining === 1 ? "" : "s"} remaining.` : "."}
            {" "}After expiry, BillStack falls back to Free without deleting tenant data.
          </div>
        ) : null}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6 rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-xl font-semibold text-white">Choose a plan</h3>
              <p className="mt-2 text-sm text-slate-400">
                Plan guards and prices are enforced by the backend. This screen only displays authoritative SaaS plan data.
              </p>
            </div>
            <div className="inline-flex rounded-2xl border border-white/10 bg-slate-950/60 p-1 text-xs">
              {["monthly", "yearly"].map((cycle) => (
                <button
                  key={cycle}
                  type="button"
                  onClick={() => setBillingCycle(cycle)}
                  className={`rounded-xl px-3 py-2 font-semibold capitalize ${
                    billingCycle === cycle ? "bg-white text-slate-950" : "text-slate-300"
                  }`}
                >
                  {cycle}
                </button>
              ))}
            </div>
          </div>

          {recommendation ? (
            <div className="rounded-2xl border border-brand-400/30 bg-brand-500/10 p-4 text-sm text-brand-100">
              Recommended plan: <span className="font-semibold text-white">{recommendation.recommendedPlanCode}</span>
              <p className="mt-1 text-xs text-brand-100/80">{recommendation.reasons?.join(" ")}</p>
            </div>
          ) : null}

          {isLoadingPlans ? (
            <p className="text-sm text-slate-400">Loading plans...</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {plans.map((plan) => (
                <label
                  key={plan.code}
                  className={`block rounded-2xl border p-4 ${
                    selectedPlanCode === plan.code
                      ? "border-brand-500 bg-brand-500/10"
                      : "border-white/10 bg-slate-950/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-semibold text-white">{plan.name}</p>
                      {plan.badgeText || plan.recommended ? (
                        <span className="mt-2 inline-flex rounded-full bg-emerald-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-200">
                          {plan.badgeText || "Recommended"}
                        </span>
                      ) : null}
                      <p className="mt-1 text-sm text-slate-400">
                        {plan.shortDescription || "BillStack plan"}
                      </p>
                    </div>
                    <input
                      type="radio"
                      name="planCode"
                      checked={selectedPlanCode === plan.code}
                      onChange={() => setSelectedPlanCode(plan.code)}
                    />
                  </div>
                  <div className="mt-4">
                    <p className="text-2xl font-semibold text-white">
                      {formatPrice(billingCycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice)}
                      <span className="ml-1 text-xs font-normal text-slate-400">
                        /{billingCycle === "yearly" ? "year" : "month"}
                      </span>
                    </p>
                    {billingCycle === "yearly" && plan.monthlyPrice > 0 && plan.yearlyPrice > 0 ? (
                      <p className="mt-1 text-xs text-emerald-300">
                        Save {formatPrice(plan.monthlyPrice * 12 - plan.yearlyPrice)} yearly
                      </p>
                    ) : null}
                    {plan.trialEligible && plan.trialDays ? (
                      <p className="mt-1 text-xs text-amber-200">
                        {plan.trialDays}-day trial eligible for new businesses
                      </p>
                    ) : null}
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-slate-300">
                    <span>Invoices: {formatLimit(plan.invoiceMonthlyLimit, " / month")}</span>
                    <span>Staff users: {formatLimit(plan.staffUserLimit)}</span>
                    <span>Inventory: {plan.inventoryAccess ? "Yes" : "No"}</span>
                    <span>Purchases: {plan.purchasesAccess ? "Yes" : "No"}</span>
                    <span>Quotations: {plan.quotationsAccess ? "Yes" : "No"}</span>
                    <span>Credit notes / returns: {plan.creditNotesAccess || plan.salesReturnsAccess ? "Yes" : "No"}</span>
                    <span>Reports: {plan.reportsAccess ? "Yes" : "No"}</span>
                    <span>PDF templates: {plan.pdfTemplatesAccess ? "Yes" : "No"}</span>
                    <span>Sharing: {plan.sharingAccess ? "Yes" : "No"}</span>
                    <span>Communications: {plan.communicationsAccess ? "Yes" : "No"}</span>
                    <span>
                      WhatsApp quota:{" "}
                      {formatLimit(plan.whatsappMonthlyQuota, " / month")}
                    </span>
                    <span>GST/e-invoice: {plan.advancedGstAccess || plan.eInvoiceAccess ? "Advanced" : "Basic"}</span>
                  </div>
                </label>
              ))}
            </div>
          )}

          {planError ? <p className="text-sm text-rose-400">{planError}</p> : null}
          {planSuccess ? <p className="text-sm text-emerald-300">{planSuccess}</p> : null}

          <button
            type="button"
            disabled={isPlanSaving || user?.role !== "owner"}
            onClick={handlePlanSubmit}
            className="rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isPlanSaving ? "Processing..." : user?.role === "owner" ? "Change subscription plan" : "Owner only"}
          </button>
        </div>

        <div className="space-y-6">
          {currentPlan ? (
            <div className="rounded-3xl border border-white/10 bg-white/5 p-6 text-sm text-slate-300">
              <h3 className="text-xl font-semibold text-white">Current subscription</h3>
              <p className="mt-4">Current plan: <span className="font-semibold text-white">{currentPlan.plan.name}</span></p>
              <p className="mt-2">
                Invoice usage: {currentPlan.invoiceUsage?.count || 0}
                {currentPlan.plan.invoiceMonthlyLimit === Number.MAX_SAFE_INTEGER
                  ? " / unlimited"
                  : ` / ${currentPlan.plan.invoiceMonthlyLimit}`}
              </p>
              <p className="mt-2">Subscription status: <span className="font-semibold text-white">{subscriptionState?.status || "inactive"}</span></p>
              <p className="mt-2">Lifecycle: <span className="font-semibold text-white">{subscriptionState?.lifecycleStatus || "FREE"}</span></p>
              <p className="mt-2">Access: <span className="font-semibold text-white">{subscriptionState?.isAccessible ? "Active" : subscriptionState?.isExpired ? "Expired" : "Restricted"}</span></p>
              {subscriptionState?.currentEnd ? <p className="mt-2">Expires: {new Date(subscriptionState.currentEnd).toLocaleString()}</p> : null}
              {currentPlan?.usage?.whatsapp ? (
                <p className="mt-2">
                  WhatsApp usage: {currentPlan.usage.whatsapp.sent} /{" "}
                  {currentPlan.usage.whatsapp.quota === Number.MAX_SAFE_INTEGER
                    ? "unlimited"
                    : currentPlan.usage.whatsapp.quota}
                </p>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-3">
                {subscriptionState?.shortUrl ? (
                  <button
                    type="button"
                    onClick={() => window.open(subscriptionState.shortUrl, "_blank")}
                    className="rounded-2xl border border-white/10 px-4 py-2 text-sm text-slate-200"
                  >
                    Open hosted checkout
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={refreshSubscriptionState}
                  className="rounded-2xl border border-white/10 px-4 py-2 text-sm text-slate-200"
                >
                  Refresh billing status
                </button>
              </div>
            </div>
          ) : null}

          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <p className="text-sm font-semibold text-white">Try BillStack with safe sample data</p>
            <p className="mt-3 text-sm text-slate-300">
              Add a tagged sample customer, product, and invoice to explore onboarding, billing,
              and reports. Sample records are isolated so they can be removed later.
            </p>
            {sampleMessage ? <p className="mt-3 text-sm text-emerald-300">{sampleMessage}</p> : null}
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => handleSampleData("create")}
                className="rounded-2xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white"
              >
                Add sample data
              </button>
              <button
                type="button"
                onClick={() => handleSampleData("remove")}
                className="rounded-2xl border border-white/10 px-4 py-2 text-sm text-slate-200"
              >
                Remove sample data
              </button>
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <p className="text-sm font-semibold text-white">Automatic billing verification</p>
            <p className="mt-3 text-sm text-slate-300">
              After Razorpay payment or mandate authorization succeeds, BillStack verifies the
              callback signature on the backend and refreshes your subscription automatically.
            </p>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <p className="text-sm font-semibold text-white">Communications quota readiness</p>
            <p className="mt-2 text-sm text-slate-300">
              WhatsApp/SMS sending is available only when provider credentials and plan entitlement are enabled.
            </p>
            <div className="mt-4 grid gap-2 text-sm text-slate-300">
              <ProviderStatus label="WhatsApp Business API" configured={communicationSummary?.providerStatus?.whatsapp?.configured} />
              <ProviderStatus label="Email delivery" configured={communicationSummary?.providerStatus?.email?.configured} />
              <ProviderStatus label="SMS provider" configured={communicationSummary?.providerStatus?.sms?.configured} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

const ProviderStatus = ({ label, configured }) => (
  <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[.03] px-3 py-2">
    <span>{label}</span>
    <span className={configured ? "text-emerald-300" : "text-amber-300"}>{configured ? "Configured" : "Not configured"}</span>
  </div>
);

export default SubscriptionPage;
