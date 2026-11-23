import axios from "axios";
import { authStore } from "../store/authStore";
import { uiStore } from "../store/uiStore";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api",
  withCredentials: true,
});

// Swaps the httpOnly refresh cookie for a new access token (used on page load and after a 401).
export const refreshAccessToken = async (businessId) => {
  const response = await axios.post(
    `${api.defaults.baseURL}/auth/refresh`,
    {},
    { withCredentials: true, headers: businessId ? { "x-business-id": businessId } : {} }
  );
  return response.data.data;
};

let isRefreshing = false;
let queuedRequests = [];

const flushQueue = (error, token = null) => {
  queuedRequests.forEach((request) => {
    if (error) {
      request.reject(error);
      return;
    }

    request.resolve(token);
  });

  queuedRequests = [];
};

api.interceptors.request.use((config) => {
  const accessToken = authStore.getState().accessToken;
  const businessId = authStore.getState().business?.id;

  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }

  if (businessId && !config.headers["x-business-id"]) {
    config.headers["x-business-id"] = businessId;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const requestUrl = originalRequest?.url || "";
    const isAuthFlowRequest =
      requestUrl.includes("/auth/login") ||
      requestUrl.includes("/auth/register") ||
      requestUrl.includes("/auth/forgot-password") ||
      requestUrl.includes("/auth/reset-password") ||
      requestUrl.includes("/auth/logout") ||
      requestUrl.includes("/auth/refresh") ||
      requestUrl.includes("/super-admin/login");

    if (error.response?.status !== 401 || originalRequest?._retry || isAuthFlowRequest) {
      if (error.response?.status >= 500) {
        uiStore.getState().pushToast({
          tone: "error",
          title: "Server error",
          message: error.response?.data?.message || "Something went wrong on the server.",
        });
      }
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        queuedRequests.push({ resolve, reject });
      }).then((token) => {
        originalRequest.headers.Authorization = `Bearer ${token}`;
        return api(originalRequest);
      });
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const refreshed = await refreshAccessToken(originalRequest.headers["x-business-id"] || authStore.getState().business?.id);
      const nextToken = refreshed.accessToken;
      authStore.getState().setSession(refreshed);

      flushQueue(null, nextToken);
      originalRequest.headers.Authorization = `Bearer ${nextToken}`;
      return api(originalRequest);
    } catch (refreshError) {
      flushQueue(refreshError, null);
      authStore.getState().clearAuth();
      uiStore.getState().pushToast({
        tone: "error",
        title: "Session expired",
        message: "Please sign in again to continue.",
      });
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default api;
