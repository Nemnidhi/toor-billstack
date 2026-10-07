export const MODULE_STATES = {
  ACTIVE: "ACTIVE",
  AVAILABLE: "AVAILABLE",
  REQUEST_REQUIRED: "REQUEST_REQUIRED",
  DISABLED: "DISABLED",
};

export const ROUTE_MODULES = {
  "/dashboard/invoices": "invoices",
  "/dashboard/quotes": "quotations",
  "/dashboard/orders": "order_management",
  "/dashboard/credit-notes": "credit_notes",
  "/dashboard/sales-returns": "sales_returns",
  "/dashboard/customers": "customers",
  "/dashboard/products": "products_services",
  "/dashboard/suppliers": "suppliers",
  "/dashboard/purchases": "purchases",
  "/dashboard/expenses": "expenses",
  "/dashboard/reports": "reports",
  "/dashboard/communications": "communications",
  "/dashboard/projects": "projects_tasks",
  "/dashboard/tasks": "projects_tasks",
  "/dashboard/recurring-billing": "recurring_billing",
  "/dashboard/appointments": "appointments_scheduling",
  "/dashboard/production-jobs": "production_job_work",
  "/dashboard/batches": "batch_expiry",
  "/dashboard/dispatches": "dispatch_fulfilment",
  "/dashboard/approvals": "documents_approvals",
  "/dashboard/team": "team",
  "/dashboard/hr/employees": "hr",
  "/dashboard/hr/attendance": "hr",
  "/dashboard/hr/salary-setup": "hr",
};

export const NAV_GROUPS = [
  { key: "core", label: "Core" },
  { key: "sales", label: "Sales" },
  { key: "inventory", label: "Inventory & Procurement" },
  { key: "operations", label: "Operations" },
  { key: "finance", label: "Finance & Compliance" },
  { key: "communications", label: "Communications" },
  { key: "people", label: "People" },
  { key: "admin", label: "Admin" },
];

const REAL_ESTATE_CLIENT_HIDDEN_NAV_MODULES = new Set([
  "projects_tasks",
  "products_services",
  "inventory",
  "suppliers",
  "purchases",
  "sales_returns",
  "credit_notes",
  "appointments_scheduling",
  "order_management",
  "production_job_work",
  "batch_expiry",
  "dispatch_fulfilment",
  "documents_approvals",
  "hr",
  "team",
]);

const REAL_ESTATE_CLIENT_HIDDEN_DASHBOARD_MODULES = new Set([
  "projects_tasks",
  "products_services",
  "inventory",
  "suppliers",
  "purchases",
  "sales_returns",
  "credit_notes",
  "appointments_scheduling",
  "order_management",
  "production_job_work",
  "batch_expiry",
  "dispatch_fulfilment",
  "documents_approvals",
  "hr",
  "team",
]);

export const workspaceIndustryCode = (moduleData, business) =>
  String(moduleData?.businessProfile?.industryCode || business?.businessProfile?.industryCode || business?.industry || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export const isRealEstateSelfHostedWorkspace = (moduleData, business) =>
  isSelfHostedWorkspace(moduleData, business) && workspaceIndustryCode(moduleData, business) === "REAL_ESTATE";

export const isActiveModule = (moduleData, moduleKey) => {
  if (!moduleKey) return true;
  if (!moduleData) return false;
  const entry = (moduleData.catalog || []).find((item) => item.key === moduleKey);
  return entry?.state === MODULE_STATES.ACTIVE || entry?.active === true;
};

export const visibleModuleKeys = (moduleData) =>
  new Set((moduleData?.catalog || []).filter((item) => item.state === MODULE_STATES.ACTIVE || item.active === true).map((item) => item.key));

export const shouldShowWorkspaceNavigation = (moduleKey, moduleData, business) => {
  if (!moduleKey) return true;
  if (isRealEstateSelfHostedWorkspace(moduleData, business)) {
    return !REAL_ESTATE_CLIENT_HIDDEN_NAV_MODULES.has(moduleKey);
  }
  return true;
};

export const shouldShowDashboardSurface = (moduleKey, moduleData, business) => {
  if (!moduleKey) return true;
  if (isRealEstateSelfHostedWorkspace(moduleData, business)) {
    return !REAL_ESTATE_CLIENT_HIDDEN_DASHBOARD_MODULES.has(moduleKey);
  }
  return true;
};

export const productLabelForWorkspace = (moduleData) => {
  const industryCode = workspaceIndustryCode(moduleData);
  if (industryCode === "REAL_ESTATE") return "Services & Charges";
  const model = String(moduleData?.businessProfile?.businessModel || "").toUpperCase();
  const family = String(moduleData?.businessProfile?.operationalFamily || "").toUpperCase();
  if (model === "MANUFACTURING") return "Products / Materials";
  if (model === "SERVICE" || model === "PROJECT_BASED" || family === "SERVICE") return "Services & Items";
  if (model === "TRADING" || model === "PRODUCT") return "Products / Inventory";
  return "Products & Services";
};

export const isSelfHostedWorkspace = (moduleData, business) =>
  (moduleData?.deploymentMode || business?.deploymentMode) === "SELF_HOSTED";

export const shouldShowCommercialSettings = (moduleData, business) =>
  !isSelfHostedWorkspace(moduleData, business);

export const settingsVisibility = (moduleData, business) => ({
  inventory: isActiveModule(moduleData, "inventory") && shouldShowWorkspaceNavigation("inventory", moduleData, business),
  integrations: !isRealEstateSelfHostedWorkspace(moduleData, business),
  accountSecurity: !isRealEstateSelfHostedWorkspace(moduleData, business),
  commercial: shouldShowCommercialSettings(moduleData, business),
});
