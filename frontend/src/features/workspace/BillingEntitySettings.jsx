import { useEffect, useMemo, useState } from "react";
import api from "../../api/axios";
import { authStore } from "../../store/authStore";
import { Building2, PlusCircle, UserCheck, UserMinus } from "lucide-react";

const roleLabel = { admin: "Admin", accountant: "Accountant", staff: "Staff" };

export default function BillingEntitySettings() {
  const user = authStore((s) => s.user);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState({ userId: "", role: "accountant" });

  const load = () =>
    api
      .get("/business/billing-entities/members")
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e.response?.data?.message || "Unable to load entity access"));

  useEffect(() => {
    if (user?.role === "owner") load();
  }, [user?.role]);

  const goldhawk = data?.entities?.find((e) => e.billingEntityCode === "GOLDHAWK");
  const primary = data?.entities?.find((e) => e.isPrimary) || data?.entities?.[0];
  const goldhawkGrants = useMemo(
    () => (data?.grants || []).filter((g) => goldhawk && String(g.businessId) === String(goldhawk.id)),
    [data, goldhawk]
  );
  const myId = String(user?.id || user?._id || "");
  const grantFor = (userId) => goldhawkGrants.find((g) => String(g.userId) === String(userId));
  const selectedGrant = selection.userId ? grantFor(selection.userId) : null;

  if (user?.role !== "owner") return null;

  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      setSelection((current) => ({ ...current, userId: "" }));
      window.dispatchEvent(new Event("billstack-entities-changed"));
    } catch (e) {
      setError(e.response?.data?.message || "Unable to update billing entities");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel space-y-5 p-5 sm:p-6" aria-label="Billing company access">
      <div className="flex items-start gap-3">
        <span className="icon-chip"><Building2 size={18} /></span>
        <div>
          <h2 className="text-base font-bold">Billing companies & access</h2>
          <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
            Switch company from the header. Each company keeps its own legal details, GST, bank accounts, invoices and ledgers.
          </p>
        </div>
      </div>

      {data?.entities?.length ? (
        <div className="flex flex-wrap gap-2">
          {data.entities.map((entity) => (
            <span key={entity.id} className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>
              <span className={`h-2 w-2 rounded-full ${entity.isPrimary ? "bg-brand-600" : "bg-amber-500"}`} aria-hidden="true" />
              {entity.name}
              <span className="font-normal" style={{ color: "var(--text-muted)" }}>{entity.isPrimary ? "Primary" : entity.gstEnabled ? "GST" : "Non-GST"}</span>
            </span>
          ))}
        </div>
      ) : null}

      {data && !goldhawk ? (
        <button disabled={busy} type="button" className="btn-primary" onClick={() => run(() => api.post("/business/billing-entities"))}>
          <PlusCircle size={16} /> Enable Goldhawk Infrabulls Pvt. Ltd.
        </button>
      ) : null}

      {goldhawk ? (
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>
          <p className="text-sm font-semibold">Who can open {goldhawk.name}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            Everyone on your team can use {primary?.name || "the primary company"}. Give access here to let someone switch to {goldhawk.name} as well.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_170px_auto]">
            <label className="form-field">
              <span className="form-label">Team member</span>
              <select className="field" value={selection.userId} onChange={(e) => setSelection({ ...selection, userId: e.target.value })}>
                <option value="">Select team member</option>
                {(data.users || [])
                  .filter((u) => String(u._id) !== myId)
                  .map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name}{u.email ? ` (${u.email})` : ""}{grantFor(u._id) ? " — has access" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">Role in {goldhawk.name.split(" ")[0]}</span>
              <select className="field" value={selection.role} onChange={(e) => setSelection({ ...selection, role: e.target.value })}>
                <option value="accountant">Accountant</option>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                disabled={busy || !selection.userId}
                onClick={() => run(() => api.put("/business/billing-entities/members", { ...selection, businessId: goldhawk.id }))}
                className="btn-primary"
              >
                <UserCheck size={16} /> {selectedGrant ? "Update role" : "Give access"}
              </button>
              {selectedGrant ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => api.put("/business/billing-entities/members", { ...selection, businessId: goldhawk.id, remove: true }))}
                  className="btn-danger"
                >
                  <UserMinus size={16} /> Remove
                </button>
              ) : null}
            </div>
          </div>
          {!(data.users || []).some((u) => String(u._id) !== myId) ? (
            <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>No other team members yet. Add them from the Team page first.</p>
          ) : null}
        </div>
      ) : null}

      {goldhawk ? (
        <div>
          <p className="mb-2 text-xs font-semibold" style={{ color: "var(--text-muted)" }}>People with access to {goldhawk.name}</p>
          <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
            {goldhawkGrants.length ? goldhawkGrants.map((g) => (
              <div key={g._id} className="flex items-center justify-between gap-3 border-b px-4 py-3 text-sm last:border-b-0" style={{ borderColor: "var(--panel-border)" }}>
                <div className="flex min-w-0 items-center gap-3">
                  <span className="customer-avatar" aria-hidden="true">{(g.user?.name || "?").charAt(0).toUpperCase()}</span>
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{g.user?.name}{String(g.userId) === myId ? " (you)" : ""}</p>
                    <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{g.user?.email}</p>
                  </div>
                </div>
                <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>{roleLabel[g.role] || g.role}</span>
              </div>
            )) : (
              <p className="px-4 py-3 text-sm" style={{ color: "var(--text-muted)" }}>Only you can open {goldhawk.name} right now.</p>
            )}
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="alert alert-error">{error}</p> : null}
    </section>
  );
}
