import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, CheckCircle2, CircleAlert, Plus, Search, WalletCards, X } from "lucide-react";
import { EmptyState, LoadingState } from "../../../components/ui/PageState";
import PageHeader from "../../../components/ui/PageHeader";
import { uiStore } from "../../../store/uiStore";
import { useCreateAction } from "../../workspace/useCreateAction";
import { authStore } from "../../../store/authStore";
import { isRealEstateSelfHostedWorkspace } from "../../workspace/workspaceVisibility";
import { gstStates, stateCodeFromGstin, updateCustomerGstFields, validateOptionalGstin } from "../gstIdentity";
import {
  allocatePaymentRequest,
  communicationDeliveriesRequest,
  communicationScheduledRequest,
  createCustomerRequest,
  createPaymentRequest,
  customerLedgerRequest,
  customerStatementCsvRequest,
  customerStatementPdfRequest,
  customerStatementRequest,
  deleteCustomerRequest,
  getInvoiceRequest,
  listCustomersRequest,
  listInvoicesRequest,
  listPaymentsRequest,
  scheduleInvoiceReminderRequest,
  updateCustomerRequest,
} from "../../auth/api";

const blankCustomer = { name: "", phone: "", email: "", billingAddress: "", shippingAddress: "", gstNumber: "", stateCode: "", placeOfSupplyCode: "", notes: "" };
const blankPayment = () => ({ amount: "", paymentMethod: "UPI", paymentDate: new Date().toISOString().slice(0, 10), referenceNumber: "", notes: "", idempotencyKey: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` });
const methods = ["CASH", "BANK_TRANSFER", "CHEQUE", "UPI", "CARD", "OTHER"];
const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const date = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const matches = (value, id) => String(value?._id || value || '') === String(id || '');
const toPaise = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100);
const fromPaise = (value) => Number((Number(value || 0) / 100).toFixed(2));

const CustomersPage = () => {
  const { business } = authStore();
  const clientWorkspace = isRealEstateSelfHostedWorkspace(null, business);
  const noun = clientWorkspace ? "client" : "customer";
  const saveCustomerLock = useRef(false);
  const [filters, setFilters] = useState({ page: 1, limit: 25, search: "", sortBy: "name", sortOrder: "asc" });
  const [result, setResult] = useState({ items: [], pagination: { page: 1, totalPages: 1 } });
  const [selectedId, setSelectedId] = useState("");
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [customerReminders, setCustomerReminders] = useState([]);
  const [customerDeliveries, setCustomerDeliveries] = useState([]);
  const [statement, setStatement] = useState(null);
  const [statementFilters, setStatementFilters] = useState({ from: "", to: "" });
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(null);
  const [customerForm, setCustomerForm] = useState(blankCustomer);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentForm, setPaymentForm] = useState(blankPayment);
  const [paymentErrors, setPaymentErrors] = useState({});
  const [savingPayment, setSavingPayment] = useState(false);
  const [createdPayment, setCreatedPayment] = useState(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [allocation, setAllocation] = useState("");
  const [allocating, setAllocating] = useState(false);

  const selected = result.items.find((customer) => customer._id === selectedId) || result.items[0];
  const customerInvoices = useMemo(() => invoices.filter((invoice) => matches(invoice.customerId, selected?._id)), [invoices, selected]);
  const customerPayments = useMemo(() => payments.filter((payment) => payment.direction === "RECEIVED" && matches(payment.customerId, selected?._id)), [payments, selected]);
  const metrics = useMemo(() => {
    const rows = customerInvoices.filter((row) => row.status !== "cancelled");
    return {
      outstanding: rows.reduce((sum, row) => sum + Number(row.balanceDue || 0), 0),
      overdue: rows.filter((row) => row.balanceDue > 0 && new Date(row.dueDate) < new Date()).reduce((sum, row) => sum + Number(row.balanceDue || 0), 0),
      invoiced: rows.reduce((sum, row) => sum + Number(row.grandTotal || 0), 0),
      collected: rows.reduce((sum, row) => sum + Number(row.amountPaid || 0), 0),
    };
  }, [customerInvoices]);
  const allocated = Number(createdPayment?.allocated || 0);
  const remaining = Math.max(Number(createdPayment?.amount || 0) - allocated, 0);

  const loadCustomers = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await listCustomersRequest(filters);
      setResult(data);
      setSelectedId((current) => current || data.items?.[0]?._id || "");
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load customers.");
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async () => {
    if (!selected?._id) return;
    setLoadingDetail(true);
    try {
      const [invoiceData, paymentData, ledgerData, reminderData, deliveryData] = await Promise.all([
        listInvoicesRequest({ page: 1, limit: 100, sortBy: "invoiceDate", sortOrder: "desc" }),
        listPaymentsRequest({ limit: 100 }),
        customerLedgerRequest(selected._id),
        communicationScheduledRequest({ customerId: selected._id }),
        communicationDeliveriesRequest({ customerId: selected._id }),
      ]);
      setInvoices(invoiceData.items || []);
      setPayments(paymentData || []);
      setLedger(ledgerData || []);
      setCustomerReminders(reminderData || []);
      setCustomerDeliveries(deliveryData || []);
    } catch (err) {
      setError(err.response?.data?.message || "Some financial activity could not be loaded.");
    } finally {
      setLoadingDetail(false);
    }
  };

  const loadStatement = async () => {
    if (!selected?._id) return;
    setLoadingStatement(true);
    try {
      setStatement(await customerStatementRequest(selected._id, { ...statementFilters, limit: 300 }));
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load customer statement.");
    } finally {
      setLoadingStatement(false);
    }
  };

  useEffect(() => { loadCustomers(); }, [filters.page, filters.search, filters.sortBy, filters.sortOrder]);
  useEffect(() => { loadDetail(); }, [selected?._id]);
  useEffect(() => { if (tab === "statement") loadStatement(); }, [tab, selected?._id]);

  const changeFilter = (event) => setFilters((current) => ({ ...current, page: 1, [event.target.name]: event.target.value }));
  useCreateAction({ ready: !loading, moduleKey: "customers", onCreate: () => { setCustomerForm(blankCustomer); setEditor("new"); setError(""); }, focusSelector: '#customer-editor input' });
  const saveCustomer = async (event) => { event.preventDefault(); if (saveCustomerLock.current) return; if (!validateOptionalGstin(customerForm.gstNumber)) { setError("Enter a valid 15-character GSTIN, or leave it blank for a non-GST customer."); return; } saveCustomerLock.current = true; setSavingCustomer(true); try { if (editor === "edit") await updateCustomerRequest(selected._id, customerForm); else await createCustomerRequest(customerForm); uiStore.getState().pushToast({ tone: "success", message: editor === "edit" ? "Customer updated successfully." : "Customer created successfully." }); setEditor(null); await loadCustomers(); } catch (err) { setError(err.response?.data?.message || "Unable to save customer."); } finally { saveCustomerLock.current = false; setSavingCustomer(false); } };
  const deleteCustomer = async () => { if (!selected || !window.confirm(`Delete ${selected.name}? This cannot be undone.`)) return; try { await deleteCustomerRequest(selected._id); uiStore.getState().pushToast({ tone: "success", message: "Customer deleted successfully." }); setSelectedId(""); await loadCustomers(); } catch (err) { setError(err.response?.data?.message || "Unable to delete customer."); } };
  const recordPayment = async (event) => { event.preventDefault(); const next = {}; const amount = Number(paymentForm.amount); if (!Number.isFinite(amount) || amount <= 0) next.amount = "Enter an amount greater than zero."; if (!paymentForm.paymentDate) next.paymentDate = "Payment date is required."; setPaymentErrors(next); if (Object.keys(next).length) return; setSavingPayment(true); try { const payment = await createPaymentRequest({ ...paymentForm, amount, direction: "RECEIVED", customerId: selected._id, currency: "INR" }); setCreatedPayment({ ...payment, allocated: 0 }); setPaymentOpen(false); setPayments((current) => [payment, ...current]); uiStore.getState().pushToast({ tone: "success", message: "Payment recorded. Allocate it to an invoice to update derived payment state." }); } catch (err) { setPaymentErrors({ form: err.response?.data?.message || "Unable to record payment." }); } finally { setSavingPayment(false); } };
  const allocatePayment = async (event) => {
    event.preventDefault();
    if (allocating) return;
    const amount = Number(allocation);
    if (!createdPayment?._id || !invoiceId || !Number.isFinite(amount) || amount <= 0) return setPaymentErrors({ allocation: "Choose an invoice and enter a positive allocation amount." });
    setAllocating(true);
    setPaymentErrors({});
    try {
      const freshInvoice = await getInvoiceRequest(invoiceId);
      const authoritativeInvoice = freshInvoice?.invoice || freshInvoice?.data || freshInvoice;
      const outstandingPaise = toPaise(authoritativeInvoice?.balanceDue);
      const availablePaise = toPaise(remaining);
      const allowedPaise = Math.min(outstandingPaise, availablePaise);
      if (allowedPaise <= 0) {
        await loadDetail();
        setInvoiceId("");
        setAllocation("");
        return setPaymentErrors({ allocation: "This invoice has no outstanding balance left. Refresh/select another invoice." });
      }
      if (toPaise(amount) > allowedPaise) {
        const allowed = fromPaise(allowedPaise);
        setAllocation(String(allowed));
        return setPaymentErrors({ allocation: `Only ${money(allowed)} can be allocated now. The amount was updated from the latest invoice/payment balance.` });
      }
      const allocatedAmount = fromPaise(toPaise(amount));
      try {
        await allocatePaymentRequest(createdPayment._id, { invoiceId, allocatedAmount });
      } catch (allocationError) {
        const message = allocationError.response?.data?.message || "";
        if (/outstanding amount/i.test(message)) {
          const latestInvoice = await getInvoiceRequest(invoiceId);
          const authoritativeLatestInvoice = latestInvoice?.invoice || latestInvoice?.data || latestInvoice;
          const latestAllowedPaise = Math.min(toPaise(authoritativeLatestInvoice?.balanceDue), toPaise(remaining));
          if (latestAllowedPaise > 0 && latestAllowedPaise < toPaise(allocatedAmount)) {
            const latestAllowed = fromPaise(latestAllowedPaise);
            setAllocation(String(latestAllowed));
            setPaymentErrors({ allocation: `Outstanding changed. Please allocate ${money(latestAllowed)} now.` });
            return;
          }
          setInvoiceId("");
          setAllocation("");
          setPaymentErrors({ allocation: "This invoice is already paid or has no available outstanding balance. Please select another invoice." });
          return;
        }
        throw allocationError;
      }
      setCreatedPayment((current) => ({ ...current, allocated: Number(current.allocated || 0) + allocatedAmount }));
      setInvoiceId("");
      setAllocation("");
      uiStore.getState().pushToast({ tone: "success", message: "Payment allocation recorded and reflected in derived payment reads." });
      await loadDetail();
    } catch (err) {
      await loadDetail();
      setPaymentErrors({ allocation: err.response?.data?.message || "Unable to allocate payment." });
    } finally {
      setAllocating(false);
    }
  };
  const scheduleCustomerReminder = async () => { const invoice = customerInvoices.find((row) => row.status !== "cancelled" && Number(row.balanceDue || 0) > 0); if (!invoice) return uiStore.getState().pushToast({ tone: "info", message: "No outstanding invoice is available for reminders." }); const defaultWhen = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16); const value = window.prompt("Schedule email reminder date/time", defaultWhen); if (!value) return; try { await scheduleInvoiceReminderRequest(invoice._id, { channel: "EMAIL", scheduledFor: new Date(value).toISOString() }); uiStore.getState().pushToast({ tone: "success", message: `Reminder scheduled for ${invoice.invoiceNumber}.` }); await loadDetail(); } catch (err) { setError(err.response?.data?.message || "Unable to schedule reminder."); } };
  const downloadStatement = async (type) => { if (!selected?._id) return; const blob = type === "pdf" ? await customerStatementPdfRequest(selected._id, statementFilters) : await customerStatementCsvRequest(selected._id, statementFilters); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `customer-statement-${selected.name}.${type}`; anchor.click(); URL.revokeObjectURL(url); };

  return <div className="mx-auto max-w-[1600px] space-y-6 pb-8">
    <PageHeader
      kicker={clientWorkspace ? "Client workspace" : "Customer workspace"}
      title={clientWorkspace ? "Clients" : "Customers"}
      description={`Manage ${noun}s, payments, reminders and account statements.`}
      actions={<button type="button" onClick={() => { setCustomerForm(blankCustomer); setEditor("new"); }} className="btn-primary"><Plus size={17} /> Add {noun}</button>}
    />
    {error ? <div role="alert" className="alert alert-error"><CircleAlert size={18} /><span className="flex-1">{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError("")}><X size={16} /></button></div> : null}
    <div className="grid items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="panel overflow-hidden lg:sticky lg:top-4">
        <div className="border-b p-3" style={{ borderColor: "var(--panel-border)" }}>
          <label className="relative block"><span className="sr-only">Search {noun}s</span><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--text-muted)" }} /><input name="search" value={filters.search} onChange={changeFilter} placeholder={`Search ${noun}s`} className="field" style={{ paddingLeft: "2.25rem" }} /></label>
          <p className="mt-2 px-1 text-xs" style={{ color: "var(--text-muted)" }}>{loading ? "Loading…" : `${result.items.length} ${noun}${result.items.length === 1 ? "" : "s"}`}</p>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1.5 lg:max-h-[calc(100dvh-14rem)]">
          {loading ? [1, 2, 3, 4].map((item) => <div key={item} className="m-1.5 h-12 animate-pulse rounded-lg bg-slate-500/10" />) : result.items.length ? result.items.map((customer) => {
            const active = customer._id === selected?._id;
            return <button key={customer._id} type="button" aria-current={active ? "true" : undefined} onClick={() => { setSelectedId(customer._id); setTab("overview"); }} className={`customer-row ${active ? "is-active" : ""}`}>
              <span className="customer-avatar" aria-hidden="true">{(customer.name || "?").trim().charAt(0).toUpperCase()}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{customer.name}</span><span className="block truncate text-xs" style={{ color: "var(--text-muted)" }}>{customer.email || customer.phone || "No contact details"}</span></span>
            </button>;
          }) : <div className="p-4 text-center text-sm" style={{ color: "var(--text-muted)" }}><p>{filters.search ? `No ${noun}s match “${filters.search}”.` : `No ${noun}s yet.`}</p><button type="button" onClick={() => { setCustomerForm(blankCustomer); setEditor("new"); }} className="btn-secondary mt-3"><Plus size={15} /> Add {noun}</button></div>}
        </div>
      </aside>
      <main className="min-w-0 space-y-5">{selected ? <><section className="panel p-5 sm:p-6"><div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between"><div className="min-w-0"><p className="page-kicker">{clientWorkspace ? "Client details" : "Customer details"}</p><h2 className="mt-1 truncate text-2xl font-bold tracking-tight">{selected.name}</h2><p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>{[selected.email, selected.phone].filter(Boolean).join(" · ") || "No contact details recorded"}</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => { setPaymentForm(blankPayment()); setPaymentErrors({}); setPaymentOpen(true); }} className="btn-primary"><WalletCards size={16} /> Receive payment</button><button type="button" onClick={() => { setCustomerForm({ ...blankCustomer, ...selected }); setEditor("edit"); }} className="btn-secondary">Edit {noun}</button><button type="button" onClick={deleteCustomer} className="btn-danger">Delete</button></div></div><div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[["Outstanding", metrics.outstanding], ["Overdue", metrics.overdue], ["Total invoiced", metrics.invoiced], ["Total collected", metrics.collected]].map(([label, value]) => <div key={label} className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-muted)" }}><p className="stat-label">{label}</p><p className={`mt-1.5 text-xl font-bold tabular-nums ${label === "Overdue" && Number(value) > 0 ? "text-rose-600" : label === "Outstanding" && Number(value) > 0 ? "text-amber-600" : ""}`}>{money(value)}</p></div>)}</div></section>
        <nav aria-label={`${noun} sections`} className="segmented no-scrollbar">{["overview", "invoices", "payments", "ledger", "statement", "communications"].map((item) => <button key={item} type="button" aria-current={tab === item ? "page" : undefined} onClick={() => setTab(item)} className={`segmented-item capitalize ${tab === item ? "is-active" : ""}`}>{item}</button>)}</nav>
        {loadingDetail ? <LoadingState title="Loading financial activity" description="Fetching invoices, payments, and ledger entries." /> : <section className="panel p-5 sm:p-6">{tab === "overview" ? <div className="grid gap-6 xl:grid-cols-2"><div><h4 className="font-semibold">Contact information</h4><dl className="mt-4 grid gap-3 text-sm"><div><dt style={{ color: "var(--text-muted)" }}>Billing address</dt><dd className="mt-1">{selected.billingAddress || "Not recorded"}</dd></div><div><dt style={{ color: "var(--text-muted)" }}>GSTIN</dt><dd className="mt-1">{selected.gstNumber || "Not recorded"}</dd></div><div><dt style={{ color: "var(--text-muted)" }}>Notes</dt><dd className="mt-1">{selected.notes || "No notes"}</dd></div></dl></div><Activity rows={ledger.slice(0, 6)} /></div> : null}{tab === "invoices" ? <InvoiceTable rows={customerInvoices} /> : null}{tab === "payments" ? <PaymentTable rows={customerPayments} /> : null}{tab === "ledger" ? <LedgerTable rows={ledger} /> : null}{tab === "statement" ? <StatementPanel statement={statement} filters={statementFilters} setFilters={setStatementFilters} loading={loadingStatement} onApply={loadStatement} onDownload={downloadStatement} /> : null}{tab === "communications" ? <CustomerCommunications reminders={customerReminders} deliveries={customerDeliveries} onSchedule={scheduleCustomerReminder} /> : null}</section>}</> : <EmptyState title={`Select a ${noun}`} description={`Choose a ${noun} from the list to open their invoices, payments and statement.`} />}</main></div>
    {editor ? <CustomerModal clientWorkspace={clientWorkspace} form={customerForm} setForm={setCustomerForm} mode={editor} saving={savingCustomer} error={error} onSave={saveCustomer} onClose={() => setEditor(null)} /> : null}
    {paymentOpen ? <PaymentModal form={paymentForm} setForm={setPaymentForm} errors={paymentErrors} saving={savingPayment} customer={selected} onSave={recordPayment} onClose={() => setPaymentOpen(false)} /> : null}
    {createdPayment ? <AllocationModal payment={createdPayment} allocated={allocated} remaining={remaining} invoices={customerInvoices} invoiceId={invoiceId} setInvoiceId={setInvoiceId} allocation={allocation} setAllocation={setAllocation} errors={paymentErrors} allocating={allocating} onSave={allocatePayment} onClose={() => setCreatedPayment(null)} /> : null}
  </div>;
};

const Field = ({ label, error, children }) => <label className="block"><span className="mb-2 block text-sm font-medium">{label}</span>{children}{error ? <span className="mt-1 block text-xs text-rose-600">{error}</span> : null}</label>;
const CustomerModal = ({ clientWorkspace, form, setForm, mode, saving, error, onSave, onClose }) => { const detectedStateCode = stateCodeFromGstin(form.gstNumber); return <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/55 p-4"><form id="customer-editor" onSubmit={onSave} className="mx-auto my-5 w-full max-w-2xl rounded-2xl border p-6 shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex justify-between"><div><p className="page-kicker">{clientWorkspace ? "Client details" : "Customer details"}</p><h3 className="mt-1 text-xl font-bold">{mode === "edit" ? clientWorkspace ? "Edit client" : "Edit customer" : clientWorkspace ? "Add client" : "Add customer"}</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>GSTIN is optional. State is detected locally with no paid lookup.</p></div><button type="button" aria-label="Close" onClick={onClose} className="btn-icon"><X size={18} /></button></div><div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label="Name"><input required value={form.name || ""} onChange={(event) => setForm((v) => ({ ...v, name: event.target.value }))} className="field" /></Field><Field label="Email"><input type="email" value={form.email || ""} onChange={(event) => setForm((v) => ({ ...v, email: event.target.value }))} className="field" /></Field><Field label="Phone"><input value={form.phone || ""} onChange={(event) => setForm((v) => ({ ...v, phone: event.target.value }))} className="field" /></Field><Field label="GSTIN (optional)"><input maxLength={15} value={form.gstNumber || ""} onChange={(event) => setForm((v) => updateCustomerGstFields(v, event.target.value))} placeholder="23ABCDE1234F1Z5" className="field uppercase" /></Field><Field label="Customer state"><select value={form.stateCode || ""} disabled={Boolean(detectedStateCode)} onChange={(event) => setForm((v) => ({ ...v, stateCode: event.target.value, placeOfSupplyCode: event.target.value }))} className="field disabled:opacity-70"><option value="">Select state manually</option>{Object.entries(gstStates).map(([code, state]) => <option key={code} value={code}>{state} ({code})</option>)}</select></Field><Field label="Billing address"><input value={form.billingAddress || ""} onChange={(event) => setForm((v) => ({ ...v, billingAddress: event.target.value }))} className="field" /></Field><Field label="Shipping address"><input value={form.shippingAddress || ""} onChange={(event) => setForm((v) => ({ ...v, shippingAddress: event.target.value }))} className="field" /></Field></div>{detectedStateCode ? <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">State detected from GSTIN: {gstStates[detectedStateCode]} ({detectedStateCode})</p> : null}<Field label="Notes"><textarea rows="3" value={form.notes || ""} onChange={(event) => setForm((v) => ({ ...v, notes: event.target.value }))} className="field" /></Field>{error ? <p role="alert" className="alert alert-error mt-4">{error}</p> : null}<div className="mt-6 flex justify-end gap-3"><button type="button" disabled={saving} onClick={onClose} className="btn-secondary">Cancel</button><button disabled={saving} className="btn-primary">{saving ? "Saving…" : clientWorkspace ? "Save client" : "Save customer"}</button></div></form></div>; };
const PaymentModal = ({ form, setForm, errors, saving, customer, onSave, onClose }) => <div className="fixed inset-0 z-50 overflow-y-auto flex items-start sm:items-center justify-center bg-slate-950/55 p-4"><form id="customer-payment-editor" onSubmit={onSave} className="w-full max-w-xl rounded-2xl border p-6 shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex justify-between"><div><p className="text-sm font-medium text-brand-600">Receive payment</p><h3 className="mt-1 text-xl font-semibold">Record a customer payment</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{customer.name}</p></div><button type="button" onClick={onClose}><X size={20} /></button></div><div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label="Amount" error={errors.amount}><input value={form.amount} onChange={(event) => setForm((v) => ({ ...v, amount: event.target.value }))} inputMode="decimal" placeholder="0.00" className="field" /></Field><Field label="Payment date" error={errors.paymentDate}><input type="date" value={form.paymentDate} onChange={(event) => setForm((v) => ({ ...v, paymentDate: event.target.value }))} className="field" /></Field><Field label="Payment method"><select value={form.paymentMethod} onChange={(event) => setForm((v) => ({ ...v, paymentMethod: event.target.value }))} className="field">{methods.map((method) => <option key={method}>{method}</option>)}</select></Field><Field label="Reference number"><input value={form.referenceNumber} onChange={(event) => setForm((v) => ({ ...v, referenceNumber: event.target.value }))} className="field" /></Field></div><Field label="Notes"><textarea rows="3" value={form.notes} onChange={(event) => setForm((v) => ({ ...v, notes: event.target.value }))} className="field" /></Field>{errors.form ? <p className="mt-3 text-sm text-rose-600">{errors.form}</p> : null}<p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">Record the received payment, then apply it to an invoice to update its balance.</p><div className="mt-6 flex justify-end gap-3"><button type="button" disabled={saving} onClick={onClose} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Cancel</button><button disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Recording..." : "Record payment"}</button></div></form></div>;
const AllocationModal = ({ payment, allocated, remaining, invoices, invoiceId, setInvoiceId, allocation, setAllocation, errors, allocating, onSave, onClose }) => <div className="fixed inset-0 z-50 overflow-y-auto flex items-start sm:items-center justify-center bg-slate-950/55 p-4"><div className="w-full max-w-xl rounded-2xl border p-6 shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex justify-between"><div className="flex gap-3"><CheckCircle2 className="mt-0.5 text-emerald-500" /><div><h3 className="text-xl font-semibold">Payment recorded</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Allocate it to an eligible invoice when ready.</p></div></div><button type="button" disabled={allocating} onClick={onClose} className="disabled:opacity-50"><X size={20} /></button></div><div className="mt-5 grid grid-cols-3 gap-3 rounded-xl bg-slate-500/[.06] p-4 text-sm"><div><p style={{ color: "var(--text-muted)" }}>Payment</p><strong>{money(payment.amount)}</strong></div><div><p style={{ color: "var(--text-muted)" }}>Allocated</p><strong>{money(allocated)}</strong></div><div><p style={{ color: "var(--text-muted)" }}>Remaining</p><strong>{money(remaining)}</strong></div></div><form id="customer-allocation-editor" onSubmit={onSave} className="mt-5"><h4 className="font-semibold">Allocate to invoice</h4><div className="mt-3 grid gap-3 sm:grid-cols-[1fr_140px]"><select value={invoiceId} disabled={allocating} onChange={(event) => { const nextInvoiceId = event.target.value; setInvoiceId(nextInvoiceId); const invoice = invoices.find((row) => row._id === nextInvoiceId); const maxAmount = Math.min(Number(invoice?.balanceDue || 0), Number(remaining || 0)); setAllocation(maxAmount > 0 ? String(maxAmount) : ""); }} className="field"><option value="">Select eligible invoice</option>{invoices.filter((invoice) => invoice.status !== "cancelled" && Number(invoice.balanceDue) > 0).map((invoice) => <option key={invoice._id} value={invoice._id}>{invoice.invoiceNumber} · Outstanding {money(invoice.balanceDue)}</option>)}</select><input value={allocation} disabled={allocating} onChange={(event) => setAllocation(event.target.value)} inputMode="decimal" placeholder="Amount" className="field" /></div>{errors.allocation ? <p className="mt-2 text-sm text-rose-600">{errors.allocation}</p> : null}<p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>Before saving, BillStack refreshes the invoice balance and caps the allocation to the latest available outstanding amount.</p><div className="mt-5 flex justify-end gap-3"><button onClick={onClose} disabled={allocating} type="button" className="rounded-xl border px-4 py-2.5 text-sm disabled:opacity-50" style={{ borderColor: "var(--panel-border)" }}>Done</button><button type="submit" disabled={allocating || remaining <= 0} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{allocating ? "Allocating..." : "Allocate payment"}</button></div></form></div></div>;const Table = ({ headers, rows, empty }) => <div className="overflow-x-auto"><table className="min-w-[640px] w-full text-left text-sm"><thead className="border-b text-xs uppercase tracking-wide" style={{ borderColor: "var(--panel-border)", color: "var(--text-muted)" }}><tr>{headers.map((header) => <th key={header} className="p-3 font-medium">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-b" style={{ borderColor: "var(--panel-border)" }}>{row.map((cell, cellIndex) => <td key={cellIndex} className="p-3 capitalize">{cell || "—"}</td>)}</tr>)}</tbody></table>{!rows.length ? <EmptyState title={empty} description="Activity will appear here when it is available." /> : null}</div>;
const InvoiceTable = ({ rows }) => <Table headers={["Invoice", "Issue date", "Due date", "Amount", "Payment state"]} rows={rows.map((row) => [row.invoiceNumber, date(row.invoiceDate), date(row.dueDate), money(row.grandTotal), row.paymentStatus])} empty="No invoices for this customer." />;
const PaymentTable = ({ rows }) => <Table headers={["Payment ID / reference", "Date", "Amount", "Method", "Status"]} rows={rows.map((row) => [row.referenceNumber || row._id.slice(-8), date(row.paymentDate), money(row.amount), row.paymentMethod, row.status])} empty="No recorded payments for this customer." />;
const LedgerTable = ({ rows }) => <Table headers={["Date", "Description", "Reference", "Debit / credit", "Amount"]} rows={rows.map((row) => [date(row.createdAt), row.eventType === "PAYMENT" ? "Payment recorded" : row.eventType, row.referenceNumber || row.paymentId?.referenceNumber || row.invoiceId?.invoiceNumber || "—", row.direction, money(row.amount)])} empty="No financial activity has been recorded yet." />;
const StatementPanel = ({ statement, filters, setFilters, loading, onApply, onDownload }) => <div className="space-y-5"><div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><div><h4 className="font-semibold">Customer Statement</h4><p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>Your account activity, payments and running balance.</p></div><div className="flex flex-wrap gap-2"><input type="date" value={filters.from} onChange={(e) => setFilters((v) => ({ ...v, from: e.target.value }))} className="field w-auto" /><input type="date" value={filters.to} onChange={(e) => setFilters((v) => ({ ...v, to: e.target.value }))} className="field w-auto" /><button onClick={onApply} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white">Apply</button><button onClick={() => window.print()} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Print</button><button onClick={() => onDownload("pdf")} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>PDF</button><button onClick={() => onDownload("csv")} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>CSV</button></div></div>{loading ? <LoadingState title="Loading statement" description="Calculating opening balance and running balance." /> : statement ? <><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[["Opening", statement.openingBalance], ["Debit", statement.totalDebit], ["Credit", statement.totalCredit], ["Closing", statement.closingBalance]].map(([label, value]) => <div key={label} className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}><p className="text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</p><p className="mt-2 text-xl font-semibold">{money(value)}</p></div>)}</div><Table headers={["Date", "Particulars", "Reference", "Debit", "Credit", "Balance"]} rows={(statement.transactions || []).map((row) => [date(row.date), row.type.replaceAll("_", " "), row.reference || "—", row.debit ? money(row.debit) : "", row.credit ? money(row.credit) : "", money(row.runningBalance)])} empty="No statement transactions for this period." /></> : <EmptyState title="No statement loaded" description="Choose a period and apply filters." />}</div>;
const CustomerCommunications = ({ reminders, deliveries, onSchedule }) => <div className="space-y-6"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><h4 className="font-semibold">Reminder and message history</h4><p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>Track scheduled payment reminders and delivery outcomes for this customer.</p></div><button onClick={onSchedule} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white"><BellRing size={16} /> Schedule reminder</button></div><div className="grid gap-5 xl:grid-cols-2"><div><p className="text-sm font-semibold">Upcoming reminders</p><Table headers={["Invoice", "Channel", "When", "Status"]} rows={reminders.map((row) => [row.invoiceId?.invoiceNumber || "—", row.channel, row.scheduledFor ? new Date(row.scheduledFor).toLocaleString("en-IN") : "—", row.status])} empty="No reminders scheduled for this customer." /></div><div><p className="text-sm font-semibold">Message history</p><Table headers={["Invoice", "Channel", "Status", "Sent / updated"]} rows={deliveries.map((row) => [row.invoiceId?.invoiceNumber || "—", row.channel, row.status, date(row.sentAt || row.updatedAt || row.createdAt)])} empty="No communication history for this customer." /></div></div></div>;
const Activity = ({ rows }) => <div><h4 className="font-semibold">Financial activity</h4>{rows.length ? <div className="mt-4 space-y-3">{rows.map((row) => <div key={row._id} className="flex items-center justify-between border-b pb-3 text-sm" style={{ borderColor: "var(--panel-border)" }}><div><p className="font-medium">{row.eventType === "PAYMENT" ? "Payment recorded" : row.eventType}</p><p className="text-xs" style={{ color: "var(--text-muted)" }}>{date(row.createdAt)}</p></div><strong className={row.direction === "CREDIT" ? "text-emerald-600" : "text-rose-600"}>{row.direction === "CREDIT" ? "+" : "−"}{money(row.amount)}</strong></div>)}</div> : <p className="mt-3 text-sm" style={{ color: "var(--text-muted)" }}>No financial activity recorded.</p>}</div>;

export default CustomersPage;
