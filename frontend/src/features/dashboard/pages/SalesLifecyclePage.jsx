import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Download, FileText, RefreshCw, RotateCcw, Send, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState, LoadingState } from "../../../components/ui/PageState";
import { uiStore } from "../../../store/uiStore";
import { authStore } from "../../../store/authStore";
import { useCreateAction } from "../../workspace/useCreateAction";
import { estimatedQuoteTotal } from "../formPresentation";
import GstLocationPreview from "../GstLocationPreview";
import PageHeader from "../../../components/ui/PageHeader";
import { isActiveModule, isRealEstateSelfHostedWorkspace, shouldShowWorkspaceNavigation } from "../../workspace/workspaceVisibility";
import {
  convertQuoteRequest,
  createCreditNoteRequest,
  createQuoteRequest,
  createSalesReturnRequest,
  downloadQuotePdfRequest,
  getBusinessModulesRequest,
  getQuoteRequest,
  listCreditNotesRequest,
  listCustomersRequest,
  listInvoicesRequest,
  listProductsRequest,
  listQuotesRequest,
  listSalesReturnsRequest,
  sendQuoteCommunicationRequest,
  updateQuoteRequest,
  updateQuoteStatusRequest,
} from "../../auth/api";

const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const date = (value) => value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const sourceKey = (prefix, payload) => `${prefix}:${encodeURIComponent(JSON.stringify(payload))}`;
const statusClass = (status) => ["ACCEPTED", "CONVERTED", "ISSUED"].includes(status) ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : ["REJECTED", "EXPIRED", "CANCELLED"].includes(status) ? "bg-rose-500/10 text-rose-700 dark:text-rose-300" : status === "SENT" ? "bg-brand-500/10 text-brand-700 dark:text-brand-200" : "bg-slate-500/10 text-slate-700 dark:text-slate-200";

const blankQuoteLine = () => ({ productId: "", productName: "", quantity: 1, rate: "", taxRate: "", hsnSac: "", discountValue: 0, discountType: "percent" });
const blankQuoteForm = () => ({ customerId: "", lineItems: [blankQuoteLine()], shippingCharges: 0, roundOff: 0 });
const blankCreditForm = () => ({ invoiceId: "", lineItems: [] });
const blankReturnForm = () => ({ invoiceId: "", lineItems: [] });
const salesTabs = [
  { key: "quotes", label: "Quotations", path: "/dashboard/quotes", moduleKey: "quotations" },
  { key: "creditNotes", label: "Credit Notes", path: "/dashboard/credit-notes", moduleKey: "credit_notes" },
  { key: "returns", label: "Sales Returns", path: "/dashboard/sales-returns", moduleKey: "sales_returns" },
];

