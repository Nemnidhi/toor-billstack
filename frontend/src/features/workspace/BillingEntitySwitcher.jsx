import { useEffect, useState } from "react";
import api from "../../api/axios";
import { authStore } from "../../store/authStore";

export default function BillingEntitySwitcher() {
  const { business, accessToken, setSession } = authStore();
  const [entities, setEntities] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => api.get("/business/billing-entities").then(r => { if (active) setEntities(r.data.data); }).catch(() => {});
    load();
    window.addEventListener("billstack-entities-changed", load);
    return () => { active = false; window.removeEventListener("billstack-entities-changed", load); };
  }, [business?.id]);
  const change = async e => {
    const businessId = e.target.value;
    if (!businessId || businessId === business?.id) return;
    setBusy(true); setError("");
    try {
      const { data } = await api.get("/auth/me", { headers: { "x-business-id": businessId } });
      setSession({ accessToken, ...data.data });
      sessionStorage.removeItem("billstack-invoice-handoff-customer");
      // Start a fresh page tree; forms/caches from the old entity cannot leak into the new one.
      window.location.assign("/dashboard");
    } catch (err) { setError(err.response?.data?.message || "Unable to switch billing company"); setBusy(false); }
  };
  return <div className="max-w-64"><label className="text-xs">Active billing company<select aria-label="Active billing company" value={business?.id || ""} onChange={change} disabled={busy} className="block w-full rounded border bg-transparent p-1 text-sm">{entities.length ? entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>) : <option value={business?.id || ""}>{business?.name}</option>}</select></label>{error && <p role="alert" className="text-xs text-red-600">{error}</p>}</div>;
}
