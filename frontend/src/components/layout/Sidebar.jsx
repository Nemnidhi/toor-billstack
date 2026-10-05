import { NavLink, matchPath, useLocation } from "react-router-dom";
import { createPortal } from "react-dom";
import {
  BarChart3,
  BellRing,
  Boxes,
  Building2,
  CalendarCheck2,
  ChevronRight,
  ClipboardList,
  FileText,
  LayoutDashboard,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  ReceiptIndianRupee,
  RefreshCw,
  RotateCcw,
  Settings,
  ShoppingBag,
  ListChecks,
  Users,
  UserRound,
  WalletCards,
  X,
} from "lucide-react";
import { useState } from "react";
import { useEffect } from "react";
import { authStore } from "../../store/authStore";
import { uiStore } from "../../store/uiStore";
import { getBusinessModulesRequest } from "../../features/auth/api";
import { NAV_GROUPS, ROUTE_MODULES, isActiveModule, isRealEstateSelfHostedWorkspace, isSelfHostedWorkspace, productLabelForWorkspace, shouldShowWorkspaceNavigation } from "../../features/workspace/workspaceVisibility";

const navItems = [
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard, matches: ["/dashboard"], end: true, group: "core" },
  { label: "Customers", to: "/dashboard/customers", icon: UserRound, matches: ["/dashboard/customers"], group: "core" },
  { label: "Invoices", to: "/dashboard/invoices", icon: ReceiptIndianRupee, matches: ["/dashboard/invoices", "/dashboard/invoices/:invoiceId"], group: "core" },
  { label: "Quotations", to: "/dashboard/quotes", icon: FileText, matches: ["/dashboard/quotes"], group: "sales" },
  { label: "Credit Notes", to: "/dashboard/credit-notes", icon: WalletCards, matches: ["/dashboard/credit-notes"], group: "sales" },
  { label: "Sales Returns", to: "/dashboard/sales-returns", icon: RotateCcw, matches: ["/dashboard/sales-returns"], group: "sales" },
  { label: "Products / Inventory", to: "/dashboard/products", icon: Boxes, matches: ["/dashboard/products"], group: "inventory", adaptiveLabel: "products" },
  { label: "Suppliers", to: "/dashboard/suppliers", icon: Building2, matches: ["/dashboard/suppliers"], group: "inventory" },
  { label: "Purchases", to: "/dashboard/purchases", icon: ShoppingBag, matches: ["/dashboard/purchases"], group: "inventory" },
  { label: "Batch & Expiry", to: "/dashboard/batches", icon: Boxes, matches: ["/dashboard/batches"], group: "inventory" },
  { label: "Production / Job Work", to: "/dashboard/production-jobs", icon: PackageCheck, matches: ["/dashboard/production-jobs"], group: "inventory" },
  { label: "Dispatch / Fulfilment", to: "/dashboard/dispatches", icon: ClipboardList, matches: ["/dashboard/dispatches"], group: "inventory" },
  { label: "Orders", to: "/dashboard/orders", icon: ClipboardList, matches: ["/dashboard/orders"], group: "operations" },
  { label: "Projects", to: "/dashboard/projects", icon: FileText, matches: ["/dashboard/projects"], group: "operations" },
  { label: "Tasks", to: "/dashboard/tasks", icon: ListChecks, matches: ["/dashboard/tasks"], group: "operations" },
  { label: "Recurring Billing", to: "/dashboard/recurring-billing", icon: RefreshCw, matches: ["/dashboard/recurring-billing"], group: "operations", realEstateLabel: "Monthly Billing" },
  { label: "Appointments", to: "/dashboard/appointments", icon: CalendarCheck2, matches: ["/dashboard/appointments"], group: "operations", realEstateLabel: "Site Visits" },
  { label: "Documents & Approvals", to: "/dashboard/approvals", icon: FileText, matches: ["/dashboard/approvals"], group: "operations" },
  { label: "Expenses", to: "/dashboard/expenses", icon: ReceiptIndianRupee, matches: ["/dashboard/expenses"], group: "finance" },
  { label: "Reports / GST", to: "/dashboard/reports", icon: BarChart3, matches: ["/dashboard/reports"], group: "finance" },
  { label: "Communications", to: "/dashboard/communications", icon: BellRing, matches: ["/dashboard/communications"], group: "communications" },
  { label: "Team", to: "/dashboard/team", icon: Users, matches: ["/dashboard/team"], roles: ["owner", "admin"], group: "people" },
  { label: "HR", to: "/dashboard/hr/employees", icon: Users, matches: ["/dashboard/hr/employees"], requiresHR: true, group: "people" },
  { label: "Attendance", to: "/dashboard/hr/attendance", icon: CalendarCheck2, matches: ["/dashboard/hr/attendance"], requiresHR: true, group: "people" },
  { label: "Salary Setup", to: "/dashboard/hr/salary-setup", icon: WalletCards, matches: ["/dashboard/hr/salary-setup"], requiresHR: true, group: "people" },
  { label: "Subscription", to: "/dashboard/subscription", icon: WalletCards, matches: ["/dashboard/subscription"], group: "admin", saasOnly: true },
  { label: "Settings", to: "/dashboard/settings", icon: Settings, matches: ["/dashboard/settings"], group: "admin" },
];

