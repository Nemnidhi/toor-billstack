import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, FileSpreadsheet, RefreshCw, UploadCloud, X } from "lucide-react";
import {
  getBankAccountsRequest,
  importBankStatementRequest,
  getReconciliationRequest,
  confirmMatchRequest,
  unmatchRequest,
} from "../api";
import { money } from "../../dashboard/reportPresentation";

const ReconciliationTab = ({ selectedEntity }) => {
  const [bankAccounts, setBankAccounts] = useState([]);
  const [selectedBankAccountId, setSelectedBankAccountId] = useState("");
  const [reconData, setReconData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState("");

  const loadBankAccounts = async () => {
    try {
      const accounts = await getBankAccountsRequest({ entity: selectedEntity });
      setBankAccounts(accounts || []);
      if (accounts && accounts.length > 0 && !selectedBankAccountId) {
        setSelectedBankAccountId(accounts[0]._id);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const loadReconciliation = async () => {
    if (!selectedBankAccountId) return;
    setLoading(true);
    setError("");
    try {
      const data = await getReconciliationRequest({
        entity: selectedEntity,
        bankAccountId: selectedBankAccountId,
      });
      setReconData(data);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Failed to load reconciliation");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBankAccounts();
  }, [selectedEntity]);

  useEffect(() => {
    if (selectedBankAccountId) {
      loadReconciliation();
    }
  }, [selectedBankAccountId, selectedEntity]);

  const handleImportSubmit = async (e) => {
    e.preventDefault();
    if (!csvText.trim()) return;
    setImporting(true);
    setError("");
    try {
      const res = await importBankStatementRequest({
        entity: selectedEntity,
        bankAccountId: selectedBankAccountId,
        csvText,
      });
      setImportResult(res);
      setCsvText("");
      loadReconciliation();
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Statement import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmMatch = async (bankTxId, journalEntryId) => {
    try {
      await confirmMatchRequest({
        entity: selectedEntity,
        bankTransactionId: bankTxId,
        journalEntryId,
      });
      loadReconciliation();
    } catch (err) {
      alert("Match failed: " + (err.response?.data?.message || err.message));
    }
  };

  const handleUnmatch = async (bankTxId) => {
    try {
      await unmatchRequest({
        entity: selectedEntity,
        bankTransactionId: bankTxId,
      });
      loadReconciliation();
    } catch (err) {
      alert("Unmatch failed: " + (err.response?.data?.message || err.message));
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-slate-500">Bank Account:</span>
          <select
            value={selectedBankAccountId}
            onChange={(e) => setSelectedBankAccountId(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
          >
            {bankAccounts.map((acc) => (
              <option key={acc._id} value={acc._id}>
                {acc.accountName} ({acc.bankName} - {acc.accountNumber})
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowImportModal(true); setImportResult(null); }}
            disabled={!selectedBankAccountId}
            className="flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-50"
          >
            <UploadCloud className="h-4 w-4" /> Import Statement CSV
          </button>
          <button
            onClick={loadReconciliation}
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900"
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-rose-500 font-medium">{error}</div>}

      {/* Reconciliation KPI Dashboard */}
      {reconData && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500">Statement Closing Balance</span>
              <div className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                {money(reconData.statementClosingBalance)}
              </div>
              <div className="mt-1 text-xs text-slate-400">Reported by bank</div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500">Book Balance (Journal Ledger)</span>
              <div className="mt-2 text-xl font-bold text-slate-900 dark:text-white">
                {money(reconData.bookBalance)}
              </div>
              <div className="mt-1 text-xs text-slate-400">Phase 4 bank ledger</div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500">Reconciled Balance</span>
              <div className="mt-2 text-xl font-bold text-emerald-600">
                {money(reconData.reconciledBalance)}
              </div>
              <div className="mt-1 text-xs text-slate-400">{reconData.metrics.matchedCount} matched rows</div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500">Reconciliation Difference</span>
              <div className={"mt-2 text-xl font-bold " + (reconData.isReconciled ? "text-emerald-600" : "text-rose-600")}>
                {money(reconData.reconciliationDifference)}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {reconData.isReconciled ? "Fully Reconciled" : "Requires Attention"}
              </div>
            </div>
          </div>

          {/* Statement Transactions Table */}
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">Bank Statement Activity vs Book Entries</h3>
              <span className="text-xs text-slate-400">{reconData.transactions?.length || 0} statement rows</span>
            </div>

            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Narration / Description</th>
                  <th className="px-3 py-3">Reference / UTR</th>
                  <th className="px-3 py-3 text-right">Inflow (Deposit)</th>
                  <th className="px-3 py-3 text-right">Outflow (Withdrawal)</th>
                  <th className="px-3 py-3 text-right">Bank Balance</th>
                  <th className="px-4 py-3">Status / Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {reconData.transactions?.map((tx) => (
                  <tr key={tx._id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="px-4 py-3">{new Date(tx.transactionDate).toLocaleDateString("en-IN")}</td>
                    <td className="px-4 py-3 max-w-[240px] truncate" title={tx.description}>{tx.description}</td>
                    <td className="px-3 py-3 font-mono text-slate-500">{tx.reference || "-"}</td>
                    <td className="px-3 py-3 text-right font-semibold text-emerald-600">
                      {tx.direction === "INFLOW" ? money(tx.amount) : "-"}
                    </td>
                    <td className="px-3 py-3 text-right font-semibold text-rose-500">
                      {tx.direction === "OUTFLOW" ? money(tx.amount) : "-"}
                    </td>
                    <td className="px-3 py-3 text-right">{tx.runningBalance ? money(tx.runningBalance) : "-"}</td>
                    <td className="px-4 py-3">
                      {tx.status === "MATCHED" ? (
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" /> Matched
                          </span>
                          <button
                            onClick={() => handleUnmatch(tx._id)}
                            className="text-xs text-rose-600 hover:underline"
                          >
                            Unmatch
                          </button>
                        </div>
                      ) : tx.status === "SUGGESTED_MATCH" ? (
                        <div className="space-y-1">
                          <span className="inline-flex rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                            {tx.suggestedMatches?.length || 1} Suggested
                          </span>
                          {tx.suggestedMatches?.map((match, mIdx) => (
                            <div key={mIdx} className="flex items-center gap-2 pt-0.5">
                              <span className="text-[10px] text-slate-500">{match.entryNumber}: {match.matchReason}</span>
                              <button
                                onClick={() => handleConfirmMatch(tx._id, match.journalEntryId)}
                                className="rounded bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-brand-700"
                              >
                                Match
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                          Unmatched
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CSV Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900 space-y-4">
            <div className="flex items-center justify-between border-b pb-3 dark:border-slate-800">
              <h3 className="font-bold text-base text-slate-900 dark:text-white">Import Bank Statement CSV</h3>
              <button onClick={() => setShowImportModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-slate-500">
              Paste standard bank CSV export content (Date, Narration, Ref No, Withdrawal/Debit, Deposit/Credit, Balance).
              Duplicate rows will be automatically skipped based on transaction fingerprint.
            </p>

            {importResult && (
              <div className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                Imported: {importResult.importedCount} rows | Skipped Duplicates: {importResult.duplicateCount}
              </div>
            )}

            <form onSubmit={handleImportSubmit} className="space-y-4">
              <textarea
                rows={8}
                required
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={"Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n01/05/2026,CLIENT PAYMENT,REF123,,50000.00,150000.00"}
                className="w-full font-mono text-xs rounded-xl border border-slate-200 p-3 dark:border-slate-800 dark:bg-slate-800"
              />

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={importing || !csvText.trim()}
                  className="rounded-xl bg-brand-600 px-5 py-2 text-xs font-bold text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  {importing ? "Importing..." : "Parse & Import Statement"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReconciliationTab;