const SalesLifecyclePage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { business } = authStore();
  const clientWorkspace = isRealEstateSelfHostedWorkspace(null, business);
  const initialTab = location.pathname.includes("credit-notes") ? "creditNotes" : location.pathname.includes("sales-returns") ? "returns" : "quotes";
  const [tab, setTab] = useState(initialTab);
  const [moduleData, setModuleData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [creditNotes, setCreditNotes] = useState([]);
  const [returns, setReturns] = useState([]);
  const [quoteForm, setQuoteForm] = useState(blankQuoteForm);
  const [editingQuote, setEditingQuote] = useState(null);
  const [selectedQuote, setSelectedQuote] = useState(null);
  const [creditForm, setCreditForm] = useState(blankCreditForm);
  const [returnForm, setReturnForm] = useState(blankReturnForm);
  const [saving, setSaving] = useState("");
  const pendingActionRef = useRef("");
  useCreateAction({ ready: !loading, moduleKey: "quotations", onCreate: () => { setTab("quotes"); setEditingQuote(null); setQuoteForm(blankQuoteForm()); setSelectedQuote(null); setError(""); }, focusSelector: '#quote-editor select' });

  const beginAction = (key) => {
    if (pendingActionRef.current) return false;
    pendingActionRef.current = key;
    setSaving(key);
    return true;
  };

  const endAction = () => {
    pendingActionRef.current = "";
    setSaving("");
  };

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const modules = await getBusinessModulesRequest();
      setModuleData(modules);
      const visibleKeys = new Set(salesTabs.filter((item) => isActiveModule(modules, item.moduleKey) && shouldShowWorkspaceNavigation(item.moduleKey, modules, business)).map((item) => item.key));
      const [customerData, productData, invoiceData, quoteData, creditData, returnData] = await Promise.all([
        listCustomersRequest({ page: 1, limit: 250 }),
        // Some workspaces hide the product catalog; quotations still work with typed items.
        listProductsRequest({ page: 1, limit: 250 }).catch(() => ({ items: [] })),
        listInvoicesRequest({ page: 1, limit: 250, sortBy: "invoiceDate", sortOrder: "desc" }),
        listQuotesRequest(),
        visibleKeys.has("creditNotes") ? listCreditNotesRequest() : Promise.resolve([]),
        visibleKeys.has("returns") ? listSalesReturnsRequest() : Promise.resolve([]),
      ]);
      setCustomers(customerData.items || []);
      setProducts(productData.items || []);
      setInvoices(invoiceData.items || []);
      setQuotes(quoteData || []);
      setCreditNotes(creditData || []);
      setReturns(returnData || []);
    } catch (loadError) {
      setError(loadError.response?.data?.message || "Unable to load sales lifecycle workspace.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  const visibleTabs = useMemo(() => salesTabs.filter((item) => isActiveModule(moduleData, item.moduleKey) && shouldShowWorkspaceNavigation(item.moduleKey, moduleData, business)), [moduleData, business]);
  useEffect(() => {
    if (!moduleData) return;
    const allowed = visibleTabs.some((item) => item.key === initialTab);
    const next = allowed ? initialTab : visibleTabs[0]?.key || "quotes";
    setTab(next);
    if (!allowed && location.pathname !== "/dashboard/quotes") navigate("/dashboard/quotes", { replace: true });
  }, [initialTab, location.pathname, moduleData, navigate, visibleTabs]);

  const openTab = (next) => {
    setTab(next);
    const target = visibleTabs.find((item) => item.key === next);
    navigate(target?.path || "/dashboard/quotes", { replace: true });
  };

  const productMap = useMemo(() => new Map(products.map((product) => [String(product._id), product])), [products]);
  const selectedCreditInvoice = invoices.find((invoice) => invoice._id === creditForm.invoiceId);
  const selectedReturnInvoice = invoices.find((invoice) => invoice._id === returnForm.invoiceId);
  const creditUsage = useMemo(() => usageByInvoiceLine(creditNotes, creditForm.invoiceId, "amount"), [creditNotes, creditForm.invoiceId]);
  const returnUsage = useMemo(() => usageByInvoiceLine(returns, returnForm.invoiceId, "quantity"), [returns, returnForm.invoiceId]);

  const saveQuote = async (event) => {
    event.preventDefault();
    if (!beginAction("quote")) return;
    try {
      const payload = normalizeQuotePayload(quoteForm, productMap);
      const row = editingQuote ? await updateQuoteRequest(editingQuote._id, payload) : await createQuoteRequest(payload);
      uiStore.getState().pushToast({ tone: "success", message: editingQuote ? "Draft quote updated." : "Quote created." });
      setEditingQuote(null);
      setQuoteForm(blankQuoteForm());
      setSelectedQuote(row);
      await load();
    } catch (saveError) {
      setError(saveError.response?.data?.message || "Unable to save quote.");
    } finally {
      endAction();
    }
  };

  const transitionQuote = async (quote, status) => {
    if (!beginAction(`${quote._id}-${status}`)) return;
    try {
      const row = await updateQuoteStatusRequest(quote._id, status);
      setSelectedQuote(row);
      uiStore.getState().pushToast({ tone: "success", message: `Quote marked ${status.toLowerCase()}.` });
      await load();
    } catch (transitionError) {
      setError(transitionError.response?.data?.message || "Unable to update quote status.");
    } finally {
      endAction();
    }
  };

  const convertQuote = async (quote) => {
    if (!beginAction(`${quote._id}-convert`)) return;
    try {
      const invoice = await convertQuoteRequest(quote._id);
      uiStore.getState().pushToast({ tone: "success", message: "Quote converted to invoice." });
      navigate(`/dashboard/invoices/${invoice._id}`);
    } catch (convertError) {
      setError(convertError.response?.data?.message || "Unable to convert quote.");
    } finally {
      endAction();
    }
  };

  const sendQuote = async (quote, channel) => {
    const key = `${quote._id}-send-${channel}`;
    if (!beginAction(key)) return;
    try {
      const row = await sendQuoteCommunicationRequest(quote._id, { channel, category: "QUOTATION" });
      uiStore.getState().pushToast({
        tone: row.status === "SENT" ? "success" : row.status === "FAILED" ? "error" : "info",
        message: row.status === "SENT" ? `Quotation sent by ${channel.toLowerCase()}.` : row.status === "FAILED" ? row.failureReason || `Quotation ${channel.toLowerCase()} could not be sent.` : `Quotation ${channel.toLowerCase()} queued as ${row.status.toLowerCase()}.`,
      });
      await load();
    } catch (sendError) {
      setError(sendError.response?.data?.message || `Unable to send quotation by ${channel.toLowerCase()}.`);
    } finally {
      endAction();
    }
  };

  const downloadQuote = async (quote) => {
    const key = `${quote._id}-download`;
    if (!beginAction(key)) return;
    try {
      const blob = await downloadQuotePdfRequest(quote._id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${quote.quoteNumber || "quotation"}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      setError(downloadError.response?.data?.message || "Unable to download quotation PDF.");
    } finally {
      endAction();
    }
  };

  const editQuote = async (quote) => {
    try {
      const detail = await getQuoteRequest(quote._id);
      setEditingQuote(detail);
      setQuoteForm({
        customerId: detail.customerId?._id || detail.customerId,
        lineItems: detail.lineItems?.map((line) => ({ productId: line.productId?._id || line.productId || "", productName: line.productName || "", hsnSac: line.hsnSac || "", quantity: line.quantity, rate: line.rate, taxRate: line.taxRate, discountValue: line.discountValue || 0, discountType: line.discountType || "percent" })) || [blankQuoteLine()],
        shippingCharges: detail.shippingCharges || 0,
        roundOff: detail.roundOff || 0,
      });
    } catch (detailError) {
      setError(detailError.response?.data?.message || "Unable to open quote.");
    }
  };

  const submitCreditNote = async (event) => {
    event.preventDefault();
    if (!beginAction("credit")) return;
    try {
      const payload = { ...creditForm, lineItems: creditForm.lineItems.filter((line) => Number(line.quantity) > 0 || Number(line.amount) > 0), sourceKey: sourceKey("CREDIT_NOTE_UI", creditForm) };
      const row = await createCreditNoteRequest(payload);
      uiStore.getState().pushToast({ tone: "success", message: "Credit note issued." });
      setCreditForm(blankCreditForm());
      await load();
      setTab("creditNotes");
      setError("");
      setTimeout(() => setSelectedQuote(row), 0);
    } catch (creditError) {
      setError(creditError.response?.data?.message || "Unable to issue credit note.");
    } finally {
      endAction();
    }
  };

  const submitReturn = async (event) => {
    event.preventDefault();
    if (!beginAction("return")) return;
    try {
      const payload = { ...returnForm, lineItems: returnForm.lineItems.filter((line) => Number(line.quantity) > 0), sourceKey: sourceKey("SALES_RETURN_UI", returnForm) };
      await createSalesReturnRequest(payload);
      uiStore.getState().pushToast({ tone: "success", message: "Sales return issued and inventory restored." });
      setReturnForm(blankReturnForm());
      await load();
      setTab("returns");
      setError("");
    } catch (returnError) {
      setError(returnError.response?.data?.message || "Unable to issue sales return.");
    } finally {
      endAction();
    }
  };

  if (loading) return <LoadingState title="Loading sales lifecycle" description="Fetching quotes, credit notes, returns, invoices, and products." />;
  if (!visibleTabs.length) return <EmptyState title="Sales actions are unavailable" description="These actions are not enabled in your workspace." />;

  return <div className="mx-auto max-w-[1500px] space-y-5 pb-6">
    <PageHeader
      kicker="Sales"
      title={visibleTabs.find((item) => item.key === tab)?.label}
      description={{ quotes: `Create, review, send and convert ${clientWorkspace ? "client" : "customer"} quotations into invoices.`, creditNotes: "Issue credit notes against invoices and track how much has been credited.", returns: "Record returned goods against invoices and keep stock in sync." }[tab]}
      actions={<button type="button" onClick={load} disabled={loading || Boolean(saving)} className="btn-secondary"><RefreshCw size={16} /> Refresh</button>}
    />
    {error ? <div role="alert" className="alert alert-error"><CircleAlert size={18} /><span className="flex-1">{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError("")}><X size={16} /></button></div> : null}
    {visibleTabs.length > 1 ? <nav aria-label="Sales sections" className="segmented no-scrollbar">{visibleTabs.map(({ key, label }) => <button key={key} type="button" aria-current={tab === key ? "page" : undefined} onClick={() => openTab(key)} className={`segmented-item ${tab === key ? "is-active" : ""}`}>{label}</button>)}</nav> : null}

    {tab === "quotes" ? <section className="space-y-5"><QuoteEditor form={quoteForm} setForm={setQuoteForm} editing={editingQuote} setEditing={setEditingQuote} products={products} customers={customers} clientWorkspace={clientWorkspace} saving={saving === "quote"} onSubmit={saveQuote} /><QuoteList rows={quotes} saving={saving} onView={setSelectedQuote} onEdit={editQuote} onTransition={transitionQuote} onConvert={convertQuote} onSend={sendQuote} onDownload={downloadQuote} /></section> : null}
    {tab === "creditNotes" ? <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]"><CreditNoteList rows={creditNotes} /><CreditNoteForm form={creditForm} setForm={setCreditForm} invoice={selectedCreditInvoice} invoices={invoices} usage={creditUsage} saving={saving === "credit"} onSubmit={submitCreditNote} /></section> : null}
    {tab === "returns" ? <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]"><SalesReturnList rows={returns} /><SalesReturnForm form={returnForm} setForm={setReturnForm} invoice={selectedReturnInvoice} invoices={invoices} usage={returnUsage} saving={saving === "return"} onSubmit={submitReturn} /></section> : null}
    {selectedQuote && tab === "quotes" ? <QuoteDetail quote={selectedQuote} onClose={() => setSelectedQuote(null)} /> : null}
  </div>;
};

const normalizeQuotePayload = (form, productMap) => ({
  ...form,
  lineItems: form.lineItems.map((line) => {
    const product = line.productId ? productMap.get(String(line.productId)) : null;
    return {
      ...line,
      productId: product ? product._id : null,
      productName: line.productName || product?.name || "Service",
      hsnSac: line.hsnSac !== undefined && line.hsnSac !== "" ? line.hsnSac : (product?.hsnSac || ""),
      quantity: Number(line.quantity || 0),
      rate: Number(line.rate !== "" && line.rate !== undefined ? line.rate : (product?.sellingPrice || 0)),
      taxRate: Number(line.taxRate !== "" && line.taxRate !== undefined ? line.taxRate : (product?.taxRate || 0)),
      discountValue: Number(line.discountValue || 0),
    };
  }),
});
const usageByInvoiceLine = (rows, invoiceId, field) => rows.filter((row) => String(row.invoiceId?._id || row.invoiceId) === String(invoiceId)).reduce((map, row) => { (row.lineItems || []).forEach((line) => map.set(Number(line.invoiceLineIndex), Number(map.get(Number(line.invoiceLineIndex)) || 0) + Number(line[field] || 0))); return map; }, new Map());
const lineValue = (line, quantity) => Number(line.quantity || 0) > 0 ? Number(line.itemTotal || 0) * Number(quantity || 0) / Number(line.quantity || 1) : 0;

const Field = ({ label, children }) => <label className="block"><span className="mb-2 block text-sm font-medium">{label}</span>{children}</label>;
const TableShell = ({ title, description, children }) => <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><div><h3 className="text-lg font-semibold">{title}</h3>{description ? <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{description}</p> : null}</div><div className="mt-4 overflow-x-auto rounded-xl border no-scrollbar" style={{ borderColor: "var(--panel-border)" }}>{children}</div></section>;

const QuoteList = ({ rows, saving, onView, onEdit, onTransition, onConvert, onSend, onDownload }) => (
<TableShell title="Quotation list">
    <table className="w-full min-w-[720px] text-left text-sm">
      <thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        <tr><th className="p-3">Quote #</th><th className="p-3">Customer</th><th className="p-3">Created</th><th className="p-3 text-right">Amount</th><th className="p-3">Status</th><th className="p-3 text-right">Actions</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
            <td className="p-3 font-semibold">{row.quoteNumber}</td>
            <td className="p-3">{row.customerSnapshot?.name || row.customerId?.name || "Customer"}</td>
            <td className="p-3">{date(row.createdAt)}</td>
            <td className="p-3 text-right">{money(row.grandTotal)}</td>
            <td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(row.status)}`}>{row.status}</span></td>
            <td className="p-3">
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => onView(row)} className="rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: "var(--panel-border)" }}>View</button>
                <button type="button" disabled={saving === `${row._id}-download`} onClick={() => onDownload(row)} className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50" style={{ borderColor: "var(--panel-border)" }}><Download size={13} /> PDF</button>
                {row.status === "DRAFT" ? <button type="button" onClick={() => onEdit(row)} className="rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: "var(--panel-border)" }}>Edit</button> : null}
                {["DRAFT", "SENT", "ACCEPTED"].includes(row.status) ? <button type="button" disabled={saving === `${row._id}-send-EMAIL`} onClick={() => onSend(row, "EMAIL")} className="rounded-lg border border-brand-500/30 px-2.5 py-1.5 text-xs font-medium text-brand-700 disabled:opacity-50">Send email</button> : null}
                {["DRAFT", "SENT", "ACCEPTED"].includes(row.status) ? <button type="button" disabled className="rounded-lg border px-2.5 py-1.5 text-xs text-slate-400" title="WhatsApp sending is disabled for this preview">WhatsApp off</button> : null}
                {row.status === "DRAFT" ? <button type="button" disabled={saving === `${row._id}-SENT`} onClick={() => onTransition(row, "SENT")} className="rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50">Mark sent</button> : null}
                {row.status === "SENT" ? <><button type="button" onClick={() => onTransition(row, "ACCEPTED")} className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white">Accept</button><button type="button" onClick={() => onTransition(row, "REJECTED")} className="rounded-lg border border-rose-500/40 px-2.5 py-1.5 text-xs text-rose-600">Reject</button><button type="button" onClick={() => onTransition(row, "EXPIRED")} className="rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: "var(--panel-border)" }}>Expire</button></> : null}
                {row.status === "ACCEPTED" ? <button type="button" onClick={() => onConvert(row)} className="rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white">Convert</button> : null}
                {row.status === "CONVERTED" ? <span className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700">Converted</span> : null}
              </div>
            </td>
          </tr>
        ))}
        {!rows.length ? <tr><td colSpan="6" className="p-8"><EmptyState title="No quotes yet" description="Create a quote to begin the sales lifecycle." /></td></tr> : null}
      </tbody>
    </table>
  </TableShell>
);

const QuoteEditor = ({ form, setForm, editing, setEditing, products, customers, clientWorkspace, saving, onSubmit }) => {
  const updateLine = (index, patch) => setForm((value) => ({ ...value, lineItems: value.lineItems.map((line, i) => i === index ? { ...line, ...patch } : line) }));
  const addLine = () => setForm((value) => ({ ...value, lineItems: [...value.lineItems, blankQuoteLine()] }));
  const addCustomLine = () => setForm((value) => ({ ...value, lineItems: [...value.lineItems, { ...blankQuoteLine(), productId: "" }] }));
  const removeLine = (index) => setForm((value) => ({ ...value, lineItems: value.lineItems.filter((_, i) => i !== index) || [blankQuoteLine()] }));
  const reset = () => { setEditing(null); setForm(blankQuoteForm()); };
  return <form id="quote-editor" onSubmit={onSubmit} className="rounded-2xl border p-5 sm:p-6" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-brand-600">Quotation details</p><h3 className="mt-1 text-xl font-semibold">{editing ? "Edit draft quotation" : "Create quotation"}</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Choose a {clientWorkspace ? "client" : "customer"}, add services and confirm the estimated total.</p></div>{editing ? <button type="button" onClick={reset} className="rounded-lg p-2 hover:bg-slate-500/10" aria-label="Close quote editor"><X size={18} /></button> : null}</div>
    <div className="mt-6 grid gap-4 lg:grid-cols-2"><Field label={clientWorkspace ? "Client" : "Customer"}><select required value={form.customerId} onChange={(event) => setForm((value) => ({ ...value, customerId: event.target.value }))} className="field"><option value="">Select {clientWorkspace ? "client" : "customer"}</option>{customers.map((customer) => <option key={customer._id} value={customer._id}>{customer.name}</option>)}</select></Field><GstLocationPreview form={form} setForm={setForm} customers={customers} /></div>
    <div className="mt-5 space-y-3">{form.lineItems.map((line, index) => <div key={index} className="rounded-xl border bg-slate-500/[.02] p-4" style={{ borderColor: "var(--panel-border)" }}>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Item {index + 1}</p>
          {line.productId ? (
            <span className="rounded-md bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-300">Saved Catalog Service</span>
          ) : (
            <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">Custom / Manual Item</span>
          )}
        </div>
        {form.lineItems.length > 1 ? <button type="button" onClick={() => removeLine(index)} className="text-xs font-medium text-rose-600">Remove</button> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Saved service / product">
          <select value={line.productId || ""} onChange={(event) => {
            const selectedId = event.target.value;
            const product = products.find((item) => item._id === selectedId);
            if (product) {
              updateLine(index, {
                productId: product._id,
                productName: product.name,
                rate: product.sellingPrice ?? line.rate,
                taxRate: product.taxRate ?? line.taxRate,
                hsnSac: product.hsnSac || line.hsnSac,
              });
            } else {
              updateLine(index, { productId: "" });
            }
          }} className="field">
            <option value="">Custom / Manual (type below)</option>
            {products.map((product) => (
              <option key={product._id} value={product._id}>
                {product.name} {product.itemType === "service" || !product.trackInventory ? "· Service" : `· Stock ${product.currentStock}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Item / service description">
          <input required value={line.productName || ""} onChange={(event) => updateLine(index, { productName: event.target.value })} placeholder="Type item or service name" className="field" />
        </Field>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-[100px_130px_120px_100px_110px_140px]">
        <Field label="Qty"><input required type="number" min="0.01" step="0.01" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} className="field" /></Field>
        <Field label="Rate"><input type="number" min="0" step="0.01" value={line.rate} onChange={(event) => updateLine(index, { rate: event.target.value })} className="field" /></Field>
        <Field label="HSN / SAC"><input value={line.hsnSac || ""} onChange={(event) => updateLine(index, { hsnSac: event.target.value })} placeholder="e.g. 997212" className="field" /></Field>
        <Field label="GST %"><input type="number" min="0" step="0.01" value={line.taxRate} onChange={(event) => updateLine(index, { taxRate: event.target.value })} className="field" /></Field>
        <Field label="Discount"><input type="number" min="0" step="0.01" value={line.discountValue} onChange={(event) => updateLine(index, { discountValue: event.target.value })} className="field" /></Field>
        <Field label="Discount type"><select value={line.discountType} onChange={(event) => updateLine(index, { discountType: event.target.value })} className="field"><option value="percent">Percent</option><option value="amount">Amount</option></select></Field>
      </div>
    </div>)}</div>
    <div className="mt-5 flex flex-col gap-4 border-t pt-5 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--panel-border)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={addLine} className="rounded-xl border px-4 py-2.5 text-sm font-medium" style={{ borderColor: "var(--panel-border)" }}>+ Add catalog item</button>
        <button type="button" onClick={addCustomLine} className="rounded-xl border px-4 py-2.5 text-sm font-medium" style={{ borderColor: "var(--panel-border)" }}>+ Add custom item / service</button>
        <div><p className="text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Estimated total</p><p className="mt-0.5 text-lg font-semibold">{money(estimatedQuoteTotal(form))}</p></div>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <button type="button" disabled={saving} onClick={reset} className="rounded-xl border px-4 py-2.5 text-sm font-medium" style={{ borderColor: "var(--panel-border)" }}>{editing ? "Cancel editing" : "Reset"}</button>
        <button disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"><Send size={16} /> {saving ? "Saving..." : editing ? "Update quotation" : "Create quotation"}</button>
      </div>
    </div>
  </form>;
};

