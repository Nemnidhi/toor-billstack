import { useEffect, useState } from "react";
import { AlertTriangle, Download, History, Lock, RefreshCw, Unlock } from "lucide-react";
import { downloadEditLogCsv, getEditLogRequest, getGoldhawkWatchRequest, getPeriodLockRequest, setPeriodLockRequest } from "../api";
import { money } from "../../dashboard/reportPresentation";

const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const th = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500";
const td = "px-3 py-2 align-top text-xs text-slate-700 dark:text-slate-300";
const input = "rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200";
const button = "flex items-center gap-1.5 rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50";
const ghost = "flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";
const errorText = (err) => err?.response?.data?.message || err?.message || "Something went wrong";
const ddmmyyyy = (iso) => (iso ? iso.split("-").reverse().join("-") : "");
const when = (value) => new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
const short = (value) => {
  if (value === null || value === undefined || value === "") return "—";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

const LEVEL_STYLE = {
  OK: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  WARNING: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  DANGER: "border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-200",
  CROSSED: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200",
  REGISTERED: "border-slate-200 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
};

// Shown on the accounting page whatever the tab: Goldhawk's billing against the Rs 20 lakh limit.
export const GoldhawkBanner = () => {
  const [watch, setWatch] = useState(null);
  useEffect(() => { getGoldhawkWatchRequest().then(setWatch).catch(() => setWatch(null)); }, []);
  if (!watch || watch.level === "OK" || watch.level === "REGISTERED") return null;
  return (
    <div role="status" className={`flex items-start gap-3 rounded-2xl border p-4 text-xs shadow-sm ${LEVEL_STYLE[watch.level]}`}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-bold">Goldhawk GST limit: {watch.percent}% used ({money(watch.turnover)} of {money(watch.threshold)}, FY {watch.fy})</p>
        <p className="mt-0.5">{watch.message}</p>
      </div>
    </div>
  );
};

const PeriodLockPanel = ({ params, canLock }) => {
  const [state, setState] = useState(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    try { const data = await getPeriodLockRequest(params); setState(data); setValue(data.lockedUpTo || ""); setMessage(""); }
    catch (err) { setMessage(errorText(err)); }
  };
  useEffect(() => { load(); }, [params.entity]);
  const save = async (next) => {
    if (next === "" && !window.confirm("Reopen the closed period? Entries dated in it can be changed again until you close it.")) return;
    if (next && !window.confirm(`Close the books up to ${ddmmyyyy(next)}? Nothing dated on or before it can be posted, changed or cancelled until reopened.`)) return;
    setBusy(true);
    try { const data = await setPeriodLockRequest({ lockedUpTo: next }, params); setState(data); setValue(data.lockedUpTo || ""); setMessage(next ? "Books closed." : "Period reopened."); }
    catch (err) { setMessage(errorText(err)); }
    finally { setBusy(false); }
  };
  return (
    <div className={card}>
      <div className="flex items-center gap-2"><Lock className="h-4 w-4 text-slate-500" /><h3 className="text-sm font-bold">Period lock</h3></div>
      <p className="mt-1 text-xs text-slate-500">After a month's GST return is filed, or the year's accounts are finalised, close the books up to that day. Invoices, receipts, expenses, purchases and journals dated in the closed period are then refused.</p>
      <p className="mt-3 text-sm">{state?.lockedUpTo ? <>Closed up to <b>{ddmmyyyy(state.lockedUpTo)}</b>{state.lockedBy?.name ? <> by {state.lockedBy.name}</> : null}{state.lockedAt ? <> on {when(state.lockedAt)}</> : null}</> : "Open: no period is closed."}</p>
      {canLock ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input type="date" className={input} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Close the books up to" />
          <button type="button" className={button} disabled={busy || !value || value === state?.lockedUpTo} onClick={() => save(value)}><Lock className="h-3.5 w-3.5" /> Close up to this day</button>
          {state?.lockedUpTo ? <button type="button" className={ghost} disabled={busy} onClick={() => save("")}><Unlock className="h-3.5 w-3.5" /> Reopen</button> : null}
        </div>
      ) : <p className="mt-2 text-xs text-slate-500">Only the owner or an admin can close or reopen the books.</p>}
      {message ? <p className="mt-2 text-xs font-semibold text-slate-600 dark:text-slate-300">{message}</p> : null}
    </div>
  );
};

