import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
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
  // A single billing company needs no switcher; show nothing rather than a disabled control.
  if (entities.length < 2) return error ? <p role="alert" className="text-xs text-rose-600">{error}</p> : null;
  return <div className="relative min-w-0">
    <label className="sr-only" htmlFor="billing-entity-switcher">Active billing company</label>
    <Building2 size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--text-muted)" }} />
    <select id="billing-entity-switcher" title="Active billing company" value={business?.id || ""} onChange={change} disabled={busy} className="entity-switcher">
      {entities.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select>
    {error && <p role="alert" className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-rose-600">{error}</p>}
  </div>;
}
