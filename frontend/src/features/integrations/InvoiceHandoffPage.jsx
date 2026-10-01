import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import RouteFallback from "../../components/ui/RouteFallback";
import { authStore } from "../../store/authStore";
import { resolveInvoiceHandoffRequest } from "../auth/api";
import { consumeHandoffOnce } from './handoffRequest';

const InvoiceHandoffPage = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const accessToken = authStore((state) => state.accessToken);
  const userId = authStore((state) => state.user?._id || state.user?.id);
  const businessId = authStore((state) => state.business?._id || state.business?.id);
  const [error, setError] = useState("");
  const token = params.get("token") || "";
  const completedToken = useRef("");

  useEffect(() => {
    if (completedToken.current === token && token) return;
    if (!token) { setError("This invoice handoff link is invalid."); return; }
    if (!accessToken) {
      sessionStorage.setItem("billstack-invoice-handoff-token", token);
      navigate("/login", { replace: true });
      return;
    }
    let active = true;
    consumeHandoffOnce({ token, userId, businessId, request: resolveInvoiceHandoffRequest })
      .then((context) => {
        if (!active) return;
        completedToken.current = token;
        if (context.session) authStore.getState().setSession(context.session);
        sessionStorage.removeItem("billstack-invoice-handoff-token");
        sessionStorage.setItem("billstack-invoice-handoff-customer", context.customer._id);
        navigate("/dashboard/invoices?action=create", { replace: true });
      })
      .catch((requestError) => {
        if (active) {
          sessionStorage.removeItem('billstack-invoice-handoff-token');
          setError(requestError.response?.data?.message || "This invoice handoff link is invalid or expired. Return to CRM for a fresh link.");
        }
      });
    return () => { active = false; };
  }, [accessToken, userId, businessId, navigate, token]);

  if (error) return <div className="mx-auto mt-20 max-w-lg rounded-2xl border border-rose-200 bg-white p-6 text-center text-rose-700"><h1 className="text-lg font-semibold">Unable to open invoice</h1><p className="mt-2 text-sm">{error}</p></div>;
  return <RouteFallback title="Preparing invoice" description="Securely loading the client into BillStack." />;
};

export default InvoiceHandoffPage;
