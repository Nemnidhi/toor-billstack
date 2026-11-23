import { useEffect, useMemo, useState } from "react";
import api from "../../api/axios";
import { authStore } from "../../store/authStore";
import { Archive, Building2, Pencil, PlusCircle, RotateCcw, UserCheck, UserMinus, Wallet } from "lucide-react";

const roleLabel = { admin: "Admin", accountant: "Accountant", staff: "Staff", auditor: "Auditor" };
const emptyNew = { name: "", kind: "COMPANY", gstin: "", invoicePrefix: "" };

// Companies (and personal books) of the group, and who can open each one. Owner only.
export default function BillingEntitySettings() {
  const user = authStore((s) => s.user);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState({ businessId: "", userId: "", role: "accountant" });
  const [adding, setAdding] = useState(null);
  const [renaming, setRenaming] = useState(null);

  const load = () =>
    api
      .get("/business/billing-entities/members")
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e.response?.data?.message || "Unable to load entity access"));

  useEffect(() => {
    if (user?.role === "owner") load();
  }, [user?.role]);

  const entities = data?.entities || [];
  const goldhawk = entities.find((e) => e.billingEntityCode === "GOLDHAWK");
  const primary = entities.find((e) => e.isPrimary) || entities[0];
  const others = entities.filter((e) => !e.isPrimary);
  const target = others.find((e) => String(e.id) === String(selection.businessId)) || others[0];
  const grantsFor = useMemo(
    () => (businessId) => (data?.grants || []).filter((g) => String(g.businessId) === String(businessId)),
    [data]
  );
  const myId = String(user?.id || user?._id || "");
  const selectedGrant = target && selection.userId ? grantsFor(target.id).find((g) => String(g.userId) === String(selection.userId)) : null;

  if (user?.role !== "owner") return null;

  const run = async (action, done = "") => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      setSelection((current) => ({ ...current, userId: "" }));
      if (done) setNotice(done);
      window.dispatchEvent(new Event("billstack-entities-changed"));
      return true;
    } catch (e) {
      setError(e.response?.data?.message || "Unable to update billing entities");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const kindText = (entity) => (entity.isPrimary ? "Primary" : entity.kind === "PERSONAL" ? "Personal books" : entity.gstEnabled ? "GST" : "Non-GST");

  return (
    <section className="panel space-y-5 p-5 sm:p-6" aria-label="Billing company access">
      <div className="flex items-start gap-3">
        <span className="icon-chip"><Building2 size={18} /></span>
        <div>
          <h2 className="text-base font-bold">Businesses & access</h2>
          <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
            Switch business from the header. Each one keeps its own legal details, GST, bank accounts, invoices and ledgers.
            Personal books (for example a founder's credit-card spending) open only for you and the people you give access to, and never join company reports.
          </p>
        </div>
      </div>

      {entities.length ? (
        <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
          {entities.map((entity) => (
            <div key={entity.id} className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 text-sm last:border-b-0" style={{ borderColor: "var(--panel-border)" }}>
              {renaming?.id === entity.id ? (
                <form
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => api.patch(`/business/billing-entities/${entity.id}`, { name: renaming.name }), "Renamed.")) setRenaming(null);
                  }}
                >
                  <input className="field min-w-[220px] flex-1" value={renaming.name} maxLength={120} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} aria-label="New name" autoFocus />
                  <button type="submit" className="btn-primary" disabled={busy || renaming.name.trim().length < 2}>Save</button>
                  <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>Cancel</button>
                </form>
              ) : (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${entity.isPrimary ? "bg-brand-600" : entity.kind === "PERSONAL" ? "bg-violet-500" : "bg-amber-500"}`} aria-hidden="true" />
                    <span className="truncate font-semibold">{entity.name}</span>
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>{kindText(entity)}</span>
                  </span>
                  {!entity.isPrimary ? (
                    <span className="flex gap-2">
                      <button type="button" className="btn-secondary" disabled={busy} onClick={() => setRenaming({ id: entity.id, name: entity.name })}><Pencil size={14} /> Rename</button>
                      {entity.billingEntityCode !== "GOLDHAWK" ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`Archive ${entity.name}? It leaves the switcher; its books stay as they are and you can bring it back here.`)) {
                              run(() => api.patch(`/business/billing-entities/${entity.id}`, { archived: true }), `${entity.name} archived.`);
                            }
                          }}
                        >
                          <Archive size={14} /> Archive
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {data && !goldhawk ? (
          <button disabled={busy} type="button" className="btn-secondary" onClick={() => run(() => api.post("/business/billing-entities"), "Goldhawk enabled.")}>
            <PlusCircle size={16} /> Enable Goldhawk Infrabulls Pvt. Ltd.
          </button>
        ) : null}
        {data && !adding ? (
          <>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => setAdding({ ...emptyNew })}><PlusCircle size={16} /> Add a business</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setAdding({ ...emptyNew, kind: "PERSONAL" })}><Wallet size={16} /> Add personal books</button>
          </>
        ) : null}
      </div>

      {adding ? (
        <form
          className="rounded-xl border p-4"
          style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}
          onSubmit={async (e) => {
            e.preventDefault();
            const payload = { name: adding.name, kind: adding.kind, ...(adding.kind === "COMPANY" ? { gstin: adding.gstin, invoicePrefix: adding.invoicePrefix } : {}) };
            if (await run(() => api.post("/business/billing-entities", payload), `${adding.name.trim()} added. Switch to it from the header to set its details.`)) setAdding(null);
          }}
        >
          <p className="text-sm font-semibold">{adding.kind === "PERSONAL" ? "New personal books" : "New business"}</p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {adding.kind === "PERSONAL"
              ? "A person's own books: no GST and no invoice series needed. Record card spending as expenses paid by credit card; pay the card bill from the bank with a journal entry."
              : "Starts with your primary company's address and settings; change them after switching to it. Leave GSTIN empty if it is not registered."}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="form-field">
              <span className="form-label">{adding.kind === "PERSONAL" ? "Name (e.g. Ashish personal)" : "Business name"}</span>
              <input className="field" value={adding.name} maxLength={120} onChange={(e) => setAdding({ ...adding, name: e.target.value })} required />
            </label>
            <label className="form-field">
              <span className="form-label">Kind</span>
              <select className="field" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value })}>
                <option value="COMPANY">Business (its own invoices, GST)</option>
                <option value="PERSONAL">Personal books (private)</option>
              </select>
            </label>
            {adding.kind === "COMPANY" ? (
              <>
                <label className="form-field">
                  <span className="form-label">GSTIN (optional)</span>
                  <input className="field uppercase" value={adding.gstin} maxLength={15} onChange={(e) => setAdding({ ...adding, gstin: e.target.value })} placeholder="23ABCDE1234F1Z5" />
                </label>
                <label className="form-field">
                  <span className="form-label">Invoice prefix (optional)</span>
                  <input className="field uppercase" value={adding.invoicePrefix} maxLength={6} onChange={(e) => setAdding({ ...adding, invoicePrefix: e.target.value })} placeholder="e.g. SC" />
                </label>
              </>
            ) : null}
          </div>
          <div className="mt-4 flex gap-2">
            <button type="submit" className="btn-primary" disabled={busy || adding.name.trim().length < 2}>Create</button>
            <button type="button" className="btn-secondary" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </form>
      ) : null}

      {target ? (
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}>
          <p className="text-sm font-semibold">Who can open each business</p>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            Everyone on your team can use {primary?.name || "the primary company"}. Admins also reach the other businesses (not personal books). Give anyone else access here.
          </p>

          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px_auto]">
            <label className="form-field">
              <span className="form-label">Business</span>
              <select className="field" value={target.id} onChange={(e) => setSelection({ ...selection, businessId: e.target.value, userId: "" })}>
                {others.map((e) => <option key={e.id} value={e.id}>{e.name}{e.kind === "PERSONAL" ? " (personal)" : ""}</option>)}
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">Team member</span>
              <select className="field" value={selection.userId} onChange={(e) => setSelection({ ...selection, userId: e.target.value })}>
                <option value="">Select team member</option>
                {(data.users || [])
                  .filter((u) => String(u._id) !== myId)
                  .map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name}{u.email ? ` (${u.email})` : ""}{grantsFor(target.id).some((g) => String(g.userId) === String(u._id)) ? " — has access" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <label className="form-field">
              <span className="form-label">Role there</span>
              <select className="field" value={selection.role} onChange={(e) => setSelection({ ...selection, role: e.target.value })}>
                <option value="accountant">Accountant</option>
                <option value="staff">Staff</option>
                <option value="admin">Admin</option>
                <option value="auditor">Auditor (read-only)</option>
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                disabled={busy || !selection.userId}
                onClick={() => run(() => api.put("/business/billing-entities/members", { userId: selection.userId, role: selection.role, businessId: target.id }))}
                className="btn-primary"
              >
                <UserCheck size={16} /> {selectedGrant ? "Update role" : "Give access"}
              </button>
              {selectedGrant ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => api.put("/business/billing-entities/members", { userId: selection.userId, role: selection.role, businessId: target.id, remove: true }))}
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

          <p className="mb-2 mt-5 text-xs font-semibold" style={{ color: "var(--text-muted)" }}>People given access to {target.name}</p>
          <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
            {grantsFor(target.id).length ? grantsFor(target.id).map((g) => (
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
              <p className="px-4 py-3 text-sm" style={{ color: "var(--text-muted)" }}>Nobody has been given access to {target.name} yet.</p>
            )}
          </div>
        </div>
      ) : null}

      {data?.archived?.length ? (
        <div>
          <p className="mb-2 text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Archived</p>
          <div className="flex flex-wrap gap-2">
            {data.archived.map((b) => (
              <button key={b.id} type="button" className="btn-secondary" disabled={busy} onClick={() => run(() => api.patch(`/business/billing-entities/${b.id}`, { archived: false }), `${b.name} is back.`)}>
                <RotateCcw size={14} /> Bring back {b.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {notice ? <p role="status" className="alert alert-success">{notice}</p> : null}
      {error ? <p role="alert" className="alert alert-error">{error}</p> : null}
    </section>
  );
}
