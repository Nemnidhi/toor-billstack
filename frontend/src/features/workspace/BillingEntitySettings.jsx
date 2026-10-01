import { useEffect, useState } from "react";
import api from "../../api/axios";
import { authStore } from "../../store/authStore";
export default function BillingEntitySettings() {
  const user = authStore(s => s.user);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState({ userId: "", businessId: "", role: "accountant" });
  const load = () => api.get("/business/billing-entities/members").then(r => setData(r.data.data)).catch(e => setError(e.response?.data?.message || "Unable to load entity access"));
  useEffect(() => { if (user?.role === "owner") load(); }, [user?.role]);
  if (user?.role !== "owner") return null;
  const run = async action => { setBusy(true); setError(""); try { await action(); await load(); window.dispatchEvent(new Event("billstack-entities-changed")); } catch (e) { setError(e.response?.data?.message || "Unable to update billing entities"); } finally { setBusy(false); } };
  const goldhawk = data?.entities?.find(e => e.billingEntityCode === "GOLDHAWK");
  return <section className="rounded-xl border p-4 space-y-3" aria-label="Billing company access"><h3 className="font-semibold">Billing companies and access</h3><p className="text-sm">Switch company in the header to edit its legal name, logo, contact, bank and invoice settings. Each company keeps separate financial records.</p>{!goldhawk && <button disabled={busy} type="button" className="rounded border p-2" onClick={() => run(() => api.post("/business/billing-entities"))}>Enable Goldhawk Infrabulls Pvt. Ltd.</button>}{goldhawk && <div className="flex flex-wrap gap-2"><select aria-label="Employee for entity access" value={selection.userId} onChange={e => setSelection({ ...selection, userId: e.target.value, businessId: goldhawk.id })}><option value="">Select user</option>{data.users.filter(u => String(u._id) !== String(user.id || user._id)).map(u => <option key={u._id} value={u._id}>{u.name} ({u.email})</option>)}</select><select aria-label="Goldhawk role" value={selection.role} onChange={e => setSelection({ ...selection, role: e.target.value })}>{["accountant", "staff", "admin"].map(r => <option key={r}>{r}</option>)}</select><button type="button" disabled={busy || !selection.userId} onClick={() => run(() => api.put("/business/billing-entities/members", selection))}>Grant Goldhawk access</button><button type="button" disabled={busy || !selection.userId} onClick={() => run(() => api.put("/business/billing-entities/members", { ...selection, remove: true }))}>Remove Goldhawk access</button></div>}{data?.grants?.map(g => <p className="text-sm" key={g._id}>{data.users.find(u => String(u._id) === String(g.userId))?.name}: {data.entities.find(e => String(e.id) === String(g.businessId))?.name} ? {g.role}</p>)}{error && <p role="alert" className="text-red-600">{error}</p>}</section>;
}
