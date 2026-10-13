import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/PageState";
import MetricCard from "../../dashboard/components/MetricCard";
import CreateWorkspacePanel from "../CreateWorkspacePanel";
import {
  superAdminBusinessesRequest,
  superAdminCreateModuleOfferRequest,
  superAdminListPlansRequest,
  superAdminOverviewRequest,
  superAdminProductConfigurationRequest,
  superAdminReviewCommercialOrderRequest,
  superAdminReviewModuleRequest,
  superAdminSyncCommercialCatalogueRequest,
  superAdminToggleBusinessStatusRequest,
  superAdminUpdateCommercialModuleRequest,
  superAdminUpdateCommercialPlanRequest,
  superAdminUpdateBusinessPlanRequest,
} from "../api";
import { superAdminStore } from "../../../store/superAdminStore";
import { uiStore } from "../../../store/uiStore";

const formatCurrency = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const planFeatureLabel = (value) => (value ? "Enabled" : "Locked");
const formatLimit = (value) =>
  Number(value) === Number.MAX_SAFE_INTEGER ? "Unlimited" : Number(value || 0);
const asArray = (value) => (Array.isArray(value) ? value : []);
const safeDate = (value) => (value ? new Date(value).toLocaleDateString() : "N/A");
const normalizeOverview = (value = {}) => ({
  metrics: {
    totalBusinesses: Number(value?.metrics?.totalBusinesses || 0),
    activeBusinesses: Number(value?.metrics?.activeBusinesses || 0),
    disabledBusinesses: Number(value?.metrics?.disabledBusinesses || 0),
    totalUsers: Number(value?.metrics?.totalUsers || 0),
    activeSubscriptions: Number(value?.metrics?.activeSubscriptions || 0),
    monthlyRecurringRevenue: Number(value?.metrics?.monthlyRecurringRevenue || 0),
    trialUsers: Number(value?.metrics?.trialUsers || 0),
    paidBusinesses: Number(value?.metrics?.paidBusinesses || 0),
    expiredSubscriptions: Number(value?.metrics?.expiredSubscriptions || 0),
    pendingModuleRequests: Number(value?.metrics?.pendingModuleRequests || 0),
    pendingCommercialPayments: Number(value?.metrics?.pendingCommercialPayments || 0),
  },
  revenueChart: asArray(value?.revenueChart),
});
const normalizeProductConfig = (value = {}) => ({
  modules: asArray(value?.modules),
  commercialModules: asArray(value?.commercialModules),
  commercialPlans: asArray(value?.commercialPlans),
  presets: asArray(value?.presets),
  requests: asArray(value?.requests),
  offers: asArray(value?.offers),
  orders: asArray(value?.orders),
});
const statusBadgeClass = (status = "") => {
  const key = String(status || "").toUpperCase();
  if (["ACTIVE", "APPROVED", "PAID", "ACTIVATED"].includes(key)) return "bg-emerald-500/15 text-emerald-200";
  if (["PENDING", "UNDER_REVIEW", "AWAITING_VERIFICATION", "PAYMENT_PENDING", "OFFERED"].includes(key)) return "bg-amber-500/15 text-amber-100";
  if (["REJECTED", "FAILED", "EXPIRED", "CANCELLED", "DISABLED"].includes(key)) return "bg-rose-500/15 text-rose-200";
  return "bg-white/10 text-slate-300";
};
const StatusBadge = ({ children }) => (
  <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(children)}`}>
    {String(children || "N/A").replaceAll("_", " ")}
  </span>
);

const getModuleDisplayName = (moduleKey, productConfig) => {
  const key = String(moduleKey || "");
  return (
    productConfig.commercialModules.find((item) => item.moduleKey === key)?.displayName ||
    productConfig.modules.find((item) => item.key === key)?.name ||
    key ||
    "Module"
  );
};

const modalInputClass =
  "w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-brand-500";

const SuperAdminDashboardPage = () => {
  const { email, clearSession } = superAdminStore();
  const [overview, setOverview] = useState(normalizeOverview());
  const [businesses, setBusinesses] = useState([]);
  const [plans, setPlans] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 1,
  });
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState({
    page: 1,
    planCode: "",
    isDisabled: "",
    search: "",
  });
  const [planSelections, setPlanSelections] = useState({});
  const [isLoadingOverview, setIsLoadingOverview] = useState(true);
  const [isLoadingBusinesses, setIsLoadingBusinesses] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const [businessError, setBusinessError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [busyBusinessId, setBusyBusinessId] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [productConfig, setProductConfig] = useState(normalizeProductConfig());
  const [productConfigError, setProductConfigError] = useState("");
  const [actionModal, setActionModal] = useState(null);
  const [actionForm, setActionForm] = useState({});
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    const loadOverview = async () => {
      setIsLoadingOverview(true);
      setOverviewError("");

      try {
        const [overviewData, plansData, productConfiguration] = await Promise.all([
          superAdminOverviewRequest(),
          superAdminListPlansRequest(),
          superAdminProductConfigurationRequest(),
        ]);
        setOverview(normalizeOverview(overviewData));
        setPlans(asArray(plansData));
        setProductConfig(normalizeProductConfig(productConfiguration));
      } catch (error) {
        setOverviewError(error.response?.data?.message || "Unable to load platform overview");
      } finally {
        setIsLoadingOverview(false);
      }
    };

    loadOverview();
  }, []);

  useEffect(() => {
    const loadBusinesses = async () => {
      setIsLoadingBusinesses(true);
      setBusinessError("");

      try {
        const data = await superAdminBusinessesRequest({
          page: query.page,
          limit: 10,
          planCode: query.planCode || undefined,
          isDisabled: query.isDisabled || undefined,
          search: query.search || undefined,
          sortBy: "createdAt",
          sortOrder: "desc",
        });

        setBusinesses(asArray(data.items));
        setPagination(
          data.pagination || { page: 1, limit: 10, total: 0, totalPages: 1 }
        );
        setPlanSelections((current) => {
          const nextState = { ...current };
          asArray(data.items).forEach((business) => {
            nextState[business.id] = current[business.id] || business.planCode;
          });
          return nextState;
        });
      } catch (error) {
        setBusinessError(error.response?.data?.message || "Unable to load businesses");
      } finally {
        setIsLoadingBusinesses(false);
      }
    };

    loadBusinesses();
  }, [query]);

  const metrics = useMemo(() => {
    const metrics = overview?.metrics || {};
    const pendingRequests = Number(metrics.pendingModuleRequests || 0);
    const pendingPayments = Number(metrics.pendingCommercialPayments || 0);

    return [
      {
        label: "Total Businesses",
        value: `${metrics.totalBusinesses}`,
        change: "All onboarded tenants",
      },
      {
        label: "Active Businesses",
        value: `${metrics.activeBusinesses}`,
        change: "Enabled tenant workspaces",
      },
      {
        label: "Trials",
        value: `${metrics.trialUsers}`,
        change: "Businesses on Free plan",
      },
      {
        label: "Paid Subscriptions",
        value: `${metrics.activeSubscriptions || metrics.paidBusinesses}`,
        change: "Active paid subscription records",
      },
      {
        label: "Monthly Revenue",
        value: formatCurrency(metrics.monthlyRecurringRevenue),
        change: "Estimated monthly recurring revenue",
      },
      {
        label: "Pending Requests",
        value: `${pendingRequests + pendingPayments}`,
        change: `${pendingRequests} requests · ${pendingPayments} payments`,
      },
    ];
  }, [businesses, overview, productConfig]);

  const refreshAll = async () => {
    setSuccessMessage("");
    setOverviewError("");
    setBusinessError("");

    try {
      const [overviewData, businessData, productConfiguration] = await Promise.all([
        superAdminOverviewRequest(),
        superAdminBusinessesRequest({
          page: query.page,
          limit: 10,
          planCode: query.planCode || undefined,
          isDisabled: query.isDisabled || undefined,
          search: query.search || undefined,
          sortBy: "createdAt",
          sortOrder: "desc",
        }),
        superAdminProductConfigurationRequest(),
      ]);

      setOverview(normalizeOverview(overviewData));
      setProductConfig(normalizeProductConfig(productConfiguration));
      setBusinesses(asArray(businessData.items));
      setPagination(
        businessData.pagination || { page: 1, limit: 10, total: 0, totalPages: 1 }
      );
    } catch (error) {
      const message = error.response?.data?.message || "Unable to refresh platform data";
      setOverviewError(message);
      setBusinessError(message);
    }
  };

  const handleReviewModuleRequest = async (requestId, status) => {
    const actionKey = `request:${requestId}:${status}`;
    if (busyAction) return;
    setBusyAction(actionKey);
    setProductConfigError("");
    try {
      await superAdminReviewModuleRequest(requestId, { status });
      const productConfiguration = await superAdminProductConfigurationRequest();
      setProductConfig(normalizeProductConfig(productConfiguration));
    } catch (error) {
      setProductConfigError(error.response?.data?.message || "Unable to review module request");
    } finally {
      setBusyAction("");
    }
  };

  const refreshProductConfiguration = async () => {
    const productConfiguration = await superAdminProductConfigurationRequest();
    setProductConfig(normalizeProductConfig(productConfiguration));
  };

  const handleSyncCommercialCatalogue = async () => {
    if (busyAction) return;
    setBusyAction("sync-catalogue");
    setProductConfigError("");
    try {
      await superAdminSyncCommercialCatalogueRequest();
      await refreshProductConfiguration();
    } catch (error) {
      setProductConfigError(error.response?.data?.message || "Unable to sync commercial catalogue");
    } finally {
      setBusyAction("");
    }
  };

  const handleCommercialPriceUpdate = async (module) => {
    if (busyAction) return;
    setProductConfigError("");
    setActionModal({ type: "module-price", module });
    setActionForm({
      defaultPrice: module.defaultPrice ?? 0,
      gstRate: module.gstRate ?? 18,
      gstApplicable: module.gstApplicable !== false,
      active: module.active !== false,
    });
  };

  const handleCommercialPlanUpdate = async (plan) => {
    if (busyAction) return;
    setProductConfigError("");
    setActionModal({ type: "commercial-plan", plan });
    setActionForm({
      monthlyPrice: plan.monthlyPrice ?? 0,
      yearlyPrice: plan.yearlyPrice ?? 0,
      monthlyInvoices: plan.limits?.monthlyInvoices ?? "",
      users: plan.limits?.users ?? "",
      whatsappQuota: plan.limits?.whatsappQuota ?? "",
      active: plan.active !== false,
      publicVisible: plan.publicVisible !== false,
    });
  };

  const handleCreateOffer = async (request) => {
    if (busyAction) return;
    setProductConfigError("");
    const commercialModule = productConfig.commercialModules.find((item) => item.moduleKey === request.moduleKey);
    setActionModal({ type: "offer", request });
    setActionForm({
      negotiatedPrice: commercialModule?.defaultPrice ?? "",
      validUntil: "",
      adminNote: "Commercial offer created from Super Admin",
    });
  };

  const submitActionModal = async () => {
    if (!actionModal || busyAction) return;
    const actionKey =
      actionModal.type === "module-price"
        ? `module-price:${actionModal.module.moduleKey}`
        : actionModal.type === "commercial-plan"
          ? `commercial-plan:${actionModal.plan.code}`
          : `offer:${actionModal.request._id}`;
    setBusyAction(actionKey);
    setProductConfigError("");
    try {
      if (actionModal.type === "module-price") {
        const module = actionModal.module;
        await superAdminUpdateCommercialModuleRequest(module.moduleKey, {
          defaultPrice: Number(actionForm.defaultPrice || 0),
          commercialType: module.commercialType,
          pricingType: module.pricingType,
          gstApplicable: Boolean(actionForm.gstApplicable),
          gstRate: Number(actionForm.gstRate || 0),
          active: Boolean(actionForm.active),
        });
      } else if (actionModal.type === "commercial-plan") {
        const plan = actionModal.plan;
        await superAdminUpdateCommercialPlanRequest(plan.code, {
          monthlyPrice: Number(actionForm.monthlyPrice || 0),
          yearlyPrice: Number(actionForm.yearlyPrice || 0),
          limits: {
            ...plan.limits,
            monthlyInvoices: actionForm.monthlyInvoices === "" ? plan.limits?.monthlyInvoices : Number(actionForm.monthlyInvoices),
            users: actionForm.users === "" ? plan.limits?.users : Number(actionForm.users),
            whatsappQuota: actionForm.whatsappQuota === "" ? plan.limits?.whatsappQuota : Number(actionForm.whatsappQuota),
          },
          active: Boolean(actionForm.active),
          publicVisible: Boolean(actionForm.publicVisible),
        });
      } else if (actionModal.type === "offer") {
        await superAdminCreateModuleOfferRequest({
          moduleRequestId: actionModal.request._id,
          negotiatedPrice: actionForm.negotiatedPrice === "" ? undefined : Number(actionForm.negotiatedPrice),
          adminNote: actionForm.adminNote || "Commercial offer created from Super Admin",
          validUntil: actionForm.validUntil || undefined,
        });
      }
      setActionModal(null);
      setActionForm({});
      await refreshProductConfiguration();
    } catch (error) {
      setProductConfigError(error.response?.data?.message || "Unable to complete action");
    } finally {
      setBusyAction("");
    }
  };

  const executeReviewCommercialOrder = async (orderId, status) => {
    const actionKey = `order:${orderId}:${status}`;
    if (busyAction) return;
    setProductConfigError("");
    try {
      setBusyAction(actionKey);
      await superAdminReviewCommercialOrderRequest(orderId, { status });
      await refreshProductConfiguration();
    } catch (error) {
      setProductConfigError(error.response?.data?.message || "Unable to review commercial payment");
    } finally {
      setBusyAction("");
    }
  };

  const handleReviewCommercialOrder = async (orderId, status) => {
    if (status !== "PAID") {
      await executeReviewCommercialOrder(orderId, status);
      return;
    }
    setConfirmDialog({
      title: "Verify commercial payment?",
      message: "This marks the payment as paid and activates the purchased module through the controlled commercial workflow.",
      confirmLabel: "Verify and activate",
      tone: "success",
      onConfirm: () => executeReviewCommercialOrder(orderId, status),
    });
  };

  const handleSearchSubmit = (event) => {
    event.preventDefault();
    setQuery((current) => ({
      ...current,
      page: 1,
      search: searchInput.trim(),
    }));
  };

  const executeToggleBusiness = async (businessId) => {
    if (busyBusinessId) return;
    setBusyBusinessId(businessId);
    setBusinessError("");
    setSuccessMessage("");

    try {
      const updatedBusiness = await superAdminToggleBusinessStatusRequest(businessId);
      setBusinesses((current) =>
        current.map((business) => (business.id === businessId ? updatedBusiness : business))
      );
      setSuccessMessage(
        `Business ${updatedBusiness.isDisabled ? "disabled" : "enabled"} successfully.`
      );
      uiStore.getState().pushToast({
        tone: "success",
        message: `Business ${updatedBusiness.isDisabled ? "disabled" : "enabled"} successfully.`,
      });
      await refreshAll();
    } catch (error) {
      setBusinessError(error.response?.data?.message || "Unable to update business status");
    } finally {
      setBusyBusinessId("");
    }
  };

  const handleToggleBusiness = async (businessId) => {
    const business = businesses.find((item) => item.id === businessId);
    if (business && !business.isDisabled) {
      setConfirmDialog({
        title: `Disable ${business.name}?`,
        message: "This will block tenant access until a super admin enables the business again.",
        confirmLabel: "Disable business",
        tone: "danger",
        onConfirm: () => executeToggleBusiness(businessId),
      });
      return;
    }
    await executeToggleBusiness(businessId);
  };

  const handlePlanUpdate = async (businessId) => {
    if (busyBusinessId) return;
    setBusyBusinessId(businessId);
    setBusinessError("");
    setSuccessMessage("");

    try {
      const updatedBusiness = await superAdminUpdateBusinessPlanRequest(
        businessId,
        planSelections[businessId]
      );
      setBusinesses((current) =>
        current.map((business) => (business.id === businessId ? updatedBusiness : business))
      );
      setSuccessMessage(`Plan updated to ${updatedBusiness.plan?.name || updatedBusiness.planCode || "selected plan"}.`);
      uiStore.getState().pushToast({
        tone: "success",
        message: `Plan updated to ${updatedBusiness.plan?.name || updatedBusiness.planCode || "selected plan"}.`,
      });
      await refreshAll();
    } catch (error) {
      setBusinessError(error.response?.data?.message || "Unable to update business plan");
    } finally {
      setBusyBusinessId("");
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-[2rem] border border-white/10 bg-slate-900/90 p-6 shadow-2xl shadow-slate-950/30 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.32em] text-brand-200">SUPER ADMIN</p>
              <h1 className="mt-3 text-3xl font-semibold sm:text-4xl">BillStack Platform Control Center</h1>
              <p className="mt-3 max-w-3xl text-sm text-slate-200">
                Manage businesses, subscriptions, modules, commercial requests and platform health.
              </p>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/[.04] p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Logged in admin</p>
              <p className="mt-2 font-semibold text-white">{email}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={refreshAll}
                  className="rounded-2xl border border-white/10 px-4 py-2 text-sm"
                >
                  Refresh data
                </button>
                <button
                  type="button"
                  onClick={clearSession}
                  className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </section>

        <CreateWorkspacePanel onCreated={refreshAll} />

        {overviewError ? <p className="text-sm text-rose-300">{overviewError}</p> : null}
        {successMessage ? <p className="text-sm text-emerald-300">{successMessage}</p> : null}

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {isLoadingOverview
            ? Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-32 animate-pulse rounded-3xl border border-white/10 bg-white/5" />
              ))
            : metrics.length
              ? metrics.map((metric) => <MetricCard key={metric.label} {...metric} />)
              : <EmptyState title="No platform metrics available" description="The API returned no metric payload. Try refreshing the dashboard." />}
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Revenue analytics</h2>
                <p className="mt-1 text-sm text-slate-400">
                  Subscription-linked monthly revenue across paid plans.
                </p>
              </div>
            </div>
            <div className="mt-4 h-72">
              {isLoadingOverview ? (
                <LoadingState title="Loading analytics" description="Preparing subscription revenue trends." />
              ) : overviewError ? (
                <ErrorState title="Unable to load analytics" description={overviewError} />
              ) : overview?.revenueChart?.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={overview?.revenueChart || []}>
                    <defs>
                      <linearGradient id="platformRevenueFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                    <XAxis dataKey="month" stroke="#94a3b8" />
                    <YAxis stroke="#94a3b8" />
                    <Tooltip />
                    <Area
                      type="monotone"
                      dataKey="revenue"
                      stroke="#38bdf8"
                      fill="url(#platformRevenueFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState title="No revenue analytics yet" description="Paid subscriptions will populate this chart." />
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <h2 className="text-lg font-semibold text-white">Plan catalog</h2>
            <p className="mt-1 text-sm text-slate-400">
              Assign these plans to businesses from the management table below.
            </p>
            <div className="mt-4 space-y-3">
              {plans.length ? plans.map((plan) => (
                <div key={plan.code} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-base font-semibold text-white">{plan.name}</p>
                    <span className="rounded-full bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-300">
                      {plan.code}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-slate-300">
                    <p>
                      Invoice limit:{" "}
                      {plan.invoiceMonthlyLimit === Number.MAX_SAFE_INTEGER
                        ? "Unlimited"
                        : `${plan.invoiceMonthlyLimit} / month`}
                    </p>
                    <p>Staff limit: {plan.staffUserLimit}</p>
                    <p>Inventory: {planFeatureLabel(plan.inventoryAccess)}</p>
                    <p>Reports: {planFeatureLabel(plan.reportsAccess)}</p>
                    <p>PDF templates: {planFeatureLabel(plan.pdfTemplatesAccess)}</p>
                    <p>Sharing: {planFeatureLabel(plan.sharingAccess)}</p>
                  </div>
                </div>
              )) : <EmptyState title="No plans available" description="Plan catalogue is empty or unavailable." />}
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Product Configuration</h2>
              <p className="mt-1 text-sm text-slate-400">
                Review module catalogue, business presets, and module/add-on requests without direct database overrides.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleSyncCommercialCatalogue} disabled={busyAction === "sync-catalogue"} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-50">
                {busyAction === "sync-catalogue" ? "Syncing..." : "Sync catalogue"}
              </button>
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-300">
                {productConfig.modules.length} modules
              </span>
            </div>
          </div>
          {productConfigError ? <p className="mt-4 text-sm text-rose-300">{productConfigError}</p> : null}
          <div className="mt-5 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
              <p className="text-sm font-semibold text-white">Module catalogue</p>
              <div className="mt-3 grid max-h-80 gap-2 overflow-y-auto pr-1">
                {productConfig.modules.length ? productConfig.modules.map((module) => (
                  <div key={module.key} className="rounded-xl border border-white/10 bg-white/[.03] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-white">{module.name}</p>
                      <StatusBadge>{module.status}</StatusBadge>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{module.key} · {module.category}</p>
                    <p className="mt-1 text-xs text-slate-500">{module.description}</p>
                  </div>
                )) : <p className="text-sm text-slate-400">No module catalogue entries returned.</p>}
              </div>
            </div>
            <div className="space-y-4">
              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-sm font-semibold text-white">Commercial catalogue</p>
                <div className="mt-3 space-y-2">
                  {productConfig.commercialModules.length ? productConfig.commercialModules.map((module) => (
                    <div key={module._id || module.moduleKey} className="rounded-xl border border-white/10 bg-white/[.03] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-white">{module.displayName}</p>
                          <p className="mt-1 text-xs text-slate-400">{module.moduleKey} · {module.commercialType} · {module.pricingType}</p>
                        </div>
                        <button type="button" onClick={() => handleCommercialPriceUpdate(module)} disabled={busyAction === `module-price:${module.moduleKey}`} className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-50">
                          {busyAction === `module-price:${module.moduleKey}` ? "Saving..." : "Edit price"}
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-slate-300">
                        Standard {formatCurrency(module.defaultPrice)} {module.gstApplicable ? `+ GST ${module.gstRate}%` : "· no GST"} · {module.active ? "Active" : "Hidden"}
                      </p>
                    </div>
                  )) : <p className="text-sm text-slate-400">Commercial catalogue is not synced yet.</p>}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-sm font-semibold text-white">Commercial plans</p>
                <p className="mt-1 text-xs text-slate-400">
                  Backend-authoritative prices and limits used by customer subscription screens.
                </p>
                <div className="mt-3 space-y-2">
                  {productConfig.commercialPlans.length ? productConfig.commercialPlans.map((plan) => (
                    <div key={plan._id || plan.code} className="rounded-xl border border-white/10 bg-white/[.03] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-white">{plan.name}</p>
                          <p className="mt-1 text-xs text-slate-400">
                            {plan.code} · {formatCurrency(plan.monthlyPrice)}/mo · {formatCurrency(plan.yearlyPrice)}/yr
                          </p>
                        </div>
                        <button type="button" onClick={() => handleCommercialPlanUpdate(plan)} disabled={busyAction === `commercial-plan:${plan.code}`} className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-50">
                          {busyAction === `commercial-plan:${plan.code}` ? "Saving..." : "Edit plan"}
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-slate-300">
                        Invoices {formatLimit(plan.limits?.monthlyInvoices)} · Users {formatLimit(plan.limits?.users)} · WhatsApp {formatLimit(plan.limits?.whatsappQuota)} · {plan.active ? "Active" : "Hidden"}
                      </p>
                    </div>
                  )) : <p className="text-sm text-slate-400">Commercial plans are not synced yet.</p>}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-sm font-semibold text-white">Presets</p>
                <div className="mt-3 space-y-2">
                  {productConfig.presets.length ? productConfig.presets.map((preset) => (
                    <p key={preset.key} className="rounded-xl bg-white/[.03] p-3 text-xs text-slate-300">
                      <span className="font-semibold text-white">{preset.key}</span> · {asArray(preset.moduleKeys).join(", ") || "custom selection"}
                    </p>
                  )) : <p className="text-sm text-slate-400">No presets returned.</p>}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-sm font-semibold text-white">Module Requests</p>
                <div className="mt-3 space-y-2">
                  {productConfig.requests.length ? productConfig.requests.map((request) => (
                    <div key={request._id} className="rounded-xl border border-white/10 bg-white/[.03] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-white">{request.businessId?.name || "Business"}</p>
                          <p className="mt-1 text-xs text-slate-400">{getModuleDisplayName(request.moduleKey, productConfig)} · {request.requestType || "MODULE"} · {safeDate(request.createdAt)}</p>
                        </div>
                        <StatusBadge>{request.status}</StatusBadge>
                      </div>
                      {request.message ? <p className="mt-1 text-xs text-slate-500">{request.message}</p> : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {["PENDING", "UNDER_REVIEW", "APPROVED"].includes(request.status) ? <button type="button" onClick={() => handleCreateOffer(request)} disabled={busyAction === `offer:${request._id}`} className="rounded-xl bg-brand-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busyAction === `offer:${request._id}` ? "Creating..." : "Create offer"}</button> : null}
                        {request.status === "PENDING" ? <button type="button" onClick={() => handleReviewModuleRequest(request._id, "UNDER_REVIEW")} disabled={busyAction === `request:${request._id}:UNDER_REVIEW`} className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-200 disabled:opacity-50">Review</button> : null}
                        {["PENDING", "UNDER_REVIEW"].includes(request.status) ? <button type="button" onClick={() => handleReviewModuleRequest(request._id, "APPROVED")} disabled={busyAction === `request:${request._id}:APPROVED`} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Approve</button> : null}
                        {["PENDING", "UNDER_REVIEW"].includes(request.status) ? <button type="button" onClick={() => handleReviewModuleRequest(request._id, "REJECTED")} disabled={busyAction === `request:${request._id}:REJECTED`} className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Reject</button> : null}
                      </div>
                    </div>
                  )) : <p className="text-sm text-slate-400">No module requests yet.</p>}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-sm font-semibold text-white">Commercial Offers</p>
                <div className="mt-3 space-y-2">
                  {productConfig.offers.length ? productConfig.offers.map((offer) => (
                    <div key={offer._id} className="rounded-xl border border-white/10 bg-white/[.03] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-white">{offer.businessId?.name || "Business"}</p>
                          <p className="mt-1 text-xs text-slate-400">{getModuleDisplayName(offer.moduleKey, productConfig)} · {formatCurrency(offer.finalAmount)} · Valid {safeDate(offer.validUntil)}</p>
                        </div>
                        <StatusBadge>{offer.status}</StatusBadge>
                      </div>
                    </div>
                  )) : <p className="text-sm text-slate-400">No commercial offers yet.</p>}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-sm font-semibold text-white">Commercial Payments</p>
                <div className="mt-3 space-y-2">
                  {productConfig.orders.length ? productConfig.orders.map((order) => (
                    <div key={order._id} className="rounded-xl border border-white/10 bg-white/[.03] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-white">{order.businessId?.name || "Business"}</p>
                          <p className="mt-1 text-xs text-slate-400">{getModuleDisplayName(order.moduleKey, productConfig)} · {formatCurrency(order.totalAmount)} · {order.paymentMethod} · Submitted {safeDate(order.createdAt)}</p>
                          <p className="mt-1 text-xs text-slate-500">Activation: {order.activationStatus || "PENDING"}</p>
                        </div>
                        <StatusBadge>{order.paymentStatus}</StatusBadge>
                      </div>
                      {order.utrReference ? <p className="mt-1 text-xs text-slate-500">UTR: {order.utrReference}</p> : null}
                      {order.paymentStatus === "AWAITING_VERIFICATION" ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" onClick={() => handleReviewCommercialOrder(order._id, "PAID")} disabled={busyAction === `order:${order._id}:PAID`} className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Verify Payment</button>
                          <button type="button" onClick={() => handleReviewCommercialOrder(order._id, "REJECTED")} disabled={busyAction === `order:${order._id}:REJECTED`} className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">Reject Payment</button>
                        </div>
                      ) : null}
                    </div>
                  )) : <p className="text-sm text-slate-400">No commercial payments yet.</p>}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">Businesses</h2>
              <p className="mt-1 text-sm text-slate-400">
                View status, switch plans, and disable or enable tenant access.
              </p>
            </div>

            <form onSubmit={handleSearchSubmit} className="flex flex-col gap-3 sm:flex-row">
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search name or email"
                className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-brand-500"
              />
              <select
                value={query.planCode}
                onChange={(event) =>
                  setQuery((current) => ({
                    ...current,
                    page: 1,
                    planCode: event.target.value,
                  }))
                }
                className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none"
              >
                <option value="">All plans</option>
                {plans.map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name}
                  </option>
                ))}
              </select>
              <select
                value={query.isDisabled}
                onChange={(event) =>
                  setQuery((current) => ({
                    ...current,
                    page: 1,
                    isDisabled: event.target.value,
                  }))
                }
                className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none"
              >
                <option value="">All status</option>
                <option value="false">Enabled</option>
                <option value="true">Disabled</option>
              </select>
              <button
                type="submit"
                className="rounded-2xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white"
              >
                Search
              </button>
            </form>
          </div>

          {businessError ? <p className="mt-4 text-sm text-rose-300">{businessError}</p> : null}

          <div className="mt-6 overflow-x-auto">
            <table className="min-w-full text-left text-sm text-slate-300">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-[0.2em] text-slate-400">
                  <th className="pb-3 pr-4">Business</th>
                  <th className="pb-3 pr-4">Owner</th>
                  <th className="pb-3 pr-4">Deployment</th>
                  <th className="pb-3 pr-4">Status</th>
                  <th className="pb-3 pr-4">Subscription</th>
                  <th className="pb-3 pr-4">Created</th>
                  <th className="pb-3 pr-4">Plan</th>
                  <th className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingBusinesses ? (
                  <tr>
                    <td colSpan="8" className="py-8 text-center text-slate-400">
                      Loading businesses...
                    </td>
                  </tr>
                ) : businesses.length ? (
                  businesses.map((business) => (
                    <tr key={business.id} className="border-b border-white/5 align-top">
                      <td className="py-4 pr-4">
                        <p className="font-semibold text-white">{business.name}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {business.billingEmail || business.email || "No billing email"}
                        </p>
                      </td>
                      <td className="py-4 pr-4 text-xs text-slate-400">{business.email || business.billingEmail || "No owner email"}</td>
                      <td className="py-4 pr-4"><StatusBadge>{business.deploymentMode || "SAAS"}</StatusBadge></td>
                      <td className="py-4 pr-4">
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                            business.isDisabled
                              ? "bg-rose-500/15 text-rose-200"
                              : "bg-emerald-500/15 text-emerald-200"
                          }`}
                        >
                          {business.isDisabled ? "Disabled" : "Enabled"}
                        </span>
                      </td>
                      <td className="py-4 pr-4">
                        <StatusBadge>{business.subscription?.status || "inactive"}</StatusBadge>
                        <p className="mt-1 text-xs text-slate-400">
                          {business.subscription?.currentEnd
                            ? `Ends ${new Date(business.subscription.currentEnd).toLocaleDateString()}`
                            : "No paid cycle"}
                        </p>
                      </td>
                      <td className="py-4 pr-4 text-xs text-slate-400">
                        {safeDate(business.createdAt)}
                      </td>
                      <td className="py-4 pr-4">
                        <select
                          value={planSelections[business.id] || business.planCode}
                          onChange={(event) =>
                            setPlanSelections((current) => ({
                              ...current,
                              [business.id]: event.target.value,
                            }))
                          }
                          className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white outline-none"
                        >
                          {plans.length ? plans.map((plan) => (
                            <option key={plan.code} value={plan.code}>
                              {plan.name}
                            </option>
                          )) : <option value={business.planCode || "free"}>{business.planCode || "free"}</option>}
                        </select>
                      </td>
                      <td className="py-4">
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => handlePlanUpdate(business.id)}
                            disabled={busyBusinessId === business.id}
                            className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
                          >
                            Change Plan
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleBusiness(business.id)}
                            disabled={busyBusinessId === business.id}
                            className={`rounded-2xl px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 ${
                              business.isDisabled ? "bg-emerald-600" : "bg-rose-600"
                            }`}
                          >
                            {business.isDisabled ? "Enable" : "Disable"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan="8" className="py-8 text-center text-slate-400">
                      No businesses match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex flex-col gap-3 border-t border-white/10 pt-4 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Showing page {pagination.page} of {pagination.totalPages} with {pagination.total} businesses total.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={pagination.page <= 1}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    page: current.page - 1,
                  }))
                }
                className="rounded-2xl border border-white/10 px-4 py-2 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    page: current.page + 1,
                  }))
                }
                className="rounded-2xl border border-white/10 px-4 py-2 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </section>
      </div>
      {actionModal ? (
        <AdminActionModal
          modal={actionModal}
          form={actionForm}
          productConfig={productConfig}
          isSaving={Boolean(busyAction)}
          onChange={(field, value) => setActionForm((current) => ({ ...current, [field]: value }))}
          onClose={() => {
            if (!busyAction) {
              setActionModal(null);
              setActionForm({});
            }
          }}
          onSubmit={submitActionModal}
        />
      ) : null}
      {confirmDialog ? (
        <ConfirmDialog
          dialog={confirmDialog}
          isSaving={Boolean(busyAction || busyBusinessId)}
          onCancel={() => setConfirmDialog(null)}
          onConfirm={async () => {
            const action = confirmDialog.onConfirm;
            setConfirmDialog(null);
            await action();
          }}
        />
      ) : null}
    </div>
  );
};

