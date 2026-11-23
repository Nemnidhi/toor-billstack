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
  const [uploadFile, setUploadFile] = useState(null);
  const [fileBase64, setFileBase64] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState("");
  // A statement PDF's password: sent with the import to open the file, never kept.
  const [pdfPassword, setPdfPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const isPdf = /\.pdf$/i.test(uploadFile?.name || "");

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

  // The chosen statement file is sent as base64 (the server reads CSV, XLSX, XLS
  // and PDF). Files over 5 MB are refused here with a clear message instead of
  // failing on the server.
  const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0] || null;
    setError("");
    setUploadFile(null);
    setFileBase64("");
    setPdfPassword("");
    setNeedsPassword(false);
    if (!file) return;
    if (file.size > MAX_STATEMENT_BYTES) {
      setError("This file is larger than 5 MB. Export a shorter date range from the bank and import it in parts.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      setFileBase64(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
      setUploadFile(file);
    };
    reader.onerror = () => setError("Could not read that file. Try saving it again from the bank's site.");
    reader.readAsDataURL(file);
  };

  const handleImportSubmit = async (e) => {
    e.preventDefault();
    if (!csvText.trim() && !fileBase64) return;
    setImporting(true);
    setError("");
    try {
      const res = await importBankStatementRequest({
        entity: selectedEntity,
        bankAccountId: selectedBankAccountId,
        ...(fileBase64 ? { fileBase64, fileName: uploadFile?.name || "", ...(isPdf && pdfPassword ? { password: pdfPassword } : {}) } : { csvText }),
      });
      setImportResult(res);
      setCsvText("");
      setUploadFile(null);
      setFileBase64("");
      setPdfPassword("");
      setNeedsPassword(false);
      loadReconciliation();
    } catch (err) {
      const message = err.response?.data?.message || err.message || "Statement import failed";
      if (/password/i.test(message) && isPdf) setNeedsPassword(true);
      setError(message);
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
            <UploadCloud className="h-4 w-4" /> Import statement
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
                          <span title={tx.notes || ""} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" /> {tx.matchedAutomatically ? "Matched (auto)" : "Matched"}
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
              <h3 className="font-bold text-base text-slate-900 dark:text-white">Import bank statement (Excel / CSV / PDF)</h3>
              <button onClick={() => setShowImportModal(false)} className="text-slate-400 hover:text-slate-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3">
              <p className="text-xs text-slate-500">
                Upload the statement downloaded from net banking: Excel, CSV or PDF. Columns read: Date, Narration / Particulars, Ref / UTR, Withdrawal / Debit, Deposit / Credit (or Amount with Dr / Cr), Balance.
                Rows already imported are skipped. Every row is checked against the balance printed beside it, and a row that can only be one entry in the books
                (same amount, its reference, or within 3 days) is matched on its own; you can undo any match.
              </p>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Statement file (.xlsx, .xls, .csv, .pdf)
                </label>
                <input
                  type="file"
                  accept=".csv, .xlsx, .xls, .pdf"
                  onChange={handleFileUpload}
                  className="block w-full text-xs text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100 dark:file:bg-slate-800 dark:file:text-slate-200"
                />
                {uploadFile && (
                  <p className="mt-1 text-xs text-emerald-600 font-medium">Selected file: {uploadFile.name}</p>
                )}
                {isPdf && (
                  <div className="mt-3">
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                      PDF password {needsPassword ? "(needed)" : "(only if the PDF is locked)"}
                    </label>
                    <input
                      type="password"
                      autoComplete="off"
                      value={pdfPassword}
                      onChange={(e) => setPdfPassword(e.target.value)}
                      className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-800 dark:bg-slate-800"
                    />
                    <p className="mt-1 text-[11px] text-slate-400">Used only to open the file; it is not saved. A scanned PDF is read by the document reader when the owner has switched it on.</p>
                  </div>
                )}
              </div>

              <div className="relative flex py-1 items-center">
                <div className="flex-grow border-t border-slate-200 dark:border-slate-800"></div>
                <span className="flex-shrink mx-2 text-[10px] text-slate-400 uppercase font-bold">Or paste CSV raw text</span>
                <div className="flex-grow border-t border-slate-200 dark:border-slate-800"></div>
              </div>
            </div>

            {importResult && <ImportResult result={importResult} />}

            <form onSubmit={handleImportSubmit} className="space-y-4">
              <textarea
                rows={5}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={"Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n01/05/2026,CLIENT PAYMENT,REF123,,50000.00,150000.00"}
                className="w-full font-mono text-xs rounded-xl border border-slate-200 p-3 dark:border-slate-800 dark:bg-slate-800"
              />

              {error && <div className="text-xs text-rose-500 font-medium">{error}</div>}

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
                  disabled={importing || (!csvText.trim() && !fileBase64)}
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

const SOURCES = { PDF_TEXT: "read from the PDF", PDF_READ_BY_AI: "scanned PDF, read by the document reader: check the rows", EXCEL_CSV: "" };

const ImportResult = ({ result }) => {
  const check = result.balanceCheck || {};
  return (
    <div className="space-y-2 rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
      <p>
        Imported {result.importedCount} rows{result.duplicateCount ? `, ${result.duplicateCount} already in` : ""}
        {result.autoMatched ? `, ${result.autoMatched} matched automatically` : ""}
        {SOURCES[result.source] ? ` (${SOURCES[result.source]})` : ""}.
      </p>
      {check.checked ? (
        check.breakCount ? (
          <div className="rounded-lg bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <p className="font-semibold">The running balance does not follow at {check.breakCount} row{check.breakCount > 1 ? "s" : ""}: a row may be missing or misread.</p>
            <ul className="mt-1 list-disc pl-4">
              {check.breaks.map((b, i) => (
                <li key={i}>{b.date} {b.description}: balance should be {money(b.expected)}, statement shows {money(b.printed)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p>Balance check: all {check.checked} rows agree with the statement's running balance.</p>
        )
      ) : null}
      {result.unresolvedCount ? <p className="text-amber-700 dark:text-amber-300">{result.unresolvedCount} rows had no Dr / Cr and no balance to tell the direction; they were left out.</p> : null}
      {result.unclear ? <p className="text-amber-700 dark:text-amber-300">Not clear on the scan: {result.unclear}</p> : null}
    </div>
  );
};

export default ReconciliationTab;
