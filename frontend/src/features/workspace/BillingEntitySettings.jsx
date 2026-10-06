import { useEffect, useState } from "react";
import api from "../../api/axios";
import { authStore } from "../../store/authStore";
import { Building2, Shield, UserCheck, UserMinus, PlusCircle } from "lucide-react";

export default function BillingEntitySettings() {
  const user = authStore((s) => s.user);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState({ userId: "", businessId: "", role: "accountant" });

  const load = () =>
    api
      .get("/business/billing-entities/members")
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e.response?.data?.message || "Unable to load entity access"));

  useEffect(() => {
    if (user?.role === "owner") load();
  }, [user?.role]);

  if (user?.role !== "owner") return null;

  const run = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      window.dispatchEvent(new Event("billstack-entities-changed"));
    } catch (e) {
      setError(e.response?.data?.message || "Unable to update billing entities");
    } finally {
      setBusy(false);
    }
  };

  const goldhawk = data?.entities?.find((e) => e.billingEntityCode === "GOLDHAWK");

  return (
    <div
      className="rounded-2xl border p-6 space-y-5"
      style={{
        backgroundColor: "var(--panel-bg, #ffffff)",
        borderColor: "var(--panel-border, #e2e8f0)",
      }}
      aria-label="Billing company access"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-brand-600" />
            <h3 className="text-base font-bold text-slate-900 dark:text-white">
              Billing Companies & Entity Access
            </h3>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 max-w-xl">
            Switch between entities using the header dropdown to manage legal details, GST numbers,
            bank accounts, and invoices. Each company maintains distinct accounting and tax ledgers.
          </p>
        </div>
      </div>

      {!goldhawk && (
        <button
          disabled={busy}
          type="button"
          className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50 transition-all"
          onClick={() => run(() => api.post("/business/billing-entities"))}
        >
          <PlusCircle className="h-4 w-4" />
          Enable Goldhawk Infrabulls Pvt. Ltd.
        </button>
      )}

      {goldhawk && (
        <div className="rounded-xl border p-4 bg-slate-50/50 dark:bg-slate-800/20 border-slate-200 dark:border-slate-800 space-y-3">
          <p className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Assign Staff Access to Goldhawk Infrabulls
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Employee for entity access"
              value={selection.userId}
              onChange={(e) =>
                setSelection({ ...selection, userId: e.target.value, businessId: goldhawk.id })
              }
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">Select team member</option>
              {data.users
                .filter((u) => String(u._id) !== String(user.id || user._id))
                .map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.name} ({u.email})
                  </option>
                ))}
            </select>

            <select
              aria-label="Goldhawk role"
              value={selection.role}
              onChange={(e) => setSelection({ ...selection, role: e.target.value })}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="accountant">Role: Accountant</option>
              <option value="staff">Role: Staff</option>
              <option value="admin">Role: Admin</option>
            </select>

            <button
              type="button"
              disabled={busy || !selection.userId}
              onClick={() => run(() => api.put("/business/billing-entities/members", selection))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-40 transition-all"
            >
              <UserCheck className="h-3.5 w-3.5" />
              Grant Access
            </button>

            <button
              type="button"
              disabled={busy || !selection.userId}
              onClick={() =>
                run(() => api.put("/business/billing-entities/members", { ...selection, remove: true }))
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 px-3 py-2 text-xs font-semibold hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-40 transition-all"
            >
              <UserMinus className="h-3.5 w-3.5" />
              Revoke Access
            </button>
          </div>
        </div>
      )}

      {data?.grants && data.grants.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Active Entity Permissions
          </p>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            {data.grants.map((g) => {
              const u = data.users.find((x) => String(x._id) === String(g.userId));
              const e = data.entities.find((x) => String(x.id) === String(g.businessId));
              return (
                <div
                  key={g._id}
                  className="flex items-center justify-between px-4 py-2.5 bg-white dark:bg-slate-900 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <Shield className="h-3.5 w-3.5 text-slate-400" />
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {u?.name || "User"}
                    </span>
                    <span className="text-slate-400 text-[11px]">({u?.email})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-600 dark:text-slate-300">
                      {e?.name || "Entity"}
                    </span>
                    <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                      {g.role}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-rose-600 bg-rose-50 dark:bg-rose-950/20 p-2.5 rounded-lg border border-rose-200 dark:border-rose-900">
          {error}
        </p>
      )}
    </div>
  );
}