const QuoteDetail = ({ quote, onClose }) => <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/55 p-4"><div className="mx-auto my-6 w-full max-w-3xl rounded-2xl border p-6 shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-brand-600">Quote detail</p><h3 className="mt-1 text-2xl font-semibold">{quote.quoteNumber}</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{quote.customerSnapshot?.name || "Customer"} · {date(quote.createdAt)}</p></div><button onClick={onClose}><X size={20} /></button></div><div className="mt-5 overflow-x-auto rounded-xl border" style={{ borderColor: "var(--panel-border)" }}><table className="min-w-[650px] w-full text-left text-sm"><thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}><tr><th className="p-3">Item</th><th className="p-3 text-right">Qty</th><th className="p-3 text-right">Rate</th><th className="p-3 text-right">Tax</th><th className="p-3 text-right">Total</th></tr></thead><tbody>{quote.lineItems?.map((line, index) => <tr key={index} className="border-t" style={{ borderColor: "var(--panel-border)" }}><td className="p-3 font-medium">{line.productName}</td><td className="p-3 text-right">{line.quantity}</td><td className="p-3 text-right">{money(line.rate)}</td><td className="p-3 text-right">{money(line.tax)}</td><td className="p-3 text-right">{money(line.itemTotal)}</td></tr>)}</tbody></table></div><div className="ml-auto mt-5 max-w-xs space-y-2 text-sm"><Amount label="Subtotal" value={money(quote.subtotal)} /><Amount label="Discount" value={money(quote.totalDiscount)} /><Amount label="Tax" value={money(quote.totalTax)} /><Amount label="Grand total" value={money(quote.grandTotal)} strong /></div></div></div>;

