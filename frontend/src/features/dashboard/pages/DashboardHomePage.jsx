import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ArrowRight, BadgeIndianRupee, Box, CalendarClock, CheckCircle2, CircleAlert, ClipboardList, Clock3, FilePlus2, ListChecks, PackagePlus, ReceiptText, RefreshCw, UsersRound, WalletCards } from "lucide-react";
import { ErrorState, LoadingState } from "../../../components/ui/PageState";
import { dashboardSummaryRequest, getBusinessModulesRequest } from "../../auth/api";
import { useAuth } from "../../auth/useAuth";
import { ROUTE_MODULES, isActiveModule, isRealEstateSelfHostedWorkspace, isSelfHostedWorkspace, productLabelForWorkspace, shouldShowDashboardSurface } from "../../workspace/workspaceVisibility";
import "./dashboard-home.css";

const money = (value) => value == null || !Number.isFinite(Number(value)) ? "—" :
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value));
// Indian short scale for chart axes: ₹70K, ₹1.4L, ₹2.5Cr (Intl's en-IN compact form prints "T").
const compactRupees = (value) => {
  const amount = Number(value || 0);
  const abs = Math.abs(amount);
  const fmt = (n, unit) => `₹${Number(n.toFixed(1)).toLocaleString("en-IN")}${unit}`;
  if (abs >= 1e7) return fmt(amount / 1e7, "Cr");
  if (abs >= 1e5) return fmt(amount / 1e5, "L");
  if (abs >= 1e3) return fmt(amount / 1e3, "K");
  return `₹${amount}`;
};
const date = (value) => !value || Number.isNaN(new Date(value).getTime()) ? "—" :
  new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const badgeTone = (status) => ({ paid: "bg-emerald-500/10 text-emerald-600", partial: "bg-amber-500/10 text-amber-700", unpaid: "bg-rose-500/10 text-rose-600" }[status] || "bg-slate-500/10 text-slate-500");
const Card = ({ title, description, action, children, className = "" }) => (
  <section className={`dashboard-card ${className}`} aria-label={title}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-semibold">{title}</h3>{description ? <p className="dashboard-muted mt-1 text-xs">{description}</p> : null}</div>
      {action}
    </div>
    {children}
  </section>
);

