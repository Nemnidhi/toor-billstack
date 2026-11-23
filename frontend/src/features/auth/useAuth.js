import { useNavigate } from "react-router-dom";
import {
  currentSessionRequest,
  googleAuthRequest,
  loginRequest,
  loginTwoFactorRequest,
  logoutRequest,
  registerRequest,
} from "./api";
import { authStore } from "../../store/authStore";
import { uiStore } from "../../store/uiStore";

export const useAuth = () => {
  const navigate = useNavigate();
  const { accessToken, user, business, setSession, clearAuth } = authStore();

  const resolvePostAuthRoute = (businessPayload) =>
    businessPayload?.deploymentMode === "SELF_HOSTED" || businessPayload?.onboardingCompleted ? "/dashboard" : "/onboarding";
  const postAuthRoute = (businessPayload) => {
    const handoffToken = sessionStorage.getItem("billstack-invoice-handoff-token");
    return handoffToken
      ? `/integration/invoice-handoff?token=${encodeURIComponent(handoffToken)}`
      : resolvePostAuthRoute(businessPayload);
  };

  const syncSession = async () => {
    const data = await currentSessionRequest();
    setSession({
      accessToken,
      user: data.user,
      business: data.business,
    });
  };

  const register = async (payload) => {
    const data = await registerRequest(payload);
    setSession(data);
    uiStore.getState().pushToast({
      tone: "success",
      title: "Account created",
      message: "Your business owner account is ready.",
    });
    navigate(postAuthRoute(data.business));
  };

  // With two-step sign-in on, the first step answers { twoFactorRequired, challengeToken } and no
  // session: the caller asks for the code and calls completeTwoFactor.
  const login = async (payload) => {
    const data = await loginRequest(payload);
    if (data?.twoFactorRequired) return data;
    setSession(data);
    uiStore.getState().pushToast({
      tone: "success",
      title: "Welcome back",
      message: "You are signed in to BillStack.",
    });
    navigate(postAuthRoute(data.business));
    return null;
  };

  const completeTwoFactor = async ({ challengeToken, code }) => {
    const data = await loginTwoFactorRequest({ challengeToken, code });
    setSession(data);
    uiStore.getState().pushToast({
      tone: data.recoveryLeft !== undefined ? "info" : "success",
      title: "Welcome back",
      message: data.recoveryLeft !== undefined
        ? `Signed in with a recovery code. ${data.recoveryLeft} left - switch two-step sign-in off and on again in Settings for a fresh set.`
        : "You are signed in to BillStack.",
    });
    navigate(postAuthRoute(data.business));
  };

  const googleAuth = async (payload) => {
    const data = await googleAuthRequest(payload);
    if (data?.twoFactorRequired) return data;
    setSession(data);
    uiStore.getState().pushToast({
      tone: "success",
      title: payload.mode === "signup" ? "Account created" : "Welcome back",
      message: "Google sign-in completed securely.",
    });
    navigate(postAuthRoute(data.business));
  };

  const logout = async () => {
    try {
      await logoutRequest();
    } finally {
      clearAuth();
      uiStore.getState().pushToast({
        tone: "info",
        message: "You have been logged out.",
      });
      navigate("/login");
    }
  };

  return {
    accessToken,
    business,
    completeTwoFactor,
    googleAuth,
    login,
    logout,
    register,
    syncSession,
    user,
  };
};
