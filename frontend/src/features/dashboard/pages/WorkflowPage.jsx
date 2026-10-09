import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FileText,
  Loader2,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { authStore } from "../../../store/authStore";
import GstLocationPreview from "../GstLocationPreview";
import { findSuggestion, groupSuggestions, suggestionValue, useServiceSuggestions } from "../serviceSuggestions";
import { isActiveModule, isRealEstateSelfHostedWorkspace, shouldShowWorkspaceNavigation } from "../../workspace/workspaceVisibility";
import {
  createAppointmentRequest,
  createApprovalDocumentRequest,
  createBatchRequest,
  createDispatchRequest,
  createOrderRequest,
  createProductionJobRequest,
  createProjectRequest,
  createRecurringProfileRequest,
  createTaskRequest,
  deleteRecurringProfileRequest,
  generateRecurringInvoiceRequest,
  getBusinessModulesRequest,
  listAppointmentsRequest,
  listApprovalDocumentsRequest,
  listBatchesRequest,
  listCustomersRequest,
  listDispatchesRequest,
  listOrdersRequest,
  listProductsRequest,
  listProductionJobsRequest,
  listProjectsRequest,
  listRecurringProfilesRequest,
  listTasksRequest,
  listTeamMembersRequest,
  updateAppointmentStatusRequest,
  updateApprovalDocumentStatusRequest,
  updateBatchStatusRequest,
  updateDispatchStatusRequest,
  updateOrderFulfilmentRequest,
  updateOrderStatusRequest,
  updateProductionJobStatusRequest,
  updateProjectRequest,
  updateRecurringStatusRequest,
  updateTaskRequest,
  convertOrderToInvoiceRequest,
} from "../../auth/api";

const tabs = [
  { key: "orders", label: "Orders", realEstateLabel: "Orders", path: "/dashboard/orders", icon: ClipboardList, moduleKey: "order_management" },
  { key: "projects", label: "Projects", realEstateLabel: "Projects", path: "/dashboard/projects", icon: FileText, moduleKey: "projects_tasks" },
  { key: "tasks", label: "Tasks", realEstateLabel: "Tasks", path: "/dashboard/tasks", icon: CheckCircle2, moduleKey: "projects_tasks" },
  { key: "recurring", label: "Recurring Billing", realEstateLabel: "Monthly Billing", path: "/dashboard/recurring-billing", icon: RefreshCw, moduleKey: "recurring_billing" },
  { key: "appointments", label: "Appointments", realEstateLabel: "Site Visits", path: "/dashboard/appointments", icon: CalendarClock, moduleKey: "appointments_scheduling" },
  { key: "production", label: "Production / Job Work", realEstateLabel: "Production / Job Work", path: "/dashboard/production-jobs", icon: ClipboardList, moduleKey: "production_job_work" },
  { key: "batches", label: "Batch & Expiry", realEstateLabel: "Batch & Expiry", path: "/dashboard/batches", icon: RefreshCw, moduleKey: "batch_expiry" },
  { key: "dispatches", label: "Dispatch / Fulfilment", realEstateLabel: "Dispatch / Fulfilment", path: "/dashboard/dispatches", icon: ClipboardList, moduleKey: "dispatch_fulfilment" },
  { key: "approvals", label: "Documents & Approvals", realEstateLabel: "Documents & Approvals", path: "/dashboard/approvals", icon: FileText, moduleKey: "documents_approvals" },
];

const statusTone = {
  DRAFT: "bg-slate-100 text-slate-700",
  CONFIRMED: "bg-blue-50 text-blue-700",
  PROCESSING: "bg-amber-50 text-amber-700",
  PARTIALLY_FULFILLED: "bg-purple-50 text-purple-700",
  FULFILLED: "bg-emerald-50 text-emerald-700",
  ACTIVE: "bg-emerald-50 text-emerald-700",
  DONE: "bg-emerald-50 text-emerald-700",
  COMPLETED: "bg-emerald-50 text-emerald-700",
  SCHEDULED: "bg-blue-50 text-blue-700",
  PAUSED: "bg-amber-50 text-amber-700",
  CANCELLED: "bg-rose-50 text-rose-700",
  BLOCKED: "bg-rose-50 text-rose-700",
  PLANNED: "bg-blue-50 text-blue-700",
  PACKED: "bg-amber-50 text-amber-700",
  DISPATCHED: "bg-purple-50 text-purple-700",
  DELIVERED: "bg-emerald-50 text-emerald-700",
  PENDING: "bg-amber-50 text-amber-700",
  APPROVED: "bg-emerald-50 text-emerald-700",
  REJECTED: "bg-rose-50 text-rose-700",
  QUARANTINED: "bg-amber-50 text-amber-700",
  CONSUMED: "bg-slate-100 text-slate-700",
  EXPIRED: "bg-rose-50 text-rose-700",
};

