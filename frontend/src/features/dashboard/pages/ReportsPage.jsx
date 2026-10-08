import PageHeader from "../../../components/ui/PageHeader";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { gstSummaryRequest, reportsSummaryRequest, getBusinessModulesRequest } from "../../auth/api";
import { authStore } from "../../../store/authStore";
import { isActiveModule, shouldShowWorkspaceNavigation } from "../../workspace/workspaceVisibility";
import { money, compactMoney, safeName, reportRows } from "../reportPresentation";
import "./reports.css";

const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "—";
const clientName = row => safeName(row.customerName || row.customerId?.name || row.customerDetails?.name || row._id, "Unknown client");
const Status = ({ value }) => <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${value === "partial" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-rose-500/10 text-rose-600 dark:text-rose-300"}`}>{value === "partial" ? "Partially paid" : "Unpaid"}</span>;
const amounts = entries => entries.map(([label, key]) => ({ label, numeric: true, cell: row => money(row[key]) }));
const configurations = {
  pending: { title: "Pending payments", module: "invoices", field: "pendingPayment", columns: [{ label: "Invoice", cell: row => <Link className="font-medium text-brand-600 hover:underline" to={`/dashboard/invoices/${row._id}`}>{row.invoiceNumber || "Invoice"}</Link> }, { label: "Client", cell: clientName }, { label: "Due date", cell: row => date(row.dueDate) }, ...amounts([["Amount", "grandTotal"], ["Balance", "balanceDue"]]), { label: "Status", cell: row => <Status value={row.paymentStatus} /> }] },
  customers: { title: "Client sales", module: "customers", field: "customerWiseSales", columns: [{ label: "Client", cell: clientName }, ...amounts([["Total sales", "totalSales"], ["Collected", "paidAmount"], ["Outstanding", "balanceDue"]])] },
  expenses: { title: "Expense report", module: "expenses", columns: [{ label: "Category", cell: row => safeName(row._id, "Uncategorized") }, ...amounts([["Total", "total"], ["Paid", "paid"], ["Unpaid", "unpaid"], ["GST", "gstRecorded"]])] },
  products: { title: "Item sales", module: "products_services", field: "productWiseSales", columns: [{ label: "Item / service", cell: row => safeName(row._id, "Unknown item") }, { label: "Quantity", numeric: true, cell: row => row.quantitySold }, ...amounts([["Revenue", "revenue"], ["Tax", "tax"]])] },
  purchases: { title: "Purchase report", module: "purchases", field: "purchaseReport", columns: [{ label: "Purchase", cell: row => row.purchaseNumber || "Purchase" }, { label: "Supplier", cell: row => safeName(row.supplierId?.supplierName, "Unknown supplier") }, { label: "Date", cell: row => date(row.purchaseDate) }, ...amounts([["Total", "totalAmount"], ["Paid", "paidAmount"]])] },
};

const ReportsPage = () => {
  const { business } = authStore();
  const [data, setData] = useState(null), [gstData, setGstData] = useState(null), [moduleData, setModuleData] = useState(null);
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const [tab, setTab] = useState("overview"), [query, setQuery] = useState({}), [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true), [gstLoading, setGstLoading] = useState(true), [error, setError] = useState(""), [gstError, setGstError] = useState("");
  const [hsnPage, setHsnPage] = useState(1);
  const showModule = key => isActiveModule(moduleData, key) && shouldShowWorkspaceNavigation(key, moduleData, business);
  const invalidRange = dateRange.from && dateRange.to && dateRange.from > dateRange.to;
  useEffect(() => {
    let current = true;
    setLoading(true); setError("");
    Promise.all([reportsSummaryRequest(query), getBusinessModulesRequest()]).then(([reports, modules]) => { if (current) { setData(reports); setModuleData(modules); } }).catch(err => { if (current) setError(err.response?.data?.message || "Unable to load reports. Please retry."); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [query, refresh]);
  useEffect(() => {
    let current = true;
    setHsnPage(1);
    if (invalidRange) { setGstLoading(false); return; }
    setGstLoading(true); setGstError("");
    gstSummaryRequest(dateRange).then(gst => { if (current) setGstData(gst); }).catch(err => { if (current) setGstError(err.response?.data?.message || "Unable to load GST. Please retry."); }).finally(() => { if (current) setGstLoading(false); });
    return () => { current = false; };
  }, [dateRange.from, dateRange.to, refresh]);
  const chartRows = useMemo(() => (data?.monthlySales || []).slice(0, 12).reverse().map(row => ({ month: `${row._id.month}/${String(row._id.year).slice(-2)}`, totalSales: row.totalSales, paidAmount: row.paidAmount })), [data]);
  const tabs = [{ key: "overview", title: "Overview" }, ...Object.entries(configurations).filter(([, item]) => showModule(item.module)).map(([key, item]) => ({ key, title: item.title })), { key: "gst", title: "GST details" }];
  const activeTab = tabs.some(item => item.key === tab) ? tab : "overview";
  const changePage = (key, page, size) => setQuery(current => ({ ...current, [`${key}Page`]: page, [`${key}Size`]: size }));
  const openDetail = key => { changePage(key, 1, 10); setTab(key); };
  const dataset = (key, preview = false) => {
    const config = configurations[key];
    const rows = key === "expenses" ? data.expenseReport?.categoryWiseExpenses || [] : data[config.field] || [];
    const footer = key === "expenses" && data.expenseReport ? <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">{[["Total", "totalExpenses"], ["Paid", "totalPaidExpenses"], ["Unpaid", "totalUnpaidExpenses"], ["GST", "totalExpenseGstRecorded"]].map(([label, field]) => <span key={field}>{label}: {money(data.expenseReport[field])}</span>)}</div> : null;
    return <ReportTable key={key} {...config} rows={rows} preview={preview} pagination={data.pagination?.[key]} loading={loading} onPage={(page, size) => changePage(key, page, size)} onViewAll={() => openDetail(key)} footer={footer} />;
  };
  return <div className="mx-auto max-w-[1500px] space-y-4 pb-6">
    <PageHeader kicker="Finance" title="Reports / GST" description="Sales, collections, outstanding balances and expenses." />
    <section aria-label="GST summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">{[["Taxable sales", "taxableValue"], ["CGST", "cgst"], ["SGST", "sgst"], ["IGST", "igst"], ["Total GST", "totalGst"]].map(([label, key]) => <Metric key={key} label={label} value={gstData ? money(gstData.sales?.[key]) : "—"} />)}</section>
    <section className="panel p-4">
      <div className="flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 text-xs font-medium">GST from<input type="date" value={dateRange.from} onChange={event => setDateRange(current => ({ ...current, from: event.target.value }))} className="field mt-1 py-2" /></label><label className="min-w-0 flex-1 text-xs font-medium">GST to<input type="date" value={dateRange.to} onChange={event => setDateRange(current => ({ ...current, to: event.target.value }))} className="field mt-1 py-2" /></label><button type="button" disabled={loading || gstLoading} onClick={() => setRefresh(value => value + 1)} className="inline-flex min-h-10 items-center gap-2 rounded-xl border px-3 text-sm disabled:opacity-50" style={{ borderColor: "var(--panel-border)" }}><RefreshCw size={15} className={loading || gstLoading ? "animate-spin" : ""} />Refresh</button></div>
      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>Date range applies to GST only. Sales and collection reports cover all dates.</p>
      {invalidRange ? <p role="alert" className="mt-2 text-sm text-rose-600">From date must be on or before To date.</p> : gstError ? <p role="alert" className="mt-2 text-sm text-rose-600">{gstError}</p> : null}
      {gstLoading ? <p role="status" className="mt-2 text-xs">Updating GST report…</p> : null}
      <nav aria-label="Report sections" className="segmented no-scrollbar mt-3">{tabs.map(item => <button type="button" key={item.key} aria-pressed={activeTab === item.key} onClick={() => { if (item.key === "overview") setQuery({}); setTab(item.key); }} className={`segmented-item ${activeTab === item.key ? "is-active" : ""}`}>{item.title}</button>)}</nav>
    </section>
    {error ? <p role="alert" className="text-sm text-rose-600">{error} Use Refresh to retry.</p> : null}
    {loading ? <p role="status" className="text-sm" style={{ color: "var(--text-muted)" }}>Updating reports…</p> : null}
    {data && activeTab === "overview" ? <>
      <section className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"><Card title="Monthly sales"><div className="h-[280px] min-w-0">{chartRows.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={chartRows} margin={{ left: 0, right: 8 }}><CartesianGrid stroke="rgba(148,163,184,0.25)" vertical={false} /><XAxis dataKey="month" stroke="#64748b" tick={{ fontSize: 11 }} /><YAxis stroke="#64748b" tickFormatter={compactMoney} tick={{ fontSize: 11 }} /><Tooltip formatter={money} /><Bar dataKey="totalSales" name="Sales" fill="#2563eb" radius={[5, 5, 0, 0]} /><Bar dataKey="paidAmount" name="Collected" fill="#10b981" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>No monthly sales yet.</div>}</div></Card><Card title="Collection summary"><div className="grid grid-cols-2 gap-3 lg:grid-cols-1">{[["Total sales", data.collectionSummary?.totalSales], ["Collected", data.collectionSummary?.paidAmount], ["Outstanding", data.collectionSummary?.unpaidAmount], ["Operating difference", data.profitReport?.netOperatingDifference]].map(([label, value]) => <div key={label} className="border-b pb-2 last:border-0" style={{ borderColor: "var(--panel-border)" }}><p className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</p><p className="mt-1 font-semibold tabular-nums">{value == null ? "—" : money(value)}</p></div>)}</div><p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>Operating difference is sales less total expenses, not cash in hand.</p></Card></section>
      {["pending", "customers", "expenses"].filter(key => showModule(configurations[key].module)).map(key => dataset(key, true))}
    </> : null}
    {data && configurations[activeTab] && showModule(configurations[activeTab].module) ? dataset(activeTab) : null}
    {activeTab === "gst" ? <Card title="GST details"><p className="mb-3 text-sm">Input GST: {money(gstData?.purchases?.totalGst)}. Cancelled invoices are excluded.</p><p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>All-date invoice tax: {money(data?.taxReport?.totalTaxCollected)} · Invoice subtotal before discounts: {money(data?.taxReport?.taxableSales)}</p><ReportTable title="HSN/SAC breakdown" rows={Object.entries(gstData?.hsnSacSummary || {}).map(([code, value]) => ({ code, value }))} columns={[{ label: "HSN/SAC", cell: row => row.code }, { label: "Taxable value", numeric: true, cell: row => money(row.value) }]} localPage={hsnPage} onPage={setHsnPage} loading={gstLoading} /></Card> : null}
  </div>;
};
const Card = ({ title, children }) => <section className="min-w-0 rounded-2xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><h3 className="text-base font-semibold">{title}</h3><div className="mt-3">{children}</div></section>;
const Metric = ({ label, value }) => <div className="panel stat-card min-w-0"><p className="stat-label">{label}</p><p className="mt-1.5 break-words text-lg font-bold tabular-nums">{value}</p></div>;
const ReportTable = ({ title, rows, columns, preview = false, pagination, loading, onPage, onViewAll, footer, localPage }) => {
  const meta = pagination || { total: rows.length, page: localPage || 1, limit: 10, totalPages: Math.max(1, Math.ceil(rows.length / 10)) };
  const displayed = reportRows(rows, meta, preview, Boolean(pagination));
  return <section aria-label={title} aria-busy={loading} className="min-w-0 rounded-2xl border" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"><h3 className="text-sm font-semibold">{title} <span className="font-normal" style={{ color: "var(--text-muted)" }}>({meta.total})</span></h3>{preview && meta.total > 5 ? <button type="button" disabled={loading} onClick={onViewAll} className="text-xs font-medium text-brand-600 disabled:opacity-50">View all {title.toLowerCase()} →</button> : null}</div>
    <table className="reports-table block w-full table-fixed text-left text-sm md:table"><thead className="hidden bg-slate-500/5 text-xs md:table-header-group"><tr>{columns.map(column => <th key={column.label} className={`px-4 py-2 font-medium ${column.numeric ? "report-numeric text-right" : ""}`}>{column.label}</th>)}</tr></thead><tbody className="block md:table-row-group">{displayed.map((row, index) => <tr key={row._id || row.code || index} className="grid grid-cols-2 gap-x-3 gap-y-2 border-t px-4 py-3 md:table-row md:p-0" style={{ borderColor: "var(--panel-border)" }}>{columns.map(column => <td key={column.label} className={`block min-w-0 break-words md:table-cell md:px-4 md:py-2 ${column.numeric ? "report-numeric tabular-nums md:text-right" : ""}`}><span className="report-cell-label mb-0.5 block text-xs md:hidden" style={{ color: "var(--text-muted)" }}>{column.label}</span>{column.cell(row)}</td>)}</tr>)}</tbody></table>
    {!displayed.length ? <p className="px-4 py-5 text-sm" style={{ color: "var(--text-muted)" }}>No records available.</p> : null}
    {footer ? <div className="border-t px-4 py-3" style={{ borderColor: "var(--panel-border)" }}>{footer}</div> : null}
    {!preview && meta.total > 0 ? <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs" style={{ borderColor: "var(--panel-border)" }}><div className="flex items-center gap-2"><span>{(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)} of {meta.total}</span>{pagination ? <label>Rows <select aria-label={`${title} rows per page`} disabled={loading} value={meta.limit} onChange={event => onPage(1, Number(event.target.value))} className="rounded border bg-transparent p-1">{[10, 25, 50].map(size => <option key={size}>{size}</option>)}</select></label> : null}</div><div className="flex gap-2"><button type="button" disabled={loading || meta.page <= 1} onClick={() => onPage(meta.page - 1, meta.limit)} className="min-h-9 rounded-lg border px-3 disabled:opacity-40">Previous</button><span className="self-center">{meta.page} / {meta.totalPages}</span><button type="button" disabled={loading || meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1, meta.limit)} className="min-h-9 rounded-lg border px-3 disabled:opacity-40">Next</button></div></div> : null}
  </section>;
};
export default ReportsPage;
