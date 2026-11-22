const DEPLOYMENT_MODES = {
  SAAS: "SAAS",
  SELF_HOSTED: "SELF_HOSTED",
};

const MODULE_STATES = {
  ACTIVE: "ACTIVE",
  AVAILABLE: "AVAILABLE",
  REQUEST_REQUIRED: "REQUEST_REQUIRED",
  DISABLED: "DISABLED",
};

const MODULE_REQUEST_STATUSES = {
  PENDING: "PENDING",
  UNDER_REVIEW: "UNDER_REVIEW",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  COMPLETED: "COMPLETED",
};

const BUSINESS_MODELS = {
  PRODUCT: "PRODUCT",
  SERVICE: "SERVICE",
  TRADING: "TRADING",
  MANUFACTURING: "MANUFACTURING",
  PROJECT_BASED: "PROJECT_BASED",
  RECURRING: "RECURRING",
  MIXED: "MIXED",
};

const moduleCatalog = [
  { key: "customers", name: "Customers", description: "Manage customer profiles and financial activity.", category: "CORE", status: "IMPLEMENTED", dependencies: [], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "products_services", name: "Products & Services", description: "Maintain sellable products, services, pricing, HSN/SAC and inventory basics.", category: "CORE", status: "IMPLEMENTED", dependencies: [], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "invoices", name: "Invoices", description: "Create GST-aware invoices and track derived payment state.", category: "CORE", status: "IMPLEMENTED", dependencies: ["customers"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "payments", name: "Payments", description: "Immutable Payment and PaymentAllocation foundation.", category: "CORE", status: "IMPLEMENTED", dependencies: ["invoices"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "ledger", name: "Ledgers", description: "Customer and supplier financial ledger activity.", category: "CORE", status: "IMPLEMENTED", dependencies: ["payments"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "gst", name: "GST", description: "Indian GST calculation and reporting foundation.", category: "CORE", status: "IMPLEMENTED", dependencies: ["invoices"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "reports", name: "Reports", description: "Dashboard, financial and GST reporting.", category: "CORE", status: "IMPLEMENTED", dependencies: ["invoices"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "team", name: "Team", description: "Invite and manage staff users and roles.", category: "CORE", status: "IMPLEMENTED", dependencies: [], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "settings", name: "Settings", description: "Business profile, GST, integrations and account settings.", category: "CORE", status: "IMPLEMENTED", dependencies: [], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true, protected: true },
  { key: "audit", name: "Audit Logs", description: "Security and operational audit trail.", category: "CORE", status: "IMPLEMENTED", dependencies: [], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "quotations", name: "Quotations", description: "Quote lifecycle and quote-to-invoice conversion.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: ["customers", "products_services"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "inventory", name: "Inventory", description: "Stock, stock movements and inventory alerts.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: ["products_services"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "suppliers", name: "Suppliers", description: "Supplier profiles and payable relationships.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: [], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "purchases", name: "Purchases", description: "Record supplier purchases, GST snapshots and stock increase.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: ["suppliers", "inventory"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "sales_returns", name: "Sales Returns", description: "Customer returns with stock restoration and ledger adjustment.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: ["invoices", "inventory"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "credit_notes", name: "Credit Notes", description: "Issue immutable customer credit notes.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: ["invoices", "ledger"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "communications", name: "Communications & WhatsApp", description: "Reminder rules, message templates and provider delivery records.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: ["customers", "invoices"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "hr", name: "HR", description: "Employees, attendance and salary setup.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: ["team"], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "expenses", name: "Expenses", description: "Record operating expenses, GST recorded, payment status and expense reporting.", category: "BUSINESS", status: "IMPLEMENTED", dependencies: [], defaultEnabled: true, availableForSaas: true, availableForSelfHosted: true },
  { key: "order_management", name: "Orders", description: "Reusable sales order workflow from quotation to fulfilment to invoice.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["customers", "products_services", "invoices"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "projects_tasks", name: "Projects & Tasks", description: "Reusable project delivery and task assignment workflow.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["customers", "team"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "recurring_billing", name: "Recurring Billing", description: "Tenant business recurring invoice and renewal workflow.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["customers", "products_services", "invoices"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "appointments_scheduling", name: "Appointments", description: "Reusable appointment and staff scheduling workflow.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["customers", "team", "communications"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "production_job_work", name: "Production / Job Work", description: "Reusable production and job-work tracking tied to stock movements.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["products_services", "inventory"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "batch_expiry", name: "Batch & Expiry", description: "Reusable product batch, lot and expiry tracking foundation.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["products_services", "inventory"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "dispatch_fulfilment", name: "Dispatch / Fulfilment", description: "Reusable dispatch and delivery workflow layered on orders and invoices.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["order_management", "invoices"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "documents_approvals", name: "Documents & Approvals", description: "Reusable document approval workflow for business records.", category: "WORKFLOW", status: "IMPLEMENTED", dependencies: ["team", "audit"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
  { key: "projects", name: "Projects", description: "Project-based billing and delivery workflows.", category: "FUTURE", status: "REQUEST_REQUIRED", dependencies: ["customers"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isIndustrySpecific: true },
  { key: "scheduling", name: "Scheduling", description: "Appointment and field-service scheduling.", category: "FUTURE", status: "REQUEST_REQUIRED", dependencies: ["communications"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isIndustrySpecific: true },
  { key: "renewals", name: "Renewals", description: "Recurring renewal and contract reminder workflows.", category: "FUTURE", status: "REQUEST_REQUIRED", dependencies: ["communications"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isIndustrySpecific: true },
  { key: "advanced_reports", name: "Advanced Reports", description: "Advanced analytics and export packs.", category: "FUTURE", status: "REQUEST_REQUIRED", dependencies: ["reports"], defaultEnabled: false, availableForSaas: true, availableForSelfHosted: true, isAddOn: true },
];

const presets = {
  SERVICE: ["customers", "products_services", "quotations", "invoices", "payments", "ledger", "credit_notes", "expenses", "reports", "communications", "appointments_scheduling"],
  TRADING: ["customers", "products_services", "inventory", "suppliers", "purchases", "order_management", "invoices", "payments", "ledger", "sales_returns", "expenses", "gst", "reports"],
  MANUFACTURING: ["customers", "products_services", "inventory", "suppliers", "purchases", "order_management", "production_job_work", "batch_expiry", "dispatch_fulfilment", "invoices", "payments", "ledger", "sales_returns", "expenses", "gst", "reports", "advanced_reports"],
  PROJECT_BASED: ["customers", "quotations", "projects_tasks", "documents_approvals", "invoices", "payments", "ledger", "expenses", "reports", "communications"],
  RECURRING: ["customers", "products_services", "recurring_billing", "invoices", "payments", "ledger", "expenses", "communications", "reports"],
  CUSTOM: [],
};

const coreModuleKeys = moduleCatalog
  .filter((item) => item.category === "CORE" || item.protected)
  .map((item) => item.key);

const getDeploymentMode = () =>
  process.env.BILLSTACK_DEPLOYMENT_MODE === DEPLOYMENT_MODES.SELF_HOSTED
    ? DEPLOYMENT_MODES.SELF_HOSTED
    : DEPLOYMENT_MODES.SAAS;

// A self-hosted install belongs to one company: nobody on the internet may create a workspace on it.
// Team members are added by the owner from Team. BILLSTACK_ALLOW_SIGNUP=true reopens it (first setup only).
const isPublicSignupOpen = () =>
  getDeploymentMode() !== DEPLOYMENT_MODES.SELF_HOSTED || process.env.BILLSTACK_ALLOW_SIGNUP === "true";

module.exports = {
  BUSINESS_MODELS,
  DEPLOYMENT_MODES,
  MODULE_REQUEST_STATUSES,
  MODULE_STATES,
  coreModuleKeys,
  getDeploymentMode,
  isPublicSignupOpen,
  moduleCatalog,
  presets,
};