const money = (value) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const formatDateTime = (value) => (value ? new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

const Badge = ({ children }) => (
  <span className={`whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${statusTone[children] || "bg-slate-100 text-slate-700"}`}>
    {String(children || "—").replaceAll("_", " ").toLowerCase()}
  </span>
);

const MANUAL_ITEM = "__manual__";

const EmptyState = ({ title, description, icon: Icon = FileText }) => (
  <div className="empty-state">
    <span className="empty-state-icon"><Icon size={22} /></span>
    <p className="text-base font-semibold text-slate-900">{title}</p>
    <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>
  </div>
);

const Field = ({ label, hint, error, children, className = "" }) => (
  <label className={`form-field ${className}`}>
    {label ? <span className="form-label">{label}</span> : null}
    {children}
    {error ? <span className="form-error" role="alert">{error}</span> : hint ? <span className="form-hint">{hint}</span> : null}
  </label>
);

const WorkflowPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { business } = authStore();
  const [moduleData, setModuleData] = useState(null);
  const visibleTabs = useMemo(() => tabs
    .filter((tab) => isActiveModule(moduleData, tab.moduleKey) && shouldShowWorkspaceNavigation(tab.moduleKey, moduleData, business))
    .map((tab) => ({ ...tab, label: isRealEstateSelfHostedWorkspace(moduleData, business) ? tab.realEstateLabel : tab.label })), [moduleData, business]);
  const activeTab = (visibleTabs.find((tab) => tab.path === location.pathname) || visibleTabs[0] || tabs[0]).key;
  const [data, setData] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [projects, setProjects] = useState([]);
  const [team, setTeam] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [form, setForm] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [pendingDelete, setPendingDelete] = useState(null);
  const loadSequenceRef = useRef(0);

  const currentTab = visibleTabs.find((tab) => tab.key === activeTab) || tabs.find((tab) => tab.key === activeTab) || tabs[0];
  const isRealEstateClient = isRealEstateSelfHostedWorkspace(moduleData, business);

  const loadData = async () => {
    const loadSequence = ++loadSequenceRef.current;
    setLoading(true);
    setError("");
    try {
      let effectiveModuleData = moduleData;
      if (!moduleData) {
        effectiveModuleData = await getBusinessModulesRequest();
        setModuleData(effectiveModuleData);
      }
      const allowedTabs = tabs.filter((tab) => isActiveModule(effectiveModuleData, tab.moduleKey) && shouldShowWorkspaceNavigation(tab.moduleKey, effectiveModuleData, business));
      if (allowedTabs.length && !allowedTabs.some((tab) => tab.key === activeTab)) {
        navigate(allowedTabs[0].path, { replace: true });
        setData([]);
        return;
      }
      const request = {
        orders: listOrdersRequest,
        projects: listProjectsRequest,
        tasks: listTasksRequest,
        recurring: listRecurringProfilesRequest,
        appointments: listAppointmentsRequest,
        production: listProductionJobsRequest,
        batches: listBatchesRequest,
        dispatches: listDispatchesRequest,
        approvals: listApprovalDocumentsRequest,
      }[activeTab];
      const response = await request(query ? { search: query } : undefined);
      if (loadSequence !== loadSequenceRef.current) return;
      setData(Array.isArray(response) ? response : response?.items || []);
    } catch (err) {
      if (loadSequence !== loadSequenceRef.current) return;
      setError(err?.response?.data?.message || "Unable to load this workflow module.");
      setData([]);
    } finally {
      if (loadSequence === loadSequenceRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeTab]);

  useEffect(() => {
    getBusinessModulesRequest()
      .then(setModuleData)
      .catch(() => setModuleData({ catalog: [] }));
  }, []);

  useEffect(() => {
    if (!moduleData || !visibleTabs.length) return;
    if (!visibleTabs.some((tab) => tab.path === location.pathname)) {
      navigate(visibleTabs[0].path, { replace: true });
    }
  }, [location.pathname, moduleData, navigate, visibleTabs]);

  useEffect(() => {
    const requests = [];
    const addRequest = (request, setter) => requests.push(
      request().then((value) => setter(value?.items || value || []))
    );

    if (["orders", "projects", "recurring", "appointments", "dispatches"].includes(activeTab)) {
      addRequest(listCustomersRequest, setCustomers);
    }
    if (["orders", "recurring", "production", "batches", "dispatches"].includes(activeTab)) {
      addRequest(listProductsRequest, setProducts);
    }
    if (activeTab === "tasks") addRequest(listProjectsRequest, setProjects);
    if (["projects", "tasks", "appointments", "approvals"].includes(activeTab)) {
      addRequest(listTeamMembersRequest, setTeam);
    }

    Promise.allSettled(requests).catch(() => {});
  }, [activeTab]);

  const filtered = useMemo(() => {
    if (!query) return data;
    const needle = query.toLowerCase();
    return data.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }, [data, query]);

  const firstCustomer = customers[0]?._id || customers[0]?.id || "";
  const firstProduct = products[0]?._id || products[0]?.id || "";
  const firstProject = projects[0]?._id || projects[0]?.id || "";
  const firstUser = team[0]?._id || team[0]?.id || "";
  const selectedProduct = products.find((product) => String(product._id || product.id) === String(form.productId || ""));
  // Workspaces without a product catalog (e.g. office rental) type the service directly.
  // Services billed before (catalog + past invoices/quotations) feed the Monthly Billing picker.
  const suggestions = useServiceSuggestions(activeTab === "recurring" ? data.length : -1);
  const serviceOptions = suggestions.length
    ? suggestions
    : products.map((product) => ({ key: String(product._id || product.id), productId: product._id || product.id, name: product.name, rate: product.sellingPrice, taxRate: product.taxRate, source: "catalog" }));
  const serviceGroups = groupSuggestions(serviceOptions);
  const chosenService = findSuggestion(serviceOptions, form.serviceKey);
  const recurringManualItem = activeTab === "recurring" && (!serviceOptions.length || form.serviceKey === MANUAL_ITEM);
  const recurringHasService = recurringManualItem || Boolean(chosenService);
  const recurringNeedsGst = recurringHasService && !chosenService?.productId && Boolean(business?.gstConfiguration?.enabled);
  const recurringTotal = Number(form.quantity || 1) * Number(form.rate || 0);
  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: "" }));
  };

  const validateRecurring = () => {
    const errors = {};
    if (!(form.customerId || firstCustomer)) errors.customerId = "Add or select a client first.";
    if (!recurringHasService) {
      errors.productId = "Pick a service, or choose “Type a new service”.";
    } else if (String(form.productName || "").trim().length < 2) {
      errors.productName = "Write what this invoice is for, e.g. Cabin rent – Cabin 4.";
    }
    const quantity = Number(form.quantity || 1);
    if (!Number.isFinite(quantity) || quantity <= 0) errors.quantity = "Must be more than 0.";
    if (form.rate === undefined || form.rate === "" || !Number.isFinite(Number(form.rate)) || Number(form.rate) <= 0) errors.rate = "Enter the billing amount.";
    setFieldErrors(errors);
    return !Object.keys(errors).length;
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      if (activeTab === "orders") {
        await createOrderRequest({
          customerId: form.customerId || firstCustomer,
          expectedDeliveryDate: form.expectedDeliveryDate || undefined,
          lineItems: [{ productId: form.productId || firstProduct, quantity: Number(form.quantity || 1), rate: Number(form.rate || 0) }],
          notes: form.notes || "",
        });
      }
      if (activeTab === "projects") {
        await createProjectRequest({ name: form.name, customerId: form.customerId || undefined, dueDate: form.dueDate || undefined, assignedUsers: firstUser ? [firstUser] : [] });
      }
      if (activeTab === "tasks") {
        await createTaskRequest({ title: form.title, projectId: form.projectId || firstProject || undefined, assignedTo: form.assignedTo || firstUser || undefined, dueDate: form.dueDate || undefined });
      }
      if (activeTab === "recurring") {
        if (!validateRecurring()) return;
        const selectedCustomer = customers.find((customer) => String(customer._id || customer.id) === String(form.customerId || firstCustomer));
        const productId = chosenService?.productId || undefined;
        const createdProfile = await createRecurringProfileRequest({
          placeOfSupplyCode: form.placeOfSupplyCode,
          customerId: form.customerId || firstCustomer,
          name: form.name?.trim() || `${selectedCustomer?.name || "Client"} monthly billing`,
          frequency: form.frequency || "MONTHLY",
          startDate: form.startDate || new Date().toISOString().slice(0, 10),
          lineItems: [{
            productId,
            productName: String(form.productName || "").trim(),
            quantity: Number(form.quantity || 1),
            rate: Number(form.rate || 0),
            taxRate: productId ? undefined : Number(form.taxRate ?? (business?.gstConfiguration?.enabled ? 18 : 0)),
          }],
        });
        setData((current) => [{ ...createdProfile, customerId: selectedCustomer || createdProfile.customerId }, ...current.filter((item) => item._id !== createdProfile._id)]);
      }
      if (activeTab === "appointments") {
        await createAppointmentRequest({
          title: form.title,
          customerId: form.customerId || undefined,
          assignedUsers: firstUser ? [firstUser] : [],
          startAt: form.startAt,
          endAt: form.endAt,
          locationType: form.locationType || "OFFICE",
        });
      }
      if (activeTab === "production") {
        await createProductionJobRequest({
          title: form.title || form.name,
          outputProductId: form.productId || firstProduct,
          outputQuantity: Number(form.quantity || 1),
          inputItems: form.inputProductId ? [{ productId: form.inputProductId, quantity: Number(form.inputQuantity || 1) }] : [],
          dueDate: form.dueDate || undefined,
          notes: form.notes || "",
        });
      }
      if (activeTab === "batches") {
        await createBatchRequest({
          productId: form.productId || firstProduct,
          batchNumber: form.batchNumber || form.name,
          quantityOnHand: Number(form.quantity || 0),
          manufactureDate: form.manufactureDate || undefined,
          expiryDate: form.expiryDate || undefined,
          notes: form.notes || "",
        });
      }
      if (activeTab === "dispatches") {
        await createDispatchRequest({
          customerId: form.customerId || firstCustomer,
          items: [{ productId: form.productId || firstProduct, quantity: Number(form.quantity || 1) }],
          carrier: form.carrier || "",
          trackingNumber: form.trackingNumber || "",
          dispatchDate: form.dispatchDate || undefined,
        });
      }
      if (activeTab === "approvals") {
        await createApprovalDocumentRequest({
          title: form.title || form.name,
          documentType: form.documentType || "GENERAL",
          approvers: firstUser ? [firstUser] : [],
          notes: form.notes || "",
        });
      }
      setForm({});
      setFieldErrors({});
      setSuccess(activeTab === "recurring" ? "Billing profile created as a draft. Click Activate to start raising invoices." : `${currentTab.label} saved successfully.`);
      await loadData();
    } catch (err) {
      setError(err?.response?.data?.message || "Unable to save. Please check the fields and try again.");
    } finally {
      setSaving(false);
    }
  };

  const action = async (fn, message) => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await fn();
      setSuccess(message);
      await loadData();
      return true;
    } catch (err) {
      setError(err?.response?.data?.message || "Action could not be completed.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const markOrderFulfilled = (order) =>
    updateOrderFulfilmentRequest(
      order._id,
      (order.lineItems || []).map((line) => ({
        lineItemId: line._id,
        fulfilledQuantity: line.quantity,
      }))
    );

  const renderRows = () => {
    if (loading) {
      return (
        <div className="panel flex items-center justify-center p-12 text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading {currentTab.label.toLowerCase()}...
        </div>
      );
    }
    if (!filtered.length) {
      if (query) return <EmptyState icon={Search} title="No matches" description={`Nothing matches “${query}”. Try a different search.`} />;
      return <EmptyState icon={currentTab.icon} title={`No ${currentTab.label.toLowerCase()} yet`} description={activeTab === "recurring" ? "Pick a client, type what you bill them for and the amount. BillStack raises the invoice every cycle." : "Create your first record using the form."} />;
    }

    if (activeTab === "orders") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-slate-950">{item.orderNumber}</p>
              <p className="text-sm text-slate-500">{item.customerId?.name || item.customerSnapshot?.name || "Customer"} · {formatDate(item.orderDate)}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge>{item.status}</Badge>
              <Badge>{item.fulfilmentStatus}</Badge>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="font-semibold text-slate-900">{money(item.grandTotal)}</span>
            <div className="flex flex-wrap gap-2">
              {item.status === "DRAFT" ? <button className="btn-secondary" onClick={() => action(() => updateOrderStatusRequest(item._id, "CONFIRMED"), "Order confirmed.")}>Confirm</button> : null}
              {item.status === "CONFIRMED" ? <button className="btn-secondary" onClick={() => action(() => updateOrderStatusRequest(item._id, "PROCESSING"), "Order moved to processing.")}>Process</button> : null}
              {["CONFIRMED", "PROCESSING", "PARTIALLY_FULFILLED"].includes(item.status) && item.fulfilmentStatus !== "FULFILLED" ? <button className="btn-secondary" onClick={() => action(() => markOrderFulfilled(item), "Order marked fulfilled.")}>Mark fulfilled</button> : null}
              {!item.invoiceIds?.length && item.status !== "CANCELLED" ? <button className="btn-primary" onClick={() => action(() => convertOrderToInvoiceRequest(item._id), "Invoice created from order.")}>Create invoice</button> : null}
              {["DRAFT", "CONFIRMED", "PROCESSING", "PARTIALLY_FULFILLED"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateOrderStatusRequest(item._id, "CANCELLED"), "Order cancelled.")}><XCircle size={15} /> Cancel</button> : null}
            </div>
          </div>
        </div>
      ));
    }

    if (activeTab === "projects") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-slate-950">{item.name}</p>
              <p className="text-sm text-slate-500">{item.projectNumber} · {item.customerId?.name || "Internal"} · Due {formatDate(item.dueDate)}</p>
            </div>
            <Badge>{item.status}</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {item.status === "PLANNING" ? <button className="btn-secondary" onClick={() => action(() => updateProjectRequest(item._id, { status: "ACTIVE" }), "Project activated.")}>Start</button> : null}
            {item.status === "ACTIVE" ? <button className="btn-secondary" onClick={() => action(() => updateProjectRequest(item._id, { status: "ON_HOLD" }), "Project put on hold.")}>Hold</button> : null}
            {item.status === "ON_HOLD" ? <button className="btn-secondary" onClick={() => action(() => updateProjectRequest(item._id, { status: "ACTIVE" }), "Project resumed.")}>Resume</button> : null}
            {item.status === "ACTIVE" ? <button className="btn-secondary" onClick={() => action(() => updateProjectRequest(item._id, { status: "COMPLETED" }), "Project completed.")}>Complete</button> : null}
            {["PLANNING", "ACTIVE", "ON_HOLD"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateProjectRequest(item._id, { status: "CANCELLED" }), "Project cancelled.")}>Cancel</button> : null}
          </div>
        </div>
      ));
    }

    if (activeTab === "tasks") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-slate-950">{item.title}</p>
              <p className="text-sm text-slate-500">{item.projectId?.name || "Standalone"} · {item.assignedTo?.name || "Unassigned"} · Due {formatDate(item.dueDate)}</p>
            </div>
            <Badge>{item.status}</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {item.status === "TODO" ? <button className="btn-secondary" onClick={() => action(() => updateTaskRequest(item._id, { status: "IN_PROGRESS" }), "Task moved to in progress.")}>Start</button> : null}
            {["TODO", "IN_PROGRESS"].includes(item.status) ? <button className="btn-secondary" onClick={() => action(() => updateTaskRequest(item._id, { status: "BLOCKED" }), "Task blocked.")}>Block</button> : null}
            {item.status === "BLOCKED" ? <button className="btn-secondary" onClick={() => action(() => updateTaskRequest(item._id, { status: "IN_PROGRESS" }), "Task resumed.")}>Resume</button> : null}
            {["TODO", "IN_PROGRESS", "BLOCKED"].includes(item.status) ? <button className="btn-secondary" onClick={() => action(() => updateTaskRequest(item._id, { status: "DONE" }), "Task completed.")}>Done</button> : null}
            {["TODO", "IN_PROGRESS", "BLOCKED"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateTaskRequest(item._id, { status: "CANCELLED" }), "Task cancelled.")}>Cancel</button> : null}
          </div>
        </div>
      ));
    }

    if (activeTab === "recurring") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-base font-bold text-slate-950">{item.name}</p>
              <p className="mt-0.5 text-sm text-slate-500">{item.customerId?.name || "Client"}{item.lineItems?.[0]?.productName ? ` · ${item.lineItems[0].productName}` : ""}</p>
            </div>
            <Badge>{item.status}</Badge>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-3 rounded-xl bg-slate-50 p-3 text-sm">
            <div><dt className="text-xs text-slate-500">Amount</dt><dd className="font-bold text-slate-950">{money(item.grandTotal)}</dd></div>
            <div><dt className="text-xs text-slate-500">Repeats</dt><dd className="font-semibold capitalize text-slate-900">{String(item.frequency || "").toLowerCase().replace("_", "-")}</dd></div>
            <div><dt className="text-xs text-slate-500">Next bill</dt><dd className="font-semibold text-slate-900">{formatDate(item.nextBillingDate)}</dd></div>
          </dl>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <div className="flex flex-wrap gap-2">
              {item.status === "DRAFT" ? <button className="btn-secondary" onClick={() => action(() => updateRecurringStatusRequest(item._id, "ACTIVE"), "Recurring profile activated.")}><PlayCircle size={15} /> Activate</button> : null}
              {item.status === "ACTIVE" ? <button className="btn-secondary" onClick={() => action(() => updateRecurringStatusRequest(item._id, "PAUSED"), "Recurring profile paused.")}><PauseCircle size={15} /> Pause</button> : null}
              {item.status === "PAUSED" ? <button className="btn-secondary" onClick={() => action(() => updateRecurringStatusRequest(item._id, "ACTIVE"), "Recurring profile resumed.")}><PlayCircle size={15} /> Resume</button> : null}
              {item.status === "ACTIVE" ? <button className="btn-primary" onClick={() => action(() => generateRecurringInvoiceRequest(item._id), "Recurring invoice generated.")}>Generate now</button> : null}
              {["DRAFT", "ACTIVE", "PAUSED"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateRecurringStatusRequest(item._id, "CANCELLED"), "Recurring profile cancelled.")}>Cancel</button> : null}
              {item.status === "CANCELLED" ? <button className="btn-secondary text-rose-600" onClick={() => setPendingDelete(item)}><Trash2 size={15} /> Delete</button> : null}
            </div>
          </div>
        </div>
      ));
    }

    if (activeTab === "production") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-slate-950">{item.title}</p>
              <p className="text-sm text-slate-500">{item.jobNumber} · Output {item.outputProductId?.name || "Product"} · Due {formatDate(item.dueDate)}</p>
            </div>
            <Badge>{item.status}</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {item.status === "PLANNED" ? <button className="btn-secondary" onClick={() => action(() => updateProductionJobStatusRequest(item._id, "IN_PROGRESS"), "Production job started.")}>Start</button> : null}
            {item.status === "IN_PROGRESS" ? <button className="btn-primary" onClick={() => action(() => updateProductionJobStatusRequest(item._id, "COMPLETED"), "Production job completed and stock updated.")}>Complete</button> : null}
            {["PLANNED", "IN_PROGRESS"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateProductionJobStatusRequest(item._id, "CANCELLED"), "Production job cancelled.")}>Cancel</button> : null}
          </div>
        </div>
      ));
    }

    if (activeTab === "batches") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-slate-950">{item.batchNumber}</p>
              <p className="text-sm text-slate-500">{item.productId?.name || "Product"} · Qty {item.quantityOnHand || 0} · Expiry {formatDate(item.expiryDate)}</p>
            </div>
            <Badge>{item.status}</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {item.status === "ACTIVE" ? <button className="btn-secondary" onClick={() => action(() => updateBatchStatusRequest(item._id, "QUARANTINED"), "Batch quarantined.")}>Quarantine</button> : null}
            {item.status === "QUARANTINED" ? <button className="btn-secondary" onClick={() => action(() => updateBatchStatusRequest(item._id, "ACTIVE"), "Batch restored.")}>Restore</button> : null}
            {["ACTIVE", "QUARANTINED"].includes(item.status) ? <button className="btn-secondary" onClick={() => action(() => updateBatchStatusRequest(item._id, "EXPIRED"), "Batch marked expired.")}>Expire</button> : null}
            {["ACTIVE", "QUARANTINED"].includes(item.status) ? <button className="btn-secondary" onClick={() => action(() => updateBatchStatusRequest(item._id, "CONSUMED"), "Batch marked consumed.")}>Consume</button> : null}
          </div>
        </div>
      ));
    }

    if (activeTab === "dispatches") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-slate-950">{item.dispatchNumber}</p>
              <p className="text-sm text-slate-500">{item.customerId?.name || "Customer"} · {item.carrier || "Carrier pending"} · {item.trackingNumber || "No tracking"}</p>
            </div>
            <Badge>{item.status}</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {item.status === "DRAFT" ? <button className="btn-secondary" onClick={() => action(() => updateDispatchStatusRequest(item._id, "PACKED"), "Dispatch packed.")}>Pack</button> : null}
            {item.status === "PACKED" ? <button className="btn-secondary" onClick={() => action(() => updateDispatchStatusRequest(item._id, "DISPATCHED"), "Dispatch sent.")}>Dispatch</button> : null}
            {item.status === "DISPATCHED" ? <button className="btn-primary" onClick={() => action(() => updateDispatchStatusRequest(item._id, "DELIVERED"), "Dispatch delivered.")}>Deliver</button> : null}
            {["DRAFT", "PACKED", "DISPATCHED"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateDispatchStatusRequest(item._id, "CANCELLED"), "Dispatch cancelled.")}>Cancel</button> : null}
          </div>
        </div>
      ));
    }

    if (activeTab === "approvals") {
      return filtered.map((item) => (
        <div key={item._id} className="panel panel-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-base font-bold text-slate-950">{item.title}</p>
              <p className="text-sm text-slate-500">{item.documentType || "GENERAL"} · {item.sourceType || "GENERAL"} · {item.approvers?.length || 0} approver(s)</p>
            </div>
            <Badge>{item.status}</Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {item.status === "DRAFT" ? <button className="btn-secondary" onClick={() => action(() => updateApprovalDocumentStatusRequest(item._id, "PENDING"), "Approval submitted.")}>Submit</button> : null}
            {item.status === "PENDING" ? <button className="btn-primary" onClick={() => action(() => updateApprovalDocumentStatusRequest(item._id, "APPROVED"), "Document approved.")}>Approve</button> : null}
            {item.status === "PENDING" ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateApprovalDocumentStatusRequest(item._id, "REJECTED"), "Document rejected.")}>Reject</button> : null}
            {["DRAFT", "PENDING"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateApprovalDocumentStatusRequest(item._id, "CANCELLED"), "Approval cancelled.")}>Cancel</button> : null}
          </div>
        </div>
      ));
    }

    return filtered.map((item) => (
      <div key={item._id} className="panel panel-hover p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-bold text-slate-950">{item.title}</p>
            <p className="text-sm text-slate-500">{item.customerId?.name || "No customer"} · {formatDateTime(item.startAt)} – {formatDateTime(item.endAt)}</p>
          </div>
          <Badge>{item.status}</Badge>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {item.status === "SCHEDULED" ? <button className="btn-secondary" onClick={() => action(() => updateAppointmentStatusRequest(item._id, "CONFIRMED"), "Appointment confirmed.")}>Confirm</button> : null}
          {["SCHEDULED", "CONFIRMED"].includes(item.status) ? <button className="btn-secondary" onClick={() => action(() => updateAppointmentStatusRequest(item._id, "COMPLETED"), "Appointment completed.")}>Complete</button> : null}
          {["SCHEDULED", "CONFIRMED"].includes(item.status) ? <button className="btn-secondary" onClick={() => action(() => updateAppointmentStatusRequest(item._id, "NO_SHOW"), "Appointment marked no-show.")}>No show</button> : null}
          {["SCHEDULED", "CONFIRMED"].includes(item.status) ? <button className="btn-secondary text-rose-600" onClick={() => action(() => updateAppointmentStatusRequest(item._id, "CANCELLED"), "Appointment cancelled.")}>Cancel</button> : null}
        </div>
      </div>
    ));
  };

  const needsLineItem = ["orders", "recurring"].includes(activeTab);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="page-kicker">{isRealEstateClient ? "Operations" : "Business workspace"}</p>
          <h1 className="page-title">{currentTab.label}</h1>
          <p className="page-subtitle">
            {isRealEstateClient ? "Manage monthly client billing for this workspace." : "Manage reusable workflow activity for this workspace."}
          </p>
        </div>
        <button type="button" onClick={loadData} className="btn-secondary"><RefreshCw size={16} /> Refresh</button>
      </div>

      {visibleTabs.length > 1 ? <div className="segmented no-scrollbar">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => navigate(tab.path)}
              aria-current={active ? "page" : undefined}
              className={`segmented-item ${active ? "is-active" : ""}`}
            >
              <Icon size={16} /> {tab.label}
            </button>
          );
        })}
      </div> : null}

      {error ? <div role="alert" className="alert alert-error"><XCircle size={18} /><span>{error}</span><button type="button" className="ml-auto text-xs font-semibold opacity-70 hover:opacity-100" onClick={() => setError("")}>Dismiss</button></div> : null}
      {success ? <div role="status" className="alert alert-success"><CheckCircle2 size={18} /><span>{success}</span><button type="button" className="ml-auto text-xs font-semibold opacity-70 hover:opacity-100" onClick={() => setSuccess("")}>Dismiss</button></div> : null}

      <div className="grid items-start gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
        <form onSubmit={submit} noValidate className="panel h-fit p-5 xl:sticky xl:top-24">
          <div className="flex items-center gap-3">
            <span className="icon-chip"><Plus size={18} /></span>
            <div>
              <h2 className="text-base font-bold text-slate-950">Create {currentTab.key === "recurring" ? (isRealEstateClient ? "Monthly Billing" : "Recurring Profile") : currentTab.label}</h2>
              {activeTab === "recurring" ? <p className="text-xs text-slate-500">Invoices are raised automatically on each billing date.</p> : null}
            </div>
          </div>

          {activeTab === "recurring" ? (
            <div className="mt-5 space-y-4">
              <Field label="Client" error={fieldErrors.customerId}>
                <select className="input" value={form.customerId || firstCustomer} onChange={(e) => updateField("customerId", e.target.value)}>
                  {!customers.length ? <option value="">No clients yet</option> : null}
                  {customers.map((customer) => <option key={customer._id || customer.id} value={customer._id || customer.id}>{customer.name}</option>)}
                </select>
              </Field>
              {!customers.length ? <p className="-mt-2 text-xs text-slate-500"><Link to="/dashboard/customers" className="font-semibold text-brand-600">Add a client</Link> before creating monthly billing.</p> : null}

              <Field label="Service" error={fieldErrors.productId} hint={!serviceOptions.length ? "Nothing billed yet. Type the service; it will be remembered next time." : null}>
                {serviceOptions.length ? (
                  <select className="input" value={form.serviceKey || ""} onChange={(e) => {
                    const value = e.target.value;
                    const item = findSuggestion(serviceOptions, value);
                    setForm((current) => item
                      ? { ...current, serviceKey: value, productName: item.name, rate: item.rate ? String(item.rate) : current.rate, taxRate: item.taxRate ?? current.taxRate }
                      : { ...current, serviceKey: value, productName: value === MANUAL_ITEM ? "" : current.productName });
                    setFieldErrors((current) => ({ ...current, productId: "", productName: "", rate: "" }));
                  }}>
                    <option value="">Select a service</option>
                    {serviceGroups.saved.length ? (
                      <optgroup label="Saved services">
                        {serviceGroups.saved.map((item) => <option key={suggestionValue(item)} value={suggestionValue(item)}>{item.name}{item.rate ? ` · ${money(item.rate)}` : ""}</option>)}
                      </optgroup>
                    ) : null}
                    {serviceGroups.history.length ? (
                      <optgroup label="Used on previous invoices">
                        {serviceGroups.history.map((item) => <option key={suggestionValue(item)} value={suggestionValue(item)}>{item.name}{item.rate ? ` · ${money(item.rate)}` : ""}</option>)}
                      </optgroup>
                    ) : null}
                    <option value={MANUAL_ITEM}>+ Type a new service</option>
                  </select>
                ) : null}
              </Field>

              {recurringHasService ? (
                <Field label="Description on invoice" error={fieldErrors.productName} hint="Printed on every invoice. Add details like cabin or seat number.">
                  <input className="input" placeholder="e.g. Cabin rent – Cabin 4" value={form.productName || ""} onChange={(e) => updateField("productName", e.target.value)} autoFocus={recurringManualItem && serviceOptions.length > 0} />
                </Field>
              ) : null}

              <div className={`grid gap-3 ${recurringNeedsGst ? "grid-cols-[72px_1fr_88px]" : "grid-cols-[88px_1fr]"}`}>
                <Field label="Qty" error={fieldErrors.quantity}>
                  <input className="input" type="number" min="1" inputMode="decimal" value={form.quantity ?? "1"} onChange={(e) => updateField("quantity", e.target.value)} />
                </Field>
                <Field label="Rate (₹)" error={fieldErrors.rate}>
                  <input className="input" type="number" min="0" step="0.01" inputMode="decimal" placeholder={chosenService?.rate ? String(chosenService.rate) : "0.00"} value={form.rate ?? ""} onChange={(e) => updateField("rate", e.target.value)} />
                </Field>
                {recurringNeedsGst ? (
                  <Field label="GST">
                    <select className="input" value={form.taxRate ?? "18"} onChange={(e) => updateField("taxRate", e.target.value)}>
                      {[0, 5, 12, 18, 28].map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
                    </select>
                  </Field>
                ) : null}
              </div>

              <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <span className="text-slate-500">Amount per cycle <span className="text-xs">(before tax)</span></span>
                <span className="font-bold text-slate-950">{money(recurringTotal)}</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="First billing date" error={fieldErrors.startDate}>
                  <input className="input" type="date" value={form.startDate || new Date().toISOString().slice(0, 10)} onChange={(e) => updateField("startDate", e.target.value)} required />
                </Field>
                <Field label="Repeats">
                  <select className="input" value={form.frequency || "MONTHLY"} onChange={(e) => updateField("frequency", e.target.value)}>
                    <option value="MONTHLY">Monthly</option>{!isRealEstateClient ? <option value="WEEKLY">Weekly</option> : null}{!isRealEstateClient ? <option value="QUARTERLY">Quarterly</option> : null}{!isRealEstateClient ? <option value="HALF_YEARLY">Half-yearly</option> : null}{!isRealEstateClient ? <option value="YEARLY">Yearly</option> : null}
                  </select>
                </Field>
              </div>

              <GstLocationPreview
                form={{ ...form, customerId: form.customerId || firstCustomer }}
                setForm={setForm}
                customers={customers}
                lineItems={[{
                  productId: chosenService?.productId || undefined,
                  productName: form.productName,
                  quantity: Number(form.quantity || 1),
                  rate: Number(form.rate || 0),
                  taxRate: chosenService?.productId ? Number(chosenService.taxRate || 0) : Number(form.taxRate ?? 18),
                }]}
              />

              <Field label="Profile name" hint="Optional. Defaults to “Client monthly billing”.">
                <input className="input" placeholder="e.g. Somil – Cabin 4 rent" value={form.name || ""} onChange={(e) => updateField("name", e.target.value)} />
              </Field>

              <button type="submit" disabled={saving || !customers.length} className="btn-primary w-full justify-center">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={16} />} {saving ? "Saving…" : "Create billing profile"}
              </button>
            </div>
          ) : (
          <div className="mt-5 space-y-3">
            {["orders", "appointments", "dispatches"].includes(activeTab) ? (
              <Field label="Customer">
                <select className="input" value={form.customerId || ""} onChange={(e) => setForm({ ...form, customerId: e.target.value })}>
                  <option value="">{firstCustomer ? "Use first customer" : "Select customer"}</option>
                  {customers.map((customer) => <option key={customer._id || customer.id} value={customer._id || customer.id}>{customer.name}</option>)}
                </select>
              </Field>
            ) : null}
            {["projects", "batches", "approvals"].includes(activeTab) ? (
              <Field label={activeTab === "projects" ? "Project name" : activeTab === "batches" ? "Batch number" : "Document title"}>
                <input className="input" value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
            ) : null}
            {["tasks", "appointments", "production"].includes(activeTab) ? (
              <Field label={activeTab === "tasks" ? "Task title" : activeTab === "appointments" ? "Site visit title" : "Production job title"}>
                <input className="input" value={form.title || ""} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
              </Field>
            ) : null}
            {needsLineItem || ["production", "batches", "dispatches"].includes(activeTab) ? (
              <>
                <Field label={activeTab === "production" ? "Output product" : "Product / service"}>
                  <select className="input" value={form.productId || ""} onChange={(e) => { const product = products.find((item) => String(item._id || item.id) === String(e.target.value)); setForm({ ...form, productId: e.target.value, rate: product?.sellingPrice ?? form.rate, taxRate: product?.taxRate ?? form.taxRate }); }}>
                    <option value="">{products.length ? "Select…" : "No products yet"}</option>
                    {products.map((product) => <option key={product._id || product.id} value={product._id || product.id}>{product.name}</option>)}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Qty"><input className="input" type="number" min="1" value={form.quantity || ""} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></Field>
                  {activeTab !== "batches" ? <Field label="Rate (₹)"><input className="input" type="number" min="0" placeholder={selectedProduct ? String(selectedProduct.sellingPrice ?? "") : ""} value={form.rate || ""} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></Field> : null}
                </div>
              </>
            ) : null}
            {activeTab === "production" ? (
              <Field label="Input product (optional)">
                <select className="input" value={form.inputProductId || ""} onChange={(e) => setForm({ ...form, inputProductId: e.target.value })}>
                  <option value="">None</option>
                  {products.map((product) => <option key={product._id || product.id} value={product._id || product.id}>{product.name}</option>)}
                </select>
              </Field>
            ) : null}
            {activeTab === "batches" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Manufactured"><input className="input" type="date" value={form.manufactureDate || ""} onChange={(e) => setForm({ ...form, manufactureDate: e.target.value })} /></Field>
                <Field label="Expires"><input className="input" type="date" value={form.expiryDate || ""} onChange={(e) => setForm({ ...form, expiryDate: e.target.value })} /></Field>
              </div>
            ) : null}
            {activeTab === "dispatches" ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Carrier"><input className="input" value={form.carrier || ""} onChange={(e) => setForm({ ...form, carrier: e.target.value })} /></Field>
                <Field label="Tracking no."><input className="input" value={form.trackingNumber || ""} onChange={(e) => setForm({ ...form, trackingNumber: e.target.value })} /></Field>
              </div>
            ) : null}
            {activeTab === "tasks" ? (
              <Field label="Project">
                <select className="input" value={form.projectId || ""} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                  <option value="">Standalone task</option>
                  {projects.map((project) => <option key={project._id || project.id} value={project._id || project.id}>{project.name}</option>)}
                </select>
              </Field>
            ) : null}
            {activeTab === "appointments" ? (
              <div className="grid gap-3">
                <Field label="Starts"><input className="input" type="datetime-local" value={form.startAt || ""} onChange={(e) => setForm({ ...form, startAt: e.target.value })} required /></Field>
                <Field label="Ends"><input className="input" type="datetime-local" value={form.endAt || ""} onChange={(e) => setForm({ ...form, endAt: e.target.value })} required /></Field>
              </div>
            ) : null}
            {activeTab === "projects" || activeTab === "tasks" || activeTab === "production" ? (
              <Field label="Due date"><input className="input" type="date" value={form.dueDate || ""} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
            ) : null}
            <button type="submit" disabled={saving} className="btn-primary mt-2 w-full justify-center">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={16} />} Save
            </button>
          </div>
          )}
        </form>

        <div className="space-y-4">
          <div className="panel grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input aria-label={`Search ${currentTab.label}`} className="input w-full" style={{ paddingLeft: "2.5rem" }} placeholder={`Search ${currentTab.label.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <span className="whitespace-nowrap px-2 text-sm font-medium text-slate-500">{filtered.length} {filtered.length === 1 ? "record" : "records"}</span>
          </div>
          <div className="grid gap-4">{renderRows()}</div>
          {activeTab === "orders" ? <p className="text-xs text-slate-500">Order invoices are created through the existing BillStack invoice engine. Stock remains governed by invoice/inventory behavior.</p> : null}
          {activeTab === "recurring" ? <div className="alert alert-info text-xs leading-6"><RefreshCw size={16} /><div><p className="font-semibold">{isRealEstateClient ? "How Monthly Billing works" : "How recurring billing works"}</p><p>Active profiles generate normal BillStack invoices on the next billing date. Generate now creates the current invoice once; payments are still recorded from the invoice or customer payment flow.</p></div></div> : null}
          {activeTab === "appointments" ? <p className="text-xs text-slate-500">Site visit overlap checks are handled when assigning staff.</p> : null}
          <Link to="/dashboard" className="inline-flex text-sm font-semibold text-brand-600 hover:text-brand-700">Back to dashboard</Link>
        </div>
      </div>
      {pendingDelete ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"><div role="dialog" aria-modal="true" aria-labelledby="delete-recurring-title" className="panel w-full max-w-md p-5 shadow-2xl"><h2 id="delete-recurring-title" className="text-lg font-bold text-slate-950">Delete monthly billing?</h2><p className="mt-2 text-sm text-slate-600">{pendingDelete.name} will be permanently removed. Generated invoices, if any, prevent deletion.</p><div className="mt-5 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setPendingDelete(null)}>Keep it</button><button type="button" disabled={saving} className="btn-primary bg-rose-600" onClick={() => action(() => deleteRecurringProfileRequest(pendingDelete._id), "Monthly billing deleted.").then((deleted) => { if (deleted) setPendingDelete(null); })}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 size={15} />} Delete</button></div></div></div> : null}
    </div>
  );
};
export default WorkflowPage;