const isRouteActive = (item, pathname) =>
  item.matches.some((pattern) => Boolean(matchPath({ path: pattern, end: true }, pathname)));

const canShowItem = (item, user) => {
  if (item.roles?.length && !item.roles.includes(user?.role)) return false;

  if (item.requiresHR) {
    return ["owner", "admin"].includes(user?.role) || user?.permissions?.canViewHR || user?.permissions?.canManageHR;
  }

  return true;
};

const activeStyle = {
  color: "white",
  background: "var(--accent)",
  boxShadow: "0 4px 14px color-mix(in srgb, var(--accent) 22%, transparent)",
};

const inactiveStyle = {
  color: "var(--text-muted)",
};

const Sidebar = () => {
  const { business, user } = authStore();
  const { closeSidebar, isSidebarOpen, sidebarCollapsed, toggleSidebarCollapsed } = uiStore();
  const location = useLocation();
  const [tooltip, setTooltip] = useState(null);
  const [moduleData, setModuleData] = useState(null);
  const [moduleStatus, setModuleStatus] = useState("loading");
  useEffect(() => {
    closeSidebar();
    setTooltip(null);
  }, [location.pathname, closeSidebar]);
  useEffect(() => {
    if (!isSidebarOpen) return;
    const drawer = document.getElementById("workspace-navigation");
    const previousFocus = document.activeElement;
    const media = window.matchMedia("(min-width: 1024px)");
    if (!media.matches) drawer?.querySelector('button[aria-label="Close navigation"]')?.focus();
    const onKeyDown = (event) => {
      if (media.matches) return;
      if (event.key === "Escape") closeSidebar();
      if (event.key === "Tab") {
        const controls = [...drawer.querySelectorAll("button, a[href]")].filter((node) => node.getClientRects().length);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const onResize = () => { if (media.matches) closeSidebar(); };
    document.addEventListener("keydown", onKeyDown);
    media.addEventListener("change", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      media.removeEventListener("change", onResize);
      if (!media.matches) previousFocus?.focus();
    };
  }, [isSidebarOpen, closeSidebar]);
  useEffect(() => { setTooltip(null); }, [sidebarCollapsed]);
  useEffect(() => {
    const clearTooltip = () => setTooltip(null);
    window.addEventListener("resize", clearTooltip);
    return () => window.removeEventListener("resize", clearTooltip);
  }, []);
  useEffect(() => {
    setModuleStatus("loading");
    getBusinessModulesRequest()
      .then((data) => {
        setModuleData(data);
        setModuleStatus("success");
      })
      .catch(() => {
        setModuleData(null);
        setModuleStatus("error");
      });
  }, []);

  const visibleItems = navItems.filter((item) => {
    if (!canShowItem(item, user)) return false;
    if (item.saasOnly && isSelfHostedWorkspace(moduleData, business)) return false;
    const moduleKey = item.moduleKey || ROUTE_MODULES[item.to];
    if (moduleStatus !== "success" && moduleKey) return false;
    return isActiveModule(moduleData, moduleKey) && shouldShowWorkspaceNavigation(moduleKey, moduleData, business);
  });
  const groupedItems = NAV_GROUPS.map((group) => ({
    ...group,
    items: visibleItems.filter((item) => item.group === group.key),
  })).filter((group) => group.items.length);

  const labelFor = (item) => {
    if (item.adaptiveLabel === "products") return productLabelForWorkspace(moduleData);
    if (isRealEstateSelfHostedWorkspace(moduleData, business) && item.realEstateLabel) return item.realEstateLabel;
    if (isRealEstateSelfHostedWorkspace(moduleData, business) && item.to === "/dashboard/customers") return "Clients";
    return item.label;
  };

  const isLicensedWorkspace = business?.deploymentMode === "SELF_HOSTED";

  const showTooltip = (event, label) => {
    if (!sidebarCollapsed || !window.matchMedia("(min-width: 1024px)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({ label, left: rect.right + 10, top: rect.top + rect.height / 2 });
  };

  return (
    <>
      {isSidebarOpen ? <button type="button" aria-label="Close navigation" onClick={closeSidebar} className="fixed inset-0 z-30 bg-black/60 lg:hidden" /> : null}
      <aside
        id="workspace-navigation"
        aria-label="Workspace navigation"
        className={`workspace-sidebar ${sidebarCollapsed ? "is-collapsed" : ""} ${isSidebarOpen ? "is-open" : ""}`}
      >
        <div className="sidebar-header">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold">B</div>
            <div className="sidebar-expanded-only min-w-0 flex-1">
              <p className="text-base font-bold tracking-tight">BillStack</p>
              <p className="truncate text-xs" style={{ color: "var(--text-muted)" }}>{business?.name || "Workspace"}</p>
            </div>
          </div>
          <button type="button" onClick={toggleSidebarCollapsed}
            className="sidebar-toggle hidden rounded-lg p-2 hover:bg-slate-500/10 lg:flex"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!sidebarCollapsed} aria-controls="workspace-navigation">
            {sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
          </button>
          <button type="button" onClick={closeSidebar} aria-label="Close navigation" className="rounded-lg p-2 lg:hidden"><X size={19} /></button>
        </div>
        <nav className="sidebar-nav no-scrollbar" aria-label="Main navigation" onScroll={() => setTooltip(null)}>
          {moduleStatus === "loading" ? <div role="status" aria-label="Loading workspace" className="space-y-2">
            <p className="sidebar-expanded-only text-xs" style={{ color: "var(--text-muted)" }}>Loading workspace</p>
            {[1, 2, 3, 4].map((item) => <div key={item} className="h-9 rounded-xl bg-slate-500/10" />)}
          </div> : null}
          {moduleStatus === "error" ? <p role="status" className="sidebar-expanded-only text-xs" style={{ color: "var(--text-muted)" }}>Workspace modules could not be loaded. Refresh to retry.</p> : null}
          {groupedItems.map((group) => (
            <div key={group.key} className="sidebar-group">
              <p className="sidebar-expanded-only px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--text-muted)" }}>{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isRouteActive(item, location.pathname);
                const label = labelFor(item);
                return <NavLink key={item.to} to={item.to} end={item.end}
                  onClick={() => { closeSidebar(); setTooltip(null); }}
                  onMouseEnter={(event) => showTooltip(event, label)} onMouseLeave={() => setTooltip(null)}
                  onFocus={(event) => showTooltip(event, label)} onBlur={() => setTooltip(null)}
                  onKeyDown={(event) => { if (event.key === "Escape") setTooltip(null); }}
                  aria-label={label} aria-describedby={tooltip?.label === label ? "sidebar-tooltip" : undefined}
                  aria-current={active ? "page" : undefined}
                  className="sidebar-link group hover:bg-slate-500/[.08]"
                  style={active ? { ...activeStyle, boxShadow: "none" } : inactiveStyle}>
                  <Icon size={19} strokeWidth={1.8} className="shrink-0" />
                  <span className="sidebar-expanded-only min-w-0 flex-1 truncate">{label}</span>
                  <ChevronRight size={15} className="sidebar-expanded-only shrink-0 opacity-40" />
                </NavLink>;
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-expanded-only mx-4 mt-3 rounded-xl border p-3.5" style={{ borderColor: "var(--panel-border)" }}>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--accent)" }}>
              {business?.billingEntityCode === "GOLDHAWK" ? "Goldhawk Billing" : "TOOR Billing"}
            </p>
          </div>
          <p className="mt-1 text-sm font-semibold truncate">{business?.name || "The Office On Rent"}</p>
          <div className="mt-2 flex items-center justify-between border-t pt-1.5" style={{ borderColor: "var(--panel-border)" }}>
            <span className="text-[10px] font-medium" style={{ color: "var(--text-muted)" }}>Active System</span>
            <span className="text-[10px] font-semibold tracking-wide" style={{ color: "var(--accent)" }}>Powered by NEMNIDHI</span>
          </div>
        </div>
      </aside>
      {tooltip ? createPortal(<div id="sidebar-tooltip" role="tooltip" className="sidebar-tooltip" style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.label}</div>, document.body) : null}
    </>
  );
};

export default Sidebar;