const DashboardHomePage = () => {
  const [data, setData] = useState(null);
  const [moduleData, setModuleData] = useState(null);
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const { business, user } = useAuth();
  useEffect(() => {
    let current = true;
    Promise.all([dashboardSummaryRequest(), getBusinessModulesRequest()])
      .then(([summary, modules]) => { if (current) { setData(summary); setModuleData(modules); } })
      .catch((err) => { if (current) setError(err.response?.data?.message || "Unable to load dashboard"); });
    return () => { current = false; };
  }, []);
  if (error) return <ErrorState title="Unable to load dashboard" description={error} />;
  if (!data) return <LoadingState title="Loading your business snapshot" description="Preparing sales, collections, and business activity." />;

  const metrics = data.metrics;
  const selfHosted = isSelfHostedWorkspace(moduleData, business);
  const realEstate = isRealEstateSelfHostedWorkspace(moduleData, business);
  const showModule = (key) => isActiveModule(moduleData, key) && shouldShowDashboardSurface(key, moduleData, business);
  const canOpen = (to) => {
    const path = to.split("?")[0];
    const route = Object.keys(ROUTE_MODULES).find((base) => path === base || path.startsWith(`${base}/`));
    return showModule(ROUTE_MODULES[route]) && !(selfHosted && path === "/dashboard/subscription");
  };
  const link = (label, to) => canOpen(to) ? <button type="button" onClick={() => navigate(to)} className="dashboard-text-action">{label}<ArrowRight size={14} /></button> : null;
  const quickActions = [
    { label: "Create invoice", icon: FilePlus2, to: "/dashboard/invoices?action=create", moduleKey: "invoices", primary: true },
    { label: "Create quotation", icon: BadgeIndianRupee, to: "/dashboard/quotes?action=create", moduleKey: "quotations" },
    { label: realEstate ? "Add client" : "Add customer", icon: UsersRound, to: "/dashboard/customers?action=create", moduleKey: "customers" },
    { label: `Add ${productLabelForWorkspace(moduleData).replace("Products / ", "").replace("Products & ", "").toLowerCase()}`, icon: PackagePlus, to: "/dashboard/products", moduleKey: "products_services" },
    { label: "Record expense", icon: ReceiptText, to: "/dashboard/expenses?action=create", moduleKey: "expenses", roles: ["owner", "admin", "accountant"] },
    { label: "New production job", icon: ClipboardList, to: "/dashboard/production-jobs", moduleKey: "production_job_work" },
  ].filter((item) => showModule(item.moduleKey) && (!item.roles || item.roles.includes(user?.role)));
  const paidExpenses = metrics.paidExpenses ?? metrics.monthlyPaidExpenses;
  const kpis = [
    { label: "Total sales", value: metrics.totalSales, detail: `${metrics.totalInvoices} issued invoices`, icon: BadgeIndianRupee, tone: "text-brand-600" },
    { label: "Payment collected", value: metrics.paidAmount, detail: "Payments applied to invoices", icon: WalletCards, tone: "text-emerald-600" },
    { label: "Net after expenses", value: metrics.netOperatingDifference, detail: `${money(paidExpenses)} paid expenses deducted`, icon: ReceiptText },
    { label: "Receivables", value: metrics.unpaidAmount, detail: "Awaiting collection", icon: Clock3, tone: "text-amber-600" },
    { label: "Overdue amount", value: metrics.overdueAmount, detail: `${metrics.overdueInvoices} invoices past due`, icon: CircleAlert, tone: metrics.overdueInvoices > 0 ? "text-rose-600" : "" },
  ];
  const workflow = data.workflowMetrics || metrics;
  const operations = [
    { label: realEstate ? "Monthly billing" : "Recurring billing", value: workflow.recurringDueSoon, detail: "Due now or within 7 days", icon: RefreshCw, to: "/dashboard/recurring-billing", moduleKey: "recurring_billing" },
    { label: "Active orders", value: workflow.activeOrders, detail: `${workflow.processingOrders || 0} in processing`, icon: ClipboardList, to: "/dashboard/orders", moduleKey: "order_management" },
    { label: "Overdue tasks", value: workflow.overdueTasks, detail: "Past due and not completed", icon: ListChecks, to: "/dashboard/tasks", moduleKey: "projects_tasks" },
    { label: realEstate ? "Site visits" : "Appointments", value: workflow.upcomingAppointments, detail: "Scheduled in the next 7 days", icon: CalendarClock, to: "/dashboard/appointments", moduleKey: "appointments_scheduling" },
    { label: "Production jobs", value: workflow.openProductionJobs, detail: "Open job-work items", icon: ClipboardList, to: "/dashboard/production-jobs", moduleKey: "production_job_work" },
    { label: "Expiring batches", value: workflow.expiringBatches, detail: "Within 30 days", icon: Box, to: "/dashboard/batches", moduleKey: "batch_expiry" },
    { label: "Pending dispatches", value: workflow.pendingDispatches, detail: "Not delivered yet", icon: PackagePlus, to: "/dashboard/dispatches", moduleKey: "dispatch_fulfilment" },
    { label: "Approvals", value: workflow.pendingApprovals, detail: "Awaiting a decision", icon: FilePlus2, to: "/dashboard/approvals", moduleKey: "documents_approvals" },
  ].filter((item) => showModule(item.moduleKey) && item.value != null);
  const checklist = (data.onboardingChecklist || []).filter((item) => !item.complete && item.to && canOpen(item.to));
  const showGettingStarted = !selfHosted && metrics.totalInvoices === 0 && checklist.length > 0;
  const alerts = [
    showModule("invoices") && metrics.overdueInvoices > 0 && { title: `${metrics.overdueInvoices} overdue invoices`, detail: `${money(metrics.overdueAmount)} awaiting collection`, to: "/dashboard/invoices", action: "Review invoices", icon: Clock3 },
    showModule("recurring_billing") && workflow.recurringDueSoon > 0 && { title: `${workflow.recurringDueSoon} ${realEstate ? "monthly bills" : "recurring bills"} due`, detail: "Due now or within 7 days", to: "/dashboard/recurring-billing", action: "Review billing", icon: RefreshCw },
    showModule("inventory") && showModule("products_services") && metrics.lowStockProducts > 0 && { title: `${metrics.lowStockProducts} low-stock items`, detail: "Review stock before the next sale", to: "/dashboard/products", action: "View inventory", icon: Box },
    !selfHosted && business?.subscription && !business.subscription.isAccessible && { title: "Subscription access needs attention", detail: "Some workspace features may be restricted", to: "/dashboard/subscription", action: "Open subscription", icon: CircleAlert },
  ].filter(Boolean);
  const recentInvoices = (data.recentInvoices || []).slice(0, 5);
  const chart = data.revenueChart || [];
  const hasSalesHistory = chart.some((item) => Number(item.revenue) > 0);
  // Both amounts refer to the same issued-invoice population, not unapplied receipts.
  const collectionRatio = metrics.totalSales > 0 && metrics.paidAmount >= 0 && metrics.paidAmount <= metrics.totalSales
    ? metrics.paidAmount / metrics.totalSales : null;

  return <div className="dashboard-home mx-auto max-w-[1500px] space-y-4 pb-4">
    <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div><h1 className="page-title mt-0">Good day, {user?.name?.split(" ")[0] || "there"}.</h1>
        <p className="page-subtitle">Here's the financial pulse for <span className="font-medium text-[color:var(--text-primary)]">{business?.name || "your business"}</span>.</p></div>
      <p className="dashboard-muted text-xs">{new Date().toLocaleDateString("en-IN", {weekday:"long",day:"numeric",month:"long",timeZone:"Asia/Kolkata"})}</p>
    </header>
    {quickActions.length ? <section aria-labelledby="dashboard-quick-actions" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
      <h3 id="dashboard-quick-actions" className="dashboard-muted text-xs font-semibold">Quick actions</h3>
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap">{quickActions.map(({label,icon:Icon,to,primary}) =>
        <button key={label} type="button" onClick={() => navigate(to)} className={`dashboard-action ${primary ? "bg-brand-600 text-white hover:bg-brand-700" : "dashboard-secondary"}`}><Icon size={16} className="shrink-0"/><span>{label}</span></button>)}</div>
    </section> : null}
    <section aria-label="Financial summary" className="dashboard-kpis">
      {kpis.map(({label,value,detail,icon:Icon,tone}) => <article key={label} className="dashboard-card">
        <div className="flex items-center justify-between gap-2"><h3 className="dashboard-muted text-xs font-medium">{label}</h3><Icon size={16} className="dashboard-muted shrink-0 opacity-60"/></div>
        <p className={`mt-3 text-2xl font-semibold tracking-tight tabular-nums ${tone || ""}`}>{money(value)}</p><p className="dashboard-muted mt-2 text-[11px]">{detail}</p>
      </article>)}
    </section>
    <div className="dashboard-columns">
      <Card title="Financial overview" description="Issued sales · last 12 months" action={<span className="dashboard-muted text-xs">Monthly</span>}>
        {hasSalesHistory ? <div className="mt-4 h-44 sm:h-48"><ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chart} margin={{top:8,right:8,left:0,bottom:0}}>
            <defs><linearGradient id="dashboardSalesFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#2563eb" stopOpacity={0.14}/><stop offset="100%" stopColor="#2563eb" stopOpacity={0}/></linearGradient></defs>
            <CartesianGrid vertical={false} stroke="rgba(100,116,139,.12)"/>
            <XAxis dataKey="month" tickLine={false} axisLine={false} minTickGap={24} tick={{fontSize:10,fill:"#64748b"}}/>
            <YAxis width={64} tickFormatter={compactRupees} tickLine={false} axisLine={false} tick={{fontSize:10,fill:"#64748b"}}/>
            <Tooltip formatter={(value) => [money(value),"Issued sales"]} contentStyle={{background:"var(--theme-surface-strong)",border:"1px solid var(--panel-border)",borderRadius:10,color:"var(--text-primary)",fontSize:12}}/>
            <Area name="Issued sales" type="monotone" dataKey="revenue" stroke="#2563eb" strokeWidth={2} fill="url(#dashboardSalesFill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer></div> : <div className="dashboard-empty"><p className="font-medium">No sales in this period</p><p className="dashboard-muted mt-1">Issued invoices will appear in your monthly overview.</p></div>}
      </Card>
      <Card title="Collection health" description="Balances across issued invoices">
        <dl className="mt-4 space-y-3 text-sm">
          {[["Receivables",metrics.unpaidAmount,"text-amber-600"],["Overdue",metrics.overdueAmount,metrics.overdueInvoices > 0 ? "text-rose-600" : ""],["Collected",metrics.paidAmount,"text-emerald-600"]].map(([label,value,tone]) =>
            <div key={label} className="flex items-center justify-between gap-3"><dt className="dashboard-muted">{label}</dt><dd className={`font-semibold tabular-nums ${tone}`}>{money(value)}</dd></div>)}
        </dl>
        {collectionRatio != null ? <div className="mt-4">
          <div className="mb-2 flex justify-between text-xs dashboard-muted"><span>Issued sales collected</span><span>{Math.round(collectionRatio * 100)}%</span></div>
          <div role="progressbar" aria-label="Issued sales collected" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(collectionRatio*100)} className="h-1.5 overflow-hidden rounded-full bg-slate-500/10"><div className="h-full rounded-full bg-emerald-500" style={{width:`${collectionRatio*100}%`}}/></div>
        </div> : <p className="dashboard-muted mt-4 text-xs">Collection progress appears once sales are issued.</p>}
        <div className="mt-4 border-t pt-3 text-xs" style={{borderColor:"var(--panel-border)"}}>{metrics.overdueInvoices > 0 ? link("Review receivables","/dashboard/invoices") : <span className="dashboard-muted">No overdue invoices. You're all caught up.</span>}</div>
      </Card>
    </div>
    <div className="dashboard-columns">
      <Card title="Recent invoices" description="Latest five invoices" action={link("View all","/dashboard/invoices")}>
        {recentInvoices.length ? <div className="mt-4">
          <div className="dashboard-invoice-head dashboard-muted"><span>Invoice / {realEstate ? "Client" : "Customer"}</span><span>Amount</span><span>Due</span><span>Status</span><span/></div>
          {recentInvoices.map((invoice) => <div key={invoice._id} className="dashboard-invoice-row">
            <div className="min-w-0"><p className="truncate font-semibold">{invoice.invoiceNumber || "Draft"}</p><p className="dashboard-muted mt-0.5 truncate text-xs">{invoice.customerId?.name || invoice.customerDetails?.name || "Customer"}</p></div>
            <p className="font-medium tabular-nums">{money(invoice.grandTotal)}</p><p className="dashboard-muted text-xs">{date(invoice.dueDate)}</p>
            <span className={`justify-self-start rounded-full px-2 py-1 text-[10px] font-medium capitalize ${badgeTone(invoice.status === "cancelled" ? "cancelled" : invoice.paymentStatus)}`}>{invoice.status === "cancelled" ? "cancelled" : invoice.paymentStatus || "Unknown"}</span>
            {link("Open",`/dashboard/invoices/${invoice._id}`)}
          </div>)}
        </div> : <div className="dashboard-empty"><p className="font-medium">No invoices yet</p><p className="dashboard-muted mt-1">Create your first invoice to start tracking sales.</p><div className="mt-3">{link("Create invoice","/dashboard/invoices?action=create")}</div></div>}
      </Card>
      <div className="min-w-0 space-y-4">
        <Card title="Action required">
          {alerts.length ? <div className="mt-3 divide-y divide-[color:var(--panel-border)]">{alerts.map(({title,detail,to,action,icon:Icon}) =>
            <div key={title} className="py-3 first:pt-0 last:pb-0"><div className="flex items-start gap-2"><Icon size={15} className="mt-0.5 shrink-0 text-amber-600"/><div className="min-w-0"><p className="text-xs font-semibold">{title}</p><p className="dashboard-muted mt-1 text-xs">{detail}</p><div className="mt-2">{link(action,to)}</div></div></div></div>)}</div> :
            <div className="mt-3 flex items-center gap-2 text-xs dashboard-muted"><CheckCircle2 size={16} className="shrink-0 text-emerald-600"/>You're all caught up. No action needed.</div>}
        </Card>
        {operations.length ? <Card title="Business activity"><div className="mt-3 divide-y divide-[color:var(--panel-border)]">
          {operations.map(({label,value,detail,icon:Icon,to}) => <button key={label} type="button" onClick={() => navigate(to)} className="dashboard-operation">
            <Icon size={16} className="shrink-0 text-brand-600"/><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{label}</span><span className="dashboard-muted mt-0.5 block text-[11px]">{detail}</span></span><strong className="text-lg tabular-nums">{value}</strong><ArrowRight size={13} className="dashboard-muted shrink-0"/>
          </button>)}
        </div></Card> : null}
        {showGettingStarted ? <Card title="Getting started" description="A few steps to start your workspace"><div className="mt-3 space-y-2">
          {checklist.map((item) => <div key={item.key}>{link(realEstate && item.key === "customer" ? "Add first client" : item.label,item.to)}</div>)}
        </div></Card> : null}
      </div>
    </div>
  </div>;
};
export default DashboardHomePage;