const EditLogPanel = ({ params }) => {
  const [filters, setFilters] = useState({ model: "", action: "", from: "", to: "", search: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const query = { ...params, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), page, limit: 50 };
  const load = async () => {
    setLoading(true);
    try { setData(await getEditLogRequest(query)); setError(""); } catch (err) { setError(errorText(err)); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [params.entity, page]);
  const exportCsv = async () => {
    try {
      const { page: _p, limit: _l, ...all } = query;
      const blob = await downloadEditLogCsv(all);
      const url = URL.createObjectURL(new Blob([blob], { type: "text/csv;charset=utf-8;" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `edit-log-${params.entity}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) { setError(errorText(err)); }
  };
  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><History className="h-4 w-4 text-slate-500" /><h3 className="text-sm font-bold">Edit log</h3></div>
        <div className="flex gap-2">
          <button type="button" className={ghost} onClick={load} disabled={loading}><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
          <button type="button" className={ghost} onClick={exportCsv}><Download className="h-3.5 w-3.5" /> Export for the auditor</button>
        </div>
      </div>
      <p className="mt-1 text-xs text-slate-500">Every record created, changed or deleted in the books, with who did it, when and from where. It is always on and cannot be edited or deleted (Companies (Accounts) Rules, rule 3(1)); it is kept for 8 years.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <select className={input} value={filters.model} onChange={set("model")} aria-label="Record type">
          <option value="">All records</option>
          {(data?.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className={input} value={filters.action} onChange={set("action")} aria-label="Change">
          <option value="">Any change</option><option value="CREATE">Created</option><option value="UPDATE">Changed</option><option value="DELETE">Deleted</option>
        </select>
        <input type="date" className={input} value={filters.from} onChange={set("from")} aria-label="From" />
        <input type="date" className={input} value={filters.to} onChange={set("to")} aria-label="To" />
        <input className={input} placeholder="Number or name" value={filters.search} onChange={set("search")} />
        <button type="button" className={button} onClick={() => (page === 1 ? load() : setPage(1))}>Show</button>
      </div>
      {error ? <p className="mt-2 text-xs font-semibold text-red-600">{error}</p> : null}
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
          <thead><tr><th className={th}>When</th><th className={th}>Who</th><th className={th}>Record</th><th className={th}>What</th><th className={th}>Changes</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(data?.items || []).map((row) => (
              <tr key={row._id}>
                <td className={td}>{when(row.at)}</td>
                <td className={td}>{row.userName || row.userEmail || "system"}{row.ip ? <div className="text-[10px] text-slate-400">{row.ip}</div> : null}</td>
                <td className={td}>{row.model}<div className="font-semibold">{row.recordLabel || String(row.recordId).slice(-6)}</div></td>
                <td className={td}>{{ CREATE: "Created", UPDATE: "Changed", DELETE: "Deleted" }[row.action]}</td>
                <td className={td}>
                  {row.changes?.length ? (
                    <ul className="space-y-0.5">
                      {(open === row._id ? row.changes : row.changes.slice(0, 3)).map((c) => (
                        <li key={c.path}><span className="font-semibold">{c.path}</span>: {short(c.before)} → {short(c.after)}</li>
                      ))}
                      {row.changes.length > 3 ? <li><button type="button" className="text-brand-600" onClick={() => setOpen(open === row._id ? null : row._id)}>{open === row._id ? "less" : `+${row.changes.length - 3} more`}</button></li> : null}
                    </ul>
                  ) : row.update ? <span className="text-slate-500">{short(row.update)}</span> : <span className="text-slate-500">whole record kept</span>}
                </td>
              </tr>
            ))}
            {data && !data.items.length ? <tr><td className={td} colSpan={5}>Nothing in the log for these filters.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {data?.pagination?.totalPages > 1 ? (
        <div className="mt-3 flex items-center gap-2 text-xs">
          <button type="button" className={ghost} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page} of {data.pagination.totalPages} ({data.pagination.total} lines)</span>
          <button type="button" className={ghost} disabled={page >= data.pagination.totalPages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      ) : null}
    </div>
  );
};

const GoldhawkPanel = () => {
  const [watch, setWatch] = useState(null);
  useEffect(() => { getGoldhawkWatchRequest().then(setWatch).catch(() => setWatch(null)); }, []);
  if (!watch) return null;
  const bar = { CROSSED: "bg-red-500", DANGER: "bg-orange-500", WARNING: "bg-amber-500" }[watch.level] || "bg-emerald-500";
  return (
    <div className={card}>
      <h3 className="text-sm font-bold">Goldhawk GST registration watch</h3>
      <p className="mt-1 text-xs text-slate-500">Goldhawk bills without GST until it registers. Registration is needed once a year's billing crosses {money(watch.threshold)}.</p>
      <div className="mt-3 h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800"><div className={`h-2 rounded-full ${bar}`} style={{ width: `${Math.min(100, watch.percent)}%` }} /></div>
      <p className="mt-2 text-xs"><b>{money(watch.turnover)}</b> billed in FY {watch.fy} ({watch.invoices} bills): {watch.percent}% of the limit.</p>
      <p className="mt-1 text-xs">{watch.message}</p>
    </div>
  );
};

const ControlsTab = ({ selectedEntity, role }) => {
  if (selectedEntity === "all") {
    return (
      <div className="space-y-4">
        <div className={card}><p className="text-sm">Pick TOOR or Goldhawk above: the books are closed and audited per company.</p></div>
        <GoldhawkPanel />
      </div>
    );
  }
  const params = { entity: selectedEntity };
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <PeriodLockPanel params={params} canLock={["owner", "admin"].includes(role)} />
        <GoldhawkPanel />
      </div>
      <EditLogPanel params={params} />
    </div>
  );
};

export default ControlsTab;
