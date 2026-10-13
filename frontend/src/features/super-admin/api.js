import axios from "axios";
import { superAdminStore } from "../../store/superAdminStore";
import { uiStore } from "../../store/uiStore";

const superAdminApi = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api",
});

const asArray = (value) => (Array.isArray(value) ? value : []);
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
const normalizeProductConfiguration = (value = {}) => ({
  modules: asArray(value?.modules),
  industries: asArray(value?.industries),
  capabilities: asArray(value?.capabilities),
  commercialModules: asArray(value?.commercialModules),
  commercialPlans: asArray(value?.commercialPlans),
  presets: asArray(value?.presets),
  requests: asArray(value?.requests),
  offers: asArray(value?.offers),
  orders: asArray(value?.orders),
});
const normalizeBusinesses = (value = {}) => ({
  items: asArray(value?.items),
  pagination: value?.pagination || { page: 1, limit: 10, total: 0, totalPages: 1 },
});

superAdminApi.interceptors.request.use((config) => {
  const accessToken = superAdminStore.getState().accessToken;

  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }

  return config;
});

superAdminApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      superAdminStore.getState().clearSession();
      uiStore.getState().pushToast({
        tone: "error",
        title: "Super admin session expired",
        message: "Please sign in again to continue.",
      });

      if (typeof window !== "undefined" && !window.location.pathname.includes("/super-admin/login")) {
        window.location.assign("/super-admin/login");
      }
    }

    return Promise.reject(error);
  }
);

export const superAdminLoginRequest = async (payload) => {
  const response = await superAdminApi.post("/super-admin/login", payload);
  return response.data.data;
};

export const superAdminOverviewRequest = async () => {
  const response = await superAdminApi.get("/super-admin/overview");
  return normalizeOverview(response.data.data);
};

export const superAdminBusinessesRequest = async (params) => {
  const response = await superAdminApi.get("/super-admin/businesses", { params });
  return normalizeBusinesses(response.data.data);
};

export const superAdminToggleBusinessStatusRequest = async (businessId) => {
  const response = await superAdminApi.post(`/super-admin/businesses/${businessId}/toggle-status`);
  return response.data.data;
};

export const superAdminUpdateBusinessPlanRequest = async (businessId, planCode) => {
  const response = await superAdminApi.post(`/super-admin/businesses/${businessId}/plan`, {
    planCode,
  });
  return response.data.data;
};

export const superAdminListPlansRequest = async () => {
  const response = await superAdminApi.get("/plans");
  return response.data.data;
};

export const superAdminProductConfigurationRequest = async () => {
  const response = await superAdminApi.get("/super-admin/product-configuration");
  return normalizeProductConfiguration(response.data.data);
};

export const superAdminReviewModuleRequest = async (requestId, payload) => {
  const response = await superAdminApi.post(`/super-admin/module-requests/${requestId}/review`, payload);
  return response.data.data;
};

export const superAdminSyncCommercialCatalogueRequest = async () => {
  const response = await superAdminApi.post("/super-admin/product-configuration/sync");
  return response.data.data;
};

export const superAdminUpdateCommercialModuleRequest = async (moduleKey, payload) => {
  const response = await superAdminApi.put(`/super-admin/commercial-modules/${moduleKey}`, payload);
  return response.data.data;
};

export const superAdminUpdateCommercialPlanRequest = async (planCode, payload) => {
  const response = await superAdminApi.put(`/super-admin/commercial-plans/${planCode}`, payload);
  return response.data.data;
};

export const superAdminCreateModuleOfferRequest = async (payload) => {
  const response = await superAdminApi.post("/super-admin/module-offers", payload);
  return response.data.data;
};

export const superAdminReviewCommercialOrderRequest = async (orderId, payload) => {
  const response = await superAdminApi.post(`/super-admin/commercial-orders/${orderId}/review`, payload);
  return response.data.data;
};

// Creates a separate, empty workspace (company) with its own owner login.
export const superAdminCreateWorkspaceRequest = async (payload) => {
  const response = await superAdminApi.post("/super-admin/businesses", payload);
  return response.data.data;
};
