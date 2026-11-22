import { create } from "zustand";
import { clearHandoffRequests } from '../features/integrations/handoffRequest';

const persistedSession = (() => {
  if (typeof window === "undefined") {
    return null;
  }

  // A damaged or half-written saved session (or blocked storage) must not stop
  // the app from starting: forget it and show the sign-in page.
  try {
    const raw = localStorage.getItem("billstack-auth");
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    try {
      localStorage.removeItem("billstack-auth");
    } catch {
      /* storage unavailable */
    }
    return null;
  }
})();

export const authStore = create((set) => ({
  accessToken: persistedSession?.accessToken || "",
  user: persistedSession?.user || null,
  business: persistedSession?.business || null,
  hasHydrated: true,
  setSession: (payload) => {
    const nextState = {
      accessToken: payload.accessToken,
      user: payload.user,
      business: payload.business,
    };

    localStorage.setItem("billstack-auth", JSON.stringify(nextState));
    set(nextState);
  },
  updateBusiness: (business) => {
    set((state) => {
      const nextState = { ...state, business };
      localStorage.setItem(
        "billstack-auth",
        JSON.stringify({
          accessToken: nextState.accessToken,
          user: nextState.user,
          business: nextState.business,
        })
      );
      return nextState;
    });
  },
  clearAuth: () => {
    clearHandoffRequests();
    localStorage.removeItem("billstack-auth");
    set({
      accessToken: "",
      user: null,
      business: null,
    });
  },
}));
