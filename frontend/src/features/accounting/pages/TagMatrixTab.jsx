import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { getTagMatrixRequest } from "../api";
import { money } from "../../dashboard/reportPresentation";

// Business line x category report (client, 23 Nov 2026): the posted books split both ways, one
// business or every business you can see, with each cell's share of the total.
const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const input = "rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200";
const ghost = "flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";
const th = "px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500";
const td = "px-3 py-2 text-right text-xs tabular-nums text-slate-700 dark:text-slate-300";
const DIM = { businessLine: "Business line", reportCategory: "Category", company: "Business" };

const csvCell = (v) => {
  const text = String(v ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export default function TagMatrixTab({ params }) {
  const [scope, setScope] = useState("current");
  const [rows, setRows] = useState("businessLine");
  const [columns, setColumns] = useState("reportCategory");
  const [measure, setMeasure] = useState("profit");
  const [showPct, setShowPct] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const { entity, ...period } = params;
      setData(await getTagMatrixRequest({ ...period, entity: scope === "all" ? "all" : entity === "all" ? "consolidated" : entity, rows, columns, measure }));
    } catch (e) {
      setError(e.response?.data?.message || "Unable to load the report");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (rows === columns) setColumns(rows === "reportCategory" ? "businessLine" : "reportCategory");
    else load();
  }, [scope, rows, columns, measure, JSON.stringify(params)]);

  const cellText = (amount, pct) => (showPct ? `${pct}%` : money(amount));

  const exportCsv = () => {
    if (!data) return;
    const head = [DIM[data.rowsBy], ...data.columns.map((c) => c.label), "Total", "% of total"];
    const lines = [head, ...data.rows.map((r) => [r.label, ...r.cells.map((c) => c.amount), r.total, r.percentOfTotal]), ["Total", ...data.columns.map((c) => c.total), data.total, 100]];
    const blob = new Blob([lines.map((l) => l.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `business-lines-${data.measure}-${data.period.from || "start"}-${data.period.to || "today"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className={card}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            <span className="mb-1 block">Businesses</span>
            <select className={input} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="current">As picked above</option>
              <option value="all">Every business I can see</option>
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            <span className="mb-1 block">Rows</span>
            <select className={input} value={rows} onChange={(e) => setRows(e.target.value)}>
              {Object.entries(DIM).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            <span className="mb-1 block">Columns</span>
            <select className={input} value={columns} onChange={(e) => setColumns(e.target.value)}>
              {Object.entries(DIM).filter(([k]) => k !== rows).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            <span className="mb-1 block">Show</span>
            <select className={input} value={measure} onChange={(e) => setMeasure(e.target.value)}>
              <option value="profit">Profit (income less expenses)</option>
              <option value="income">Income</option>
              <option value="expenses">Expenses</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={showPct} onChange={(e) => setShowPct(e.target.checked)} /> As % of total
          </label>
          <div className="ml-auto flex gap-2">
            <button type="button" className={ghost} onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>
            <button type="button" className={ghost} onClick={exportCsv} disabled={!data}><Download size={14} /> CSV</button>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          From the posted books, the same figures as the Profit &amp; Loss. Tag invoices, expenses and purchases with a business line and
          category (lists in Settings); untagged amounts show under “Not set”. Personal books join only when picked on their own.
        </p>
      </div>

      {error ? <p className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p> : null}

      {data ? (
        <div className={card}>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-bold text-slate-900 dark:text-white">
              {measure === "profit" ? "Profit" : measure === "income" ? "Income" : "Expenses"} by {DIM[data.rowsBy].toLowerCase()} and {DIM[data.columnsBy].toLowerCase()}
            </p>
            <p className="text-xs text-slate-500">{data.period.label} · {data.companies.map((c) => c.name).join(", ")}</p>
          </div>
          {data.rows.length ? (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800">
                    <th className={`${th} text-left`}>{DIM[data.rowsBy]}</th>
                    {data.columns.map((c) => <th key={c.key} className={th}>{c.label}{c.archived ? " (archived)" : ""}</th>)}
                    <th className={th}>Total</th>
                    <th className={th}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.key} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="px-3 py-2 text-left text-xs font-semibold text-slate-800 dark:text-slate-200">{r.label}{r.archived ? <span className="font-normal text-slate-400"> (archived)</span> : null}</td>
                      {r.cells.map((c) => <td key={c.column} className={`${td} ${c.amount < 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>{c.amount ? cellText(c.amount, c.percentOfTotal) : "—"}</td>)}
                      <td className={`${td} font-bold`}>{money(r.total)}</td>
                      <td className={td}>
                        <span className="inline-flex items-center gap-2">
                          <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                            <span className="block h-full rounded-full bg-brand-600" style={{ width: `${Math.min(100, Math.max(0, r.percentOfTotal))}%` }} />
                          </span>
                          {r.percentOfTotal}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 dark:border-slate-700">
                    <td className="px-3 py-2 text-left text-xs font-bold text-slate-900 dark:text-white">Total</td>
                    {data.columns.map((c) => <td key={c.key} className={`${td} font-bold`}>{cellText(c.total, c.percentOfTotal)}</td>)}
                    <td className={`${td} font-bold`}>{money(data.total)}</td>
                    <td className={td}>100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Nothing posted in this period.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