const CreditNoteList = ({ rows }) => <TableShell title="Credit notes" description="Credits issued against customer invoices."><table className="min-w-[780px] w-full text-left text-sm"><thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}><tr><th className="p-3">Credit note</th><th className="p-3">Invoice</th><th className="p-3">Customer</th><th className="p-3 text-right">Amount</th><th className="p-3">Status</th><th className="p-3">Created</th></tr></thead><tbody>{rows.map((row) => <tr key={row._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}><td className="p-3 font-semibold">{row.creditNoteNumber}</td><td className="p-3">{row.invoiceId?.invoiceNumber || String(row.invoiceId || "").slice(-8)}</td><td className="p-3">{row.customerId?.name || "Customer"}</td><td className="p-3 text-right">{money(row.totalAmount)}</td><td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(row.status)}`}>{row.status}</span></td><td className="p-3">{date(row.createdAt)}</td></tr>)}{!rows.length ? <tr><td colSpan="6" className="p-8"><EmptyState title="No credit notes" description="Issue a partial or full credit against an eligible invoice." /></td></tr> : null}</tbody></table></TableShell>;

const CreditNoteForm = ({ form, setForm, invoice, invoices, usage, saving, onSubmit }) => <form onSubmit={onSubmit} className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><h3 className="text-lg font-semibold">Issue credit note</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Select an invoice and check the remaining credit available.</p><div className="mt-4 grid gap-4"><Field label="Eligible invoice"><select required value={form.invoiceId} onChange={(event) => { const next = invoices.find((item) => item._id === event.target.value); setForm({ invoiceId: event.target.value, lineItems: (next?.lineItems || []).map((line, index) => ({ invoiceLineIndex: index, productId: line.productId?._id || line.productId, quantity: 0, amount: 0 })) }); }} className="field"><option value="">Select invoice</option>{invoices.filter((invoice) => invoice.status !== "cancelled").map((invoice) => <option key={invoice._id} value={invoice._id}>{invoice.invoiceNumber} · {money(invoice.grandTotal)}</option>)}</select></Field>{invoice?.lineItems?.map((line, index) => { const remainingAmount = Math.max(Number(line.itemTotal || 0) - Number(usage.get(index) || 0), 0); const selectedLine = form.lineItems[index] || {}; return <div key={index} className="rounded-xl border p-3" style={{ borderColor: "var(--panel-border)" }}><p className="font-medium">{line.productName}</p><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Sold {line.quantity} · remaining credit value {money(remainingAmount)}</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><Field label="Credit quantity"><input type="number" min="0" step="0.01" value={selectedLine.quantity || ""} onChange={(event) => setForm((value) => ({ ...value, lineItems: value.lineItems.map((row, i) => i === index ? { ...row, quantity: event.target.value, amount: lineValue(line, event.target.value) } : row) }))} className="field" /></Field><Field label="Credit amount"><input type="number" min="0" step="0.01" max={remainingAmount} value={selectedLine.amount || ""} onChange={(event) => setForm((value) => ({ ...value, lineItems: value.lineItems.map((row, i) => i === index ? { ...row, amount: event.target.value } : row) }))} className="field" /></Field></div></div>; })}<button disabled={saving || !form.invoiceId} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 lg:col-start-2"><FileText size={16} /> {saving ? "Issuing..." : "Issue credit note"}</button></div></form>;

const SalesReturnList = ({ rows }) => <TableShell title="Sales returns" description="Returns restore inventory through RETURN stock movements and post a customer ledger adjustment."><table className="min-w-[760px] w-full text-left text-sm"><thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}><tr><th className="p-3">Return</th><th className="p-3">Invoice</th><th className="p-3">Customer</th><th className="p-3 text-right">Amount</th><th className="p-3">Status</th><th className="p-3">Created</th></tr></thead><tbody>{rows.map((row) => <tr key={row._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}><td className="p-3 font-semibold">{row.returnNumber}</td><td className="p-3">{row.invoiceId?.invoiceNumber || String(row.invoiceId || "").slice(-8)}</td><td className="p-3">{row.customerId?.name || "Customer"}</td><td className="p-3 text-right">{money(row.totalAmount)}</td><td className="p-3"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusClass(row.status)}`}>{row.status}</span></td><td className="p-3">{date(row.createdAt)}</td></tr>)}{!rows.length ? <tr><td colSpan="6" className="p-8"><EmptyState title="No sales returns" description="Process returns from eligible invoice lines." /></td></tr> : null}</tbody></table></TableShell>;

