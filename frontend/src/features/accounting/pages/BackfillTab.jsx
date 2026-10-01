import { useState } from "react";
import { AlertTriangle, CheckCircle2, Play, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { runBackfillRequest } from "../api";

const BackfillTab = ({ selectedEntity, onBackfillComplete }) => {
  const [loading, setLoading] = useState(false);
  const [dryRunResult, setDryRunResult] = useState(null);
  const [executeResult, setExecuteResult] = useState(null);
  const [error, setError] = useState("");

  const handleDryRun = async () => {
    setLoading(true);
    setError("");
    setExecuteResult(null);
    try {
      const res = await runBackfillRequest({ mode: "DRY_RUN", entity: selectedEntity });
      setDryRunResult(res);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Dry run scan failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!window.confirm("Are you sure you want to execute historical accounting backfill for " + selectedEntity + "? Double-entry journal entries will be posted for all eligible transactions.")) {
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await runBackfillRequest({ mode: "EXECUTE", entity: selectedEntity });
      setExecuteResult(res);
      setDryRunResult(null);
      if (onBackfillComplete) onBackfillComplete();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Backfill execution failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand-600" />
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Historical Accounting Backfill</h2>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Safely audit and backfill pre-existing invoices, customer advances, payments, and expenses into the double-entry journal.
          Idempotent, non-destructive, and strictly verifies balances before writing.
        </p>

        {error && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-medium text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            onClick={handleDryRun}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-200"
          >
            <Search className="h-4 w-4" />
            {loading ? "Scanning..." : "1. Run Dry-Run Audit Scan"}
          </button>

          {dryRunResult && (
            <button
              onClick={handleExecute}
              disabled={loading || dryRunResult.summary.wouldPost === 0}
              className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              2. Execute Backfill ({dryRunResult.summary.wouldPost} Entries)
            </button>
          )}
        </div>
      </div>

      {/* Dry Run Audit Results */}
      {dryRunResult && (
        <div className="space-y-4 rounded-2xl border border-brand-200 bg-brand-50/40 p-6 dark:border-brand-900/50 dark:bg-slate-900">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-900 dark:text-white text-base">
              Dry-Run Audit Findings for {dryRunResult.business.name}
            </h3>
            <span className="rounded-full bg-brand-100 px-3 py-1 text-xs font-bold text-brand-700 dark:bg-brand-950 dark:text-brand-300">
              NO WRITES PERFORMED
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5 pt-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-800/80">
              <span className="text-xs font-medium text-slate-400">Total Scanned</span>
              <div className="mt-1 text-xl font-bold">{dryRunResult.summary.totalCandidates}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-800/80">
              <span className="text-xs font-medium text-slate-400">Already Journaled</span>
              <div className="mt-1 text-xl font-bold text-slate-600 dark:text-slate-300">{dryRunResult.summary.alreadyPosted}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-800/80">
              <span className="text-xs font-medium text-slate-400">Ready to Post</span>
              <div className="mt-1 text-xl font-bold text-emerald-600">{dryRunResult.summary.wouldPost}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-800/80">
              <span className="text-xs font-medium text-slate-400">Unresolved / Skipped</span>
              <div className="mt-1 text-xl font-bold text-amber-600">{dryRunResult.summary.unresolved}</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-800/80">
              <span className="text-xs font-medium text-slate-400">Zero / Invalid</span>
              <div className="mt-1 text-xl font-bold text-rose-500">{dryRunResult.summary.invalid}</div>
            </div>
          </div>

          {/* Breakdown table */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-800/60">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-2.5">Category</th>
                  <th className="px-4 py-2.5">Candidates</th>
                  <th className="px-4 py-2.5">Already Posted</th>
                  <th className="px-4 py-2.5">Would Post</th>
                  <th className="px-4 py-2.5">Unresolved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {Object.entries(dryRunResult.breakdown).map(([key, val]) => (
                  <tr key={key}>
                    <td className="px-4 py-2 font-semibold capitalize">{key}</td>
                    <td className="px-4 py-2">{val.candidates}</td>
                    <td className="px-4 py-2">{val.alreadyPosted}</td>
                    <td className="px-4 py-2 font-bold text-emerald-600">{val.wouldPost}</td>
                    <td className="px-4 py-2 text-amber-600">{val.unresolved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Execution Results */}
      {executeResult && (
        <div className="space-y-4 rounded-2xl border border-emerald-200 bg-emerald-50/50 p-6 dark:border-emerald-900/50 dark:bg-slate-900">
          <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-bold text-base">
            <CheckCircle2 className="h-5 w-5" />
            Backfill Successfully Executed ({executeResult.summary.posted} Journal Entries Posted)
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            All eligible historical financial records have been converted to balanced double-entry journal records.
            Phase 5 accountant reports will now automatically reflect these figures.
          </p>
        </div>
      )}
    </div>
  );
};

export default BackfillTab;
