import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Building2,
  Calendar,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FileText,
  Landmark,
  RefreshCw,
  Scale,
  TrendingDown,
  TrendingUp,
  Wallet,
  XCircle,
} from "lucide-react";
import {
  getBalanceSheetRequest,
  getBankBookRequest,
  getCashBookRequest,
  getHistoricalWarningRequest,
  getProfitLossRequest,
  getTrialBalanceRequest,
  getAccountLedgerRequest,
  getAccountsRequest,
  downloadExportCsv,
  downloadExportXlsx,
} from "../api";
import { authStore } from "../../../store/authStore";
import { money } from "../../dashboard/reportPresentation";
import BackfillTab from "./BackfillTab";
import BankAccountsTab from "./BankAccountsTab";
import ReconciliationTab from "./ReconciliationTab";
import { ShieldCheck } from "lucide-react";

const AccountingReportsPage = () => {
  const { user, business } = authStore();

  const [activeTab, setActiveTab] = useState("overview");
  const [selectedEntity, setSelectedEntity] = useState("all");
  const [selectedPeriod, setSelectedPeriod] = useState("FY");
  const [dateRange, setDateRange] = useState({ from: "", to: "" });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [plData, setPlData] = useState(null);
  const [bsData, setBsData] = useState(null);
  const [tbData, setTbData] = useState(null);
  const [bookType, setBookType] = useState("BANK");
  const [bookData, setBookData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [ledgerData, setLedgerData] = useState(null);
  const [warningData, setWarningData] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);

  const queryParams = {
    entity: selectedEntity,
    period: selectedPeriod,
    ...(selectedPeriod === "CUSTOM" && dateRange.from ? { from: dateRange.from, to: dateRange.to } : {}),
  };

  const loadAll = async () => {
    setLoading(true);
    setError("");
    try {
      let loadErr = null;
      const [pl, bs, warn, accs] = await Promise.all([
        getProfitLossRequest(queryParams).catch((e) => {
          loadErr = e;
          return null;
        }),
        getBalanceSheetRequest(queryParams).catch((e) => {
          if (!loadErr) loadErr = e;
          return null;
        }),
        getHistoricalWarningRequest(queryParams).catch((e) => null),
        getAccountsRequest().catch((e) => []),
      ]);

      if ((!pl || !bs) && loadErr) {
        setError(loadErr.response?.data?.message || "Failed to load financial reports.");
      }

      setPlData(pl);
      setBsData(bs);
      setWarningData(warn);
      setAccounts(accs || []);

      if (accs && accs.length > 0 && !selectedAccountId) {
        setSelectedAccountId(accs[0]._id);
      }

      if (activeTab === "trial_balance" && selectedEntity !== "all") {
        const tb = await getTrialBalanceRequest(queryParams);
        setTbData(tb);
      } else if (activeTab === "bank_book") {
        const bk = bookType === "CASH"
          ? await getCashBookRequest(queryParams)
          : await getBankBookRequest(queryParams);
        setBookData(bk);
      }
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load financial reports.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, [selectedEntity, selectedPeriod, dateRange.from, dateRange.to]);

  useEffect(() => {
    if (activeTab === "bank_book") {
      setLoading(true);
      const fetchBook = bookType === "CASH" ? getCashBookRequest : getBankBookRequest;
      fetchBook(queryParams)
        .then(setBookData)
        .catch(console.error)
        .finally(() => setLoading(false));
    } else if (activeTab === "trial_balance" && selectedEntity !== "all") {
      setLoading(true);
      getTrialBalanceRequest(queryParams)
        .then(setTbData)
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [activeTab, bookType]);

  useEffect(() => {
    if (activeTab === "ledger" && selectedAccountId) {
      setLoading(true);
      getAccountLedgerRequest(selectedAccountId, queryParams)
        .then(setLedgerData)
        .catch(console.error)
        .finally(() => setLoading(false));
    }
  }, [activeTab, selectedAccountId]);

  const handleDownloadXlsx = async () => {
    try {
      setExportLoading(true);
      const blob = await downloadExportXlsx(queryParams);
      const url = window.URL.createObjectURL(
        new Blob([blob], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
      );
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "accountant-pack-" + selectedEntity + "-" + selectedPeriod + ".xlsx");
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      alert("Excel download failed: " + (err.response?.data?.message || err.message));
    } finally {
      setExportLoading(false);
    }
  };

  const handleDownloadCsv = async (reportType) => {
    try {
      setExportLoading(true);
      const blob = await downloadExportCsv({ ...queryParams, reportType });
      const url = window.URL.createObjectURL(new Blob([blob], { type: "text/csv;charset=utf-8;" }));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", (reportType || "accountant-pack") + "-" + selectedEntity + "-" + selectedPeriod + ".csv");
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      alert("Download failed: " + (err.response?.data?.message || err.message));
    } finally {
      setExportLoading(false);
    }
  };

  const drillDownToAccount = (accId) => {
    if (accId) {
      setSelectedAccountId(accId);
      setActiveTab("ledger");
    }
  };

  return (
    <div className="mx-auto max-w-[1550px] space-y-6 pb-12">
      {/* Page Title & Top Toolbar */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600">
              <Landmark className="h-5 w-5" />
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              Accounting & Financial Reports
            </h1>
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Double-entry journals, Profit & Loss, Balance Sheet, Bank Books & Accountant Export Pack
          </p>
        </div>

        {/* Global Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Entity Filter */}
          <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <Building2 className="h-4 w-4 text-slate-400" />
            <select
              value={selectedEntity}
              onChange={(e) => setSelectedEntity(e.target.value)}
              className="bg-transparent text-xs font-semibold text-slate-800 outline-none dark:text-slate-200"
            >
              <option value="all">All Companies (Consolidated)</option>
              <option value="TOOR">The Office On Rent (GST)</option>
              <option value="GOLDHAWK">Goldhawk Infrabulls (Non-GST)</option>
            </select>
          </div>

          {/* Period Filter (Indian FY) */}
          <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <Calendar className="h-4 w-4 text-slate-400" />
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
              className="bg-transparent text-xs font-semibold text-slate-800 outline-none dark:text-slate-200 cursor-pointer"
            >
              <optgroup label="Yearly">
                <option value="FY">Indian FY 2026-27 (Full Year)</option>
              </optgroup>
              <optgroup label="Half-Yearly">
                <option value="H1">H1 (Apr - Sep)</option>
                <option value="H2">H2 (Oct - Mar)</option>
              </optgroup>
              <optgroup label="Quarterly">
                <option value="Q1">Q1 (Apr - Jun)</option>
                <option value="Q2">Q2 (Jul - Sep)</option>
                <option value="Q3">Q3 (Oct - Dec)</option>
                <option value="Q4">Q4 (Jan - Mar)</option>
              </optgroup>
              <optgroup label="Monthly">
                <option value="THIS_MONTH">Current Month</option>
                <option value="LAST_MONTH">Previous Month</option>
                <option value="MONTH_4">April</option>
                <option value="MONTH_5">May</option>
                <option value="MONTH_6">June</option>
                <option value="MONTH_7">July</option>
                <option value="MONTH_8">August</option>
                <option value="MONTH_9">September</option>
                <option value="MONTH_10">October</option>
                <option value="MONTH_11">November</option>
                <option value="MONTH_12">December</option>
                <option value="MONTH_1">January</option>
                <option value="MONTH_2">February</option>
                <option value="MONTH_3">March</option>
              </optgroup>
              <optgroup label="Custom">
                <option value="CUSTOM">Custom Date Range</option>
              </optgroup>
            </select>
          </div>

          {/* Custom Date Pickers */}
          {selectedPeriod === "CUSTOM" && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateRange.from}
                onChange={(e) => setDateRange((prev) => ({ ...prev, from: e.target.value }))}
                className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium dark:border-slate-800 dark:bg-slate-900"
              />
              <span className="text-xs text-slate-400">to</span>
              <input
                type="date"
                value={dateRange.to}
                onChange={(e) => setDateRange((prev) => ({ ...prev, to: e.target.value }))}
                className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium dark:border-slate-800 dark:bg-slate-900"
              />
            </div>
          )}

          {/* Refresh Button */}
          <button
            onClick={loadAll}
            disabled={loading}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            title="Refresh reports"
          >
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />
          </button>

          {/* Quick CA Audit Pack Download */}
          <button
            onClick={handleDownloadXlsx}
            disabled={exportLoading}
            className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            title="Download CA-Ready Multi-Sheet Excel File"
          >
            <FileSpreadsheet className="h-4 w-4" />
            <span>{exportLoading ? "Generating..." : "Download CA File (.XLSX)"}</span>
          </button>
        </div>
      </div>

      {/* Historical Data Warning Banner */}
      {warningData?.hasUnpostedLegacyData && activeTab !== "backfill" && (
        <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50/80 p-4 text-amber-900 shadow-sm dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <div className="font-semibold text-sm">Some older records aren't in these reports yet</div>
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {warningData.message || "Some invoices, payments or expenses were saved before automatic accounting entries were switched on. Run the Historical Backfill once to include them; it is safe to repeat and never changes the original records."}
                </p>
                {warningData.unpostedCounts && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs font-medium">
                    {warningData.unpostedCounts.invoices ? <span>{warningData.unpostedCounts.invoices} invoice{warningData.unpostedCounts.invoices === 1 ? "" : "s"}</span> : null}
                    {warningData.unpostedCounts.payments ? <span>{warningData.unpostedCounts.payments} payment{warningData.unpostedCounts.payments === 1 ? "" : "s"}</span> : null}
                    {warningData.unpostedCounts.expenses ? <span>{warningData.unpostedCounts.expenses} expense{warningData.unpostedCounts.expenses === 1 ? "" : "s"}</span> : null}
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setActiveTab("backfill")}
              className="shrink-0 self-start rounded-xl bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-amber-700"
            >
              Review &amp; fix
            </button>
          </div>
        </div>
      )}

      {/* Tabs Bar */}
      <div className="flex overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {[
          { key: "overview", label: "Overview", icon: BarChart3 },
          { key: "profit_loss", label: "Profit & Loss", icon: TrendingUp },
          { key: "balance_sheet", label: "Balance Sheet", icon: Scale },
          { key: "trial_balance", label: "Trial Balance", icon: BookOpen },
          { key: "bank_book", label: "Bank & Cash Book", icon: Landmark },
          { key: "ledger", label: "Account Ledger", icon: FileText },
          { key: "backfill", label: "Historical Backfill", icon: ShieldCheck },
          { key: "bank_accounts", label: "Bank Accounts", icon: Building2 },
          { key: "reconciliation", label: "Bank Reconciliation", icon: CheckCircle2 },
          { key: "export", label: "Accountant Export Pack", icon: Download },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={"flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition whitespace-nowrap " +
                (isActive
                  ? "border-brand-600 text-brand-600 dark:border-brand-400 dark:text-brand-400"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
              }
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: OVERVIEW */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Revenue / Income</span>
              <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">
                {money(plData?.income?.total)}
              </div>
              <div className="mt-1 flex items-center text-xs text-emerald-600">
                <ArrowUpRight className="h-3.5 w-3.5" /> Direct from double-entry sales
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Operating Expenses</span>
              <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">
                {money(plData?.expenses?.total)}
              </div>
              <div className="mt-1 flex items-center text-xs text-rose-500">
                <ArrowDownRight className="h-3.5 w-3.5" /> Excluding GST tax assets
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Net Profit / (Loss)</span>
              <div className={"mt-2 text-2xl font-bold " + ((plData?.netProfitMinor || 0) >= 0 ? "text-emerald-600" : "text-rose-600")}>
                {money(plData?.netProfit)}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {(plData?.netProfitMinor || 0) >= 0 ? "Profitable period" : "Net operating loss"}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Balance Sheet Status</span>
              <div className="mt-2 flex items-center gap-2 text-2xl font-bold text-slate-900 dark:text-white">
                {!bsData?.totals ? (
                  <span className="flex items-center gap-1.5 text-base text-slate-500 font-semibold">
                    <AlertTriangle className="h-5 w-5" /> Not available
                  </span>
                ) : bsData.totals.isBalanced ? (
                  <span className="flex items-center gap-1.5 text-base text-emerald-600 font-semibold">
                    <CheckCircle2 className="h-5 w-5" /> Balanced (A = L + E)
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-base text-rose-600 font-semibold">
                    <XCircle className="h-5 w-5" /> Discrepancy
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {bsData?.totals
                  ? <>Assets: {money(bsData.totals.totalAssets)} | Liab+Eq: {money(bsData.totals.totalLiabilitiesAndEquity)}</>
                  : "The balance sheet could not be loaded. Use refresh, or check the selected company."}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PROFIT & LOSS */}
      {activeTab === "profit_loss" && plData && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                Statement of Profit and Loss
              </h2>
              <span className="text-xs text-slate-500">{plData.period?.periodLabel}</span>
            </div>
            <button
              onClick={() => handleDownloadCsv("profit-loss")}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            >
              <Download className="h-3.5 w-3.5" /> Export P&L CSV
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
                <tr>
                  <th className="px-5 py-3">Account</th>
                  <th className="px-4 py-3">Code</th>
                  {plData.isConsolidated ? (
                    <>
                      <th className="px-4 py-3 text-right">TOOR (INR)</th>
                      <th className="px-4 py-3 text-right">Goldhawk (INR)</th>
                      <th className="px-5 py-3 text-right">Consolidated (INR)</th>
                    </>
                  ) : (
                    <th className="px-5 py-3 text-right">Amount (INR)</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                <tr className="bg-slate-50/70 font-bold text-slate-800 dark:bg-slate-800/30 dark:text-slate-200">
                  <td colSpan={plData.isConsolidated ? 5 : 3} className="px-5 py-2.5">
                    1. REVENUE / INCOME
                  </td>
                </tr>
                {plData.income?.accounts.map((acc) => (
                  <tr key={acc.code} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="px-5 py-3">
                      <button
                        onClick={() => drillDownToAccount(acc.accountId)}
                        className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                      >
                        {acc.name}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{acc.code}</td>
                    {plData.isConsolidated ? (
                      <>
                        <td className="px-4 py-3 text-right font-medium">{money(acc.toorAmount)}</td>
                        <td className="px-4 py-3 text-right font-medium">{money(acc.goldhawkAmount)}</td>
                        <td className="px-5 py-3 text-right font-semibold">{money(acc.totalAmount)}</td>
                      </>
                    ) : (
                      <td className="px-5 py-3 text-right font-semibold">{money(acc.amount)}</td>
                    )}
                  </tr>
                ))}
                <tr className="border-t-2 font-bold text-slate-900 dark:text-white">
                  <td colSpan={2} className="px-5 py-3">Total Income</td>
                  {plData.isConsolidated ? (
                    <>
                      <td className="px-4 py-3 text-right">{money(plData.income?.toorTotal)}</td>
                      <td className="px-4 py-3 text-right">{money(plData.income?.goldhawkTotal)}</td>
                      <td className="px-5 py-3 text-right text-emerald-600">{money(plData.income?.total)}</td>
                    </>
                  ) : (
                    <td className="px-5 py-3 text-right text-emerald-600">{money(plData.income?.total)}</td>
                  )}
                </tr>

                <tr className="bg-slate-50/70 font-bold text-slate-800 dark:bg-slate-800/30 dark:text-slate-200">
                  <td colSpan={plData.isConsolidated ? 5 : 3} className="px-5 py-2.5">
                    2. EXPENSES
                  </td>
                </tr>
                {plData.expenses?.accounts.map((acc) => (
                  <tr key={acc.code} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="px-5 py-3">
                      <button
                        onClick={() => drillDownToAccount(acc.accountId)}
                        className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                      >
                        {acc.name}
                      </button>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{acc.code}</td>
                    {plData.isConsolidated ? (
                      <>
                        <td className="px-4 py-3 text-right font-medium">{money(acc.toorAmount)}</td>
                        <td className="px-4 py-3 text-right font-medium">{money(acc.goldhawkAmount)}</td>
                        <td className="px-5 py-3 text-right font-semibold">{money(acc.totalAmount)}</td>
                      </>
                    ) : (
                      <td className="px-5 py-3 text-right font-semibold">{money(acc.amount)}</td>
                    )}
                  </tr>
                ))}
                <tr className="border-t-2 font-bold text-slate-900 dark:text-white">
                  <td colSpan={2} className="px-5 py-3">Total Expenses</td>
                  {plData.isConsolidated ? (
                    <>
                      <td className="px-4 py-3 text-right">{money(plData.expenses?.toorTotal)}</td>
                      <td className="px-4 py-3 text-right">{money(plData.expenses?.goldhawkTotal)}</td>
                      <td className="px-5 py-3 text-right text-rose-500">{money(plData.expenses?.total)}</td>
                    </>
                  ) : (
                    <td className="px-5 py-3 text-right text-rose-500">{money(plData.expenses?.total)}</td>
                  )}
                </tr>

                <tr className="bg-slate-100/80 font-bold text-base dark:bg-slate-800/80">
                  <td colSpan={2} className="px-5 py-4">NET PROFIT / (LOSS)</td>
                  {plData.isConsolidated ? (
                    <>
                      <td className="px-4 py-4 text-right">{money(plData.toorNetProfit)}</td>
                      <td className="px-4 py-4 text-right">{money(plData.goldhawkNetProfit)}</td>
                      <td className={"px-5 py-4 text-right " + ((plData.netProfitMinor || 0) >= 0 ? "text-emerald-600" : "text-rose-600")}>
                        {money(plData.netProfit)}
                      </td>
                    </>
                  ) : (
                    <td className={"px-5 py-4 text-right " + ((plData.netProfitMinor || 0) >= 0 ? "text-emerald-600" : "text-rose-600")}>
                      {money(plData.netProfit)}
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: BALANCE SHEET */}
      {activeTab === "balance_sheet" && bsData && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                Balance Sheet
              </h2>
              <span className="text-xs text-slate-500">As of {bsData.asOfDate}</span>
            </div>
            <button
              onClick={() => handleDownloadCsv("balance-sheet")}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            >
              <Download className="h-3.5 w-3.5" /> Export Balance Sheet CSV
            </button>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between border-b pb-3 dark:border-slate-800">
                <h3 className="font-bold text-base text-slate-900 dark:text-white">ASSETS</h3>
                <span className="font-bold text-emerald-600">{money(bsData.totals?.totalAssets)}</span>
              </div>
              <div className="mt-4 space-y-4">
                {bsData.assets?.accounts?.map((acc) => (
                  <div key={acc.code} className="flex justify-between text-sm">
                    <div>
                      <button
                        onClick={() => drillDownToAccount(acc.accountId)}
                        className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                      >
                        {acc.name}
                      </button>
                      <span className="ml-2 font-mono text-xs text-slate-400">({acc.group})</span>
                    </div>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{money(acc.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between border-b pb-3 dark:border-slate-800">
                <h3 className="font-bold text-base text-slate-900 dark:text-white">LIABILITIES & EQUITY</h3>
                <span className="font-bold text-brand-600">{money(bsData.totals?.totalLiabilitiesAndEquity)}</span>
              </div>
              <div className="mt-4 space-y-4">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">Liabilities</div>
                {bsData.liabilities?.accounts?.map((acc) => (
                  <div key={acc.code} className="flex justify-between text-sm">
                    <div>
                      <button
                        onClick={() => drillDownToAccount(acc.accountId)}
                        className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                      >
                        {acc.name}
                      </button>
                      <span className="ml-2 font-mono text-xs text-slate-400">({acc.group})</span>
                    </div>
                    <span className="font-semibold text-slate-800 dark:text-slate-200">{money(acc.amount)}</span>
                  </div>
                ))}

                <div className="pt-2 text-xs font-bold text-slate-400 uppercase tracking-wider">Equity & Earnings</div>
                {bsData.equity?.accounts?.map((acc) => (
                  <div key={acc.code} className="flex justify-between text-sm">
                    <span className="font-medium">{acc.name}</span>
                    <span className="font-semibold">{money(acc.amount)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-300">Current Period Earnings (Retained)</span>
                  <span className="font-semibold text-emerald-600">{money(bsData.equity?.retainedEarnings)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: TRIAL BALANCE */}
      {activeTab === "trial_balance" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Trial Balance</h2>
            <button
              onClick={() => handleDownloadCsv("trial-balance")}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            >
              <Download className="h-3.5 w-3.5" /> Export Trial Balance CSV
            </button>
          </div>

          {selectedEntity === "all" ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 space-y-4">
              <p className="max-w-xl mx-auto">
                Under Indian AS and ICAI statutory rules, Trial Balance accounts are maintained per registered corporate entity to ensure Debit = Credit integrity.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setSelectedEntity("TOOR")}
                  className="rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 transition"
                >
                  View THE OFFICE ON RENT (TOOR) Trial Balance
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedEntity("GOLDHAWK")}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 transition"
                >
                  View Goldhawk Infrabulls Trial Balance
                </button>
              </div>
            </div>
          ) : tbData ? (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-4 py-3">Code</th>
                    <th className="px-5 py-3">Account Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Debit (Closing)</th>
                    <th className="px-4 py-3 text-right">Credit (Closing)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {tbData.accounts?.map((acc) => (
                    <tr key={acc.code} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">{acc.code}</td>
                      <td className="px-5 py-3">
                        <button
                          onClick={() => drillDownToAccount(acc.accountId)}
                          className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                        >
                          {acc.name}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{acc.type}</td>
                      <td className="px-4 py-3 text-right font-medium">{money(acc.closing?.debit)}</td>
                      <td className="px-4 py-3 text-right font-medium">{money(acc.closing?.credit)}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-bold text-slate-900 dark:bg-slate-800/50 dark:text-white">
                    <td colSpan={3} className="px-5 py-3.5">TOTAL TRIAL BALANCE</td>
                    <td className="px-4 py-3.5 text-right text-emerald-600">{money(tbData.totals?.closing?.debit)}</td>
                    <td className="px-4 py-3.5 text-right text-emerald-600">{money(tbData.totals?.closing?.credit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}

      {/* TAB 5: BANK & CASH BOOK */}
      {activeTab === "bank_book" && bookData && (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setBookType("BANK")}
                className={"rounded-xl px-4 py-1.5 text-xs font-bold transition " +
                  (bookType === "BANK"
                    ? "bg-brand-600 text-white shadow-sm"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300")
                }
              >
                Bank Book / Bank Ledger
              </button>
              <button
                onClick={() => setBookType("CASH")}
                className={"rounded-xl px-4 py-1.5 text-xs font-bold transition " +
                  (bookType === "CASH"
                    ? "bg-brand-600 text-white shadow-sm"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300")
                }
              >
                Cash Book / Cash Ledger
              </button>
            </div>
            <button
              onClick={() => handleDownloadCsv(bookType === "CASH" ? "cash-book" : "bank-book")}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            >
              <Download className="h-3.5 w-3.5" /> Export {bookType === "CASH" ? "Cash" : "Bank"} Book CSV
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500 dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Entry #</th>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-5 py-3">Description</th>
                  <th className="px-4 py-3 text-right">Inflow (Debit)</th>
                  <th className="px-4 py-3 text-right">Outflow (Credit)</th>
                  <th className="px-5 py-3 text-right">Running Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                <tr className="bg-slate-50/50 text-xs font-semibold text-slate-600 dark:bg-slate-800/20 dark:text-slate-400">
                  <td colSpan={6} className="px-4 py-2.5">OPENING BALANCE</td>
                  <td className="px-5 py-2.5 text-right font-bold">{money(bookData.openingBalance)}</td>
                </tr>
                {bookData.transactions?.map((tx, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="px-4 py-3 text-xs">{new Date(tx.entryDate).toLocaleDateString("en-IN")}</td>
                    <td className="px-4 py-3 font-mono text-xs text-brand-600">{tx.entryNumber}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{tx.reference}</td>
                    <td className="px-5 py-3 text-slate-800 dark:text-slate-200">{tx.description}</td>
                    <td className="px-4 py-3 text-right font-medium text-emerald-600">{tx.debit > 0 ? money(tx.debit) : "-"}</td>
                    <td className="px-4 py-3 text-right font-medium text-rose-500">{tx.credit > 0 ? money(tx.credit) : "-"}</td>
                    <td className="px-5 py-3 text-right font-semibold">{money(tx.runningBalance)}</td>
                  </tr>
                ))}
                <tr className="bg-slate-50 font-bold text-slate-900 dark:bg-slate-800/50 dark:text-white">
                  <td colSpan={6} className="px-4 py-3.5">CLOSING BALANCE</td>
                  <td className="px-5 py-3.5 text-right text-brand-600">{money(bookData.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 6: ACCOUNT LEDGER */}
      {activeTab === "ledger" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-slate-500">Select Account:</span>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold dark:border-slate-800 dark:bg-slate-900"
            >
              {accounts.map((acc) => (
                <option key={acc._id} value={acc._id}>
                  {acc.code} - {acc.name} ({acc.type})
                </option>
              ))}
            </select>
          </div>

          {ledgerData && (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-500 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Entry #</th>
                    <th className="px-5 py-3">Description</th>
                    <th className="px-4 py-3 text-right">Debit (INR)</th>
                    <th className="px-4 py-3 text-right">Credit (INR)</th>
                    <th className="px-5 py-3 text-right">Running Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  <tr className="bg-slate-50/50 text-xs font-semibold text-slate-600 dark:bg-slate-800/20">
                    <td colSpan={5} className="px-4 py-2.5">OPENING BALANCE</td>
                    <td className="px-5 py-2.5 text-right font-bold">{money(ledgerData.openingBalance)}</td>
                  </tr>
                  {ledgerData.transactions?.map((tx, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                      <td className="px-4 py-3 text-xs">{new Date(tx.entryDate).toLocaleDateString("en-IN")}</td>
                      <td className="px-4 py-3 font-mono text-xs text-brand-600">{tx.entryNumber}</td>
                      <td className="px-5 py-3">{tx.description}</td>
                      <td className="px-4 py-3 text-right font-medium">{tx.debit > 0 ? money(tx.debit) : "-"}</td>
                      <td className="px-4 py-3 text-right font-medium">{tx.credit > 0 ? money(tx.credit) : "-"}</td>
                      <td className="px-5 py-3 text-right font-semibold">{money(tx.runningBalance)}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-bold text-slate-900 dark:bg-slate-800/50 dark:text-white">
                    <td colSpan={5} className="px-4 py-3.5">CLOSING BALANCE</td>
                    <td className="px-5 py-3.5 text-right text-brand-600">{money(ledgerData.closingBalance)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB: HISTORICAL BACKFILL */}
      {activeTab === "backfill" && (
        <BackfillTab selectedEntity={selectedEntity} onBackfillComplete={loadAll} />
      )}

      {/* TAB: BANK ACCOUNTS */}
      {activeTab === "bank_accounts" && (
        <BankAccountsTab selectedEntity={selectedEntity} />
      )}

      {/* TAB: BANK RECONCILIATION */}
      {activeTab === "reconciliation" && (
        <ReconciliationTab selectedEntity={selectedEntity} />
      )}

      {/* TAB 7: ACCOUNTANT EXPORT PACK */}
      {activeTab === "export" && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Accountant Export Pack</h2>
            <p className="mt-1 text-sm text-slate-500">
              Download clean, spreadsheet-ready CSV registers for tax filing, statutory audits, and management review.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                onClick={handleDownloadXlsx}
                disabled={exportLoading}
                className="flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
              >
                <FileSpreadsheet className="h-4 w-4" /> Download Complete CA Packet (Multi-Sheet Excel .xlsx)
              </button>
              <button
                onClick={() => handleDownloadCsv("all")}
                disabled={exportLoading}
                className="flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-50"
              >
                <Download className="h-4 w-4" /> Download Multi-Report Pack (Combined CSV)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { id: "trial-balance", title: "Trial Balance", desc: "Opening, period & closing balances for all ledger accounts" },
              { id: "profit-loss", title: "Profit & Loss Account", desc: "Detailed income and expense statement with net operating result" },
              { id: "balance-sheet", title: "Balance Sheet", desc: "Assets, liabilities, and owners equity as of selected period" },
              { id: "bank-book", title: "Bank Book / Ledger", desc: "Complete date-wise bank account inflows, outflows, and running balances" },
              { id: "cash-book", title: "Cash Book / Ledger", desc: "Complete date-wise cash receipts, disbursements, and running balances" },
              { id: "sales-register", title: "Sales & Invoices Register", desc: "Detailed customer invoices, POS, GST components, and payment status" },
              { id: "expense-register", title: "Expense Register", desc: "All operational expenses, vendor payments, and input GST credits" },
              { id: "receivables", title: "Customer Outstanding / Receivables", desc: "Debtors balances, unallocated advances, and aging totals" },
              { id: "gst-summary", title: "GST Summary (TOOR)", desc: "Monthly/Quarterly output GST liability, input tax credit, and net payable" },
            ].map((item) => (
              <div
                key={item.id}
                className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900"
              >
                <div>
                  <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-white">
                    <FileSpreadsheet className="h-4 w-4 text-brand-600" />
                    {item.title}
                  </div>
                  <p className="mt-2 text-xs text-slate-500 leading-relaxed">{item.desc}</p>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <button
                    onClick={() => handleDownloadCsv(item.id)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300"
                  >
                    <Download className="h-3.5 w-3.5" /> Download CSV
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Statutory Compliance Footer with Branding */}
      <div className="mt-8 flex flex-col items-center justify-between gap-3 border-t border-slate-200/80 pt-6 text-center text-xs text-slate-400 sm:flex-row sm:text-left dark:border-slate-800">
        <p>
          Strict double-entry general ledger books complying with Indian Accounting Standards (Ind AS).
        </p>
        <p className="font-medium text-slate-500 dark:text-slate-400">
          Enterprise Architecture &amp; Financial Engine <span className="font-semibold text-blue-600 dark:text-blue-400">Powered by NEMNIDHI</span>
        </p>
      </div>
    </div>
  );
};

export default AccountingReportsPage;
