import { create } from "zustand";

const persistedSession = (() => {
  if (typeof window === "undefined") {
    return null;
  }

  // A damaged or half-written saved session (or blocked storage) must not stop
  // the app from starting: forget it and show the sign-in page.
  try {
    const raw = localStorage.getItem("billstack-super-admin");
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    try {
      localStorage.removeItem("billstack-super-admin");
    } catch {
      /* storage unavailable */
    }
    return null;
  }
})();

export const superAdminStore = create((set) => ({
  accessToken: persistedSession?.accessToken || "",
  email: persistedSession?.email || "",
  hasHydrated: true,
  setSession: (payload) => {
    const nextState = {
      accessToken: payload.accessToken,
      email: payload.email,
    };

    localStorage.setItem("billstack-super-admin", JSON.stringify(nextState));
    set(nextState);
  },
  clearSession: () => {
    localStorage.removeItem("billstack-super-admin");
    set({
      accessToken: "",
      email: "",
    });
  },
}));