const SalesReturnForm = ({ form, setForm, invoice, invoices, usage, saving, onSubmit }) => <form onSubmit={onSubmit} className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><h3 className="text-lg font-semibold">Create sales return</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Sold, returned, and remaining quantities are shown before submission.</p><div className="mt-4 grid gap-4"><Field label="Eligible invoice"><select required value={form.invoiceId} onChange={(event) => { const next = invoices.find((item) => item._id === event.target.value); setForm({ invoiceId: event.target.value, lineItems: (next?.lineItems || []).map((line, index) => ({ invoiceLineIndex: index, productId: line.productId?._id || line.productId, quantity: 0 })) }); }} className="field"><option value="">Select invoice</option>{invoices.filter((invoice) => invoice.status !== "cancelled").map((invoice) => <option key={invoice._id} value={invoice._id}>{invoice.invoiceNumber} · {money(invoice.grandTotal)}</option>)}</select></Field>{invoice?.lineItems?.map((line, index) => { const returned = Number(usage.get(index) || 0); const remaining = Math.max(Number(line.quantity || 0) - returned, 0); const selectedLine = form.lineItems[index] || {}; return <div key={index} className="rounded-xl border p-3" style={{ borderColor: "var(--panel-border)" }}><p className="font-medium">{line.productName}</p><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Sold {line.quantity} · already returned {returned} · remaining {remaining}</p><Field label="Return quantity"><input type="number" min="0" max={remaining} step="0.01" value={selectedLine.quantity || ""} onChange={(event) => setForm((value) => ({ ...value, lineItems: value.lineItems.map((row, i) => i === index ? { ...row, quantity: event.target.value } : row) }))} className="field" /></Field></div>; })}<button disabled={saving || !form.invoiceId} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60 lg:col-start-2"><RotateCcw size={16} /> {saving ? "Processing..." : "Issue sales return"}</button></div></form>;

const Amount = ({ label, value, strong }) => <div className={`flex items-center justify-between gap-4 ${strong ? "border-t pt-3 text-base font-semibold" : ""}`} style={strong ? { borderColor: "var(--panel-border)" } : {}}><span style={{ color: "var(--text-muted)" }}>{label}</span><span>{value}</span></div>;

export default SalesLifecyclePage;
