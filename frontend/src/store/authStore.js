import { create } from "zustand";
import { clearHandoffRequests } from '../features/integrations/handoffRequest';

// The access token lives in memory only, never in localStorage, so a script injected into the
// page can't lift a saved one. The browser keeps only who is signed in (user, business); on a page
// load restoreSession() gets a fresh access token from the httpOnly refresh cookie.
const STORAGE_KEY = "billstack-auth";
const saveSession = ({ user, business }) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ signedIn: true, user, business }));
  } catch {
    /* storage unavailable */
  }
};

const persistedSession = (() => {
  if (typeof window === "undefined") {
    return null;
  }

  // A damaged or half-written saved session (or blocked storage) must not stop
  // the app from starting: forget it and show the sign-in page.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    // A session saved by an older version still carries the token: drop it from storage.
    if (parsed.accessToken) saveSession(parsed);
    return { signedIn: Boolean(parsed.signedIn || parsed.accessToken), user: parsed.user || null, business: parsed.business || null };
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    return null;
  }
})();

export const authStore = create((set) => ({
  accessToken: "",
  user: persistedSession?.user || null,
  business: persistedSession?.business || null,
  hasHydrated: true,
  setSession: (payload) => {
    const nextState = {
      accessToken: payload.accessToken,
      user: payload.user,
      business: payload.business,
    };

    saveSession(nextState);
    set(nextState);
  },
  updateBusiness: (business) => {
    set((state) => {
      const nextState = { ...state, business };
      saveSession(nextState);
      return nextState;
    });
  },
  clearAuth: () => {
    clearHandoffRequests();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    set({
      accessToken: "",
      user: null,
      business: null,
    });
  },
}));

// Called once before the app renders: someone was signed in on this browser, so swap the refresh
// cookie for a fresh access token. If that fails, the saved user is forgotten and the guards send
// them to the sign-in page.
export const restoreSession = async (refresh) => {
  if (!persistedSession?.signedIn) return;
  try {
    const data = await refresh(persistedSession.business?.id || persistedSession.business?._id);
    if (data?.accessToken) authStore.getState().setSession(data);
    else authStore.getState().clearAuth();
  } catch {
    authStore.getState().clearAuth();
  }
};