const AdminActionModal = ({ modal, form, productConfig, isSaving, onChange, onClose, onSubmit }) => {
  const title =
    modal.type === "module-price"
      ? `Edit ${modal.module.displayName || modal.module.moduleKey}`
      : modal.type === "commercial-plan"
        ? `Edit ${modal.plan.name}`
        : `Create offer for ${getModuleDisplayName(modal.request.moduleKey, productConfig)}`;
  const description =
    modal.type === "module-price"
      ? "Update the commercial catalogue entry used for future module offers."
      : modal.type === "commercial-plan"
        ? "Update the public plan catalogue values shown to tenants."
        : "Create a controlled add-on offer. Backend pricing and activation rules remain authoritative.";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[2rem] border border-white/10 bg-slate-900 p-6 shadow-2xl shadow-black/40">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-brand-200">Super Admin</p>
            <h3 className="mt-2 text-2xl font-semibold text-white">{title}</h3>
            <p className="mt-2 text-sm text-slate-400">{description}</p>
          </div>
          <button type="button" onClick={onClose} disabled={isSaving} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-300 disabled:opacity-50">
            Close
          </button>
        </div>

        <div className="mt-6 grid gap-4">
          {modal.type === "module-price" ? (
            <>
              <label>
                <span className="mb-2 block text-sm font-medium text-slate-200">Standard price</span>
                <input type="number" min="0" step="0.01" value={form.defaultPrice} onChange={(event) => onChange("defaultPrice", event.target.value)} className={modalInputClass} />
              </label>
              <label>
                <span className="mb-2 block text-sm font-medium text-slate-200">GST rate</span>
                <input type="number" min="0" step="0.01" value={form.gstRate} onChange={(event) => onChange("gstRate", event.target.value)} className={modalInputClass} />
              </label>
              <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-200">
                <input type="checkbox" checked={Boolean(form.gstApplicable)} onChange={(event) => onChange("gstApplicable", event.target.checked)} />
                GST applicable
              </label>
              <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-200">
                <input type="checkbox" checked={Boolean(form.active)} onChange={(event) => onChange("active", event.target.checked)} />
                Catalogue active
              </label>
            </>
          ) : null}

          {modal.type === "commercial-plan" ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <label>
                  <span className="mb-2 block text-sm font-medium text-slate-200">Monthly price</span>
                  <input type="number" min="0" step="0.01" value={form.monthlyPrice} onChange={(event) => onChange("monthlyPrice", event.target.value)} className={modalInputClass} />
                </label>
                <label>
                  <span className="mb-2 block text-sm font-medium text-slate-200">Yearly price</span>
                  <input type="number" min="0" step="0.01" value={form.yearlyPrice} onChange={(event) => onChange("yearlyPrice", event.target.value)} className={modalInputClass} />
                </label>
                <label>
                  <span className="mb-2 block text-sm font-medium text-slate-200">Monthly invoice limit</span>
                  <input type="number" min="0" value={form.monthlyInvoices} onChange={(event) => onChange("monthlyInvoices", event.target.value)} className={modalInputClass} />
                </label>
                <label>
                  <span className="mb-2 block text-sm font-medium text-slate-200">User limit</span>
                  <input type="number" min="0" value={form.users} onChange={(event) => onChange("users", event.target.value)} className={modalInputClass} />
                </label>
                <label>
                  <span className="mb-2 block text-sm font-medium text-slate-200">WhatsApp quota</span>
                  <input type="number" min="0" value={form.whatsappQuota} onChange={(event) => onChange("whatsappQuota", event.target.value)} className={modalInputClass} />
                </label>
              </div>
              <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-200">
                <input type="checkbox" checked={Boolean(form.active)} onChange={(event) => onChange("active", event.target.checked)} />
                Plan active
              </label>
              <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-slate-200">
                <input type="checkbox" checked={Boolean(form.publicVisible)} onChange={(event) => onChange("publicVisible", event.target.checked)} />
                Publicly visible
              </label>
            </>
          ) : null}

          {modal.type === "offer" ? (
            <>
              <div className="rounded-2xl border border-white/10 bg-white/[.03] p-4 text-sm text-slate-300">
                <p>Business: <span className="font-semibold text-white">{modal.request.businessId?.name || "Business"}</span></p>
                <p className="mt-1">Module: <span className="font-semibold text-white">{getModuleDisplayName(modal.request.moduleKey, productConfig)}</span></p>
              </div>
              <label>
                <span className="mb-2 block text-sm font-medium text-slate-200">Offer base price</span>
                <input type="number" min="0" step="0.01" value={form.negotiatedPrice} onChange={(event) => onChange("negotiatedPrice", event.target.value)} className={modalInputClass} />
              </label>
              <label>
                <span className="mb-2 block text-sm font-medium text-slate-200">Valid until</span>
                <input type="date" value={form.validUntil} onChange={(event) => onChange("validUntil", event.target.value)} className={modalInputClass} />
              </label>
              <label>
                <span className="mb-2 block text-sm font-medium text-slate-200">Admin note</span>
                <textarea rows="3" value={form.adminNote} onChange={(event) => onChange("adminNote", event.target.value)} className={modalInputClass} />
              </label>
            </>
          ) : null}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={isSaving} className="rounded-2xl border border-white/10 px-5 py-3 text-sm font-semibold text-slate-200 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" onClick={onSubmit} disabled={isSaving} className="rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
            {isSaving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
};

const ConfirmDialog = ({ dialog, isSaving, onCancel, onConfirm }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
    <div className="w-full max-w-md rounded-[2rem] border border-white/10 bg-slate-900 p-6 shadow-2xl shadow-black/40">
      <h3 className="text-xl font-semibold text-white">{dialog.title}</h3>
      <p className="mt-3 text-sm text-slate-300">{dialog.message}</p>
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={onCancel} disabled={isSaving} className="rounded-2xl border border-white/10 px-5 py-3 text-sm font-semibold text-slate-200 disabled:opacity-50">
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isSaving}
          className={`rounded-2xl px-5 py-3 text-sm font-semibold text-white disabled:opacity-50 ${dialog.tone === "danger" ? "bg-rose-600" : "bg-emerald-600"}`}
        >
          {isSaving ? "Working..." : dialog.confirmLabel || "Confirm"}
        </button>
      </div>
    </div>
  </div>
);

export default SuperAdminDashboardPage;
