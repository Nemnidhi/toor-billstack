import { useEffect, useState } from "react";
import { ArrowLeft, BellRing, CheckCircle2, CircleAlert, Download, FileCheck2, LoaderCircle, Mail, MessageCircle, QrCode, ReceiptIndianRupee, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../../components/ui/PageState";
import { authStore } from "../../../store/authStore";
import { uiStore } from "../../../store/uiStore";
import { isRealEstateSelfHostedWorkspace } from "../../workspace/workspaceVisibility";
import {
  allocatePaymentRequest,
  cancelInvoiceRequest,
  checkEInvoiceReadinessRequest,
  communicationDeliveriesRequest,
  communicationScheduledRequest,
  communicationSummaryRequest,
  communicationTemplatesRequest,
  createPaymentRequest,
  getCustomerAdvancesRequest,
  reissueInvoiceRequest,
  downloadInvoicePdfRequest,
  emailInvoiceRequest,
  getEInvoiceDetailsRequest,
  getInvoiceRequest,
  listInvoiceAllocationsRequest,
  prepareEInvoicePayloadRequest,
  reversePaymentAllocationRequest,
  scheduleInvoiceReminderRequest,
  sendInvoiceCommunicationRequest,
} from "../../auth/api";

const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const date = (value) => value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const timestamp = (value) => value ? new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const today = () => new Date().toISOString().slice(0, 10);
const newPaymentForm = (amount = "") => ({ amount: String(amount || ""), paymentDate: today(), paymentMethod: "BANK_TRANSFER", referenceNumber: "", notes: "", idempotencyKey: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` });
const dateKey = (value) => (value ? new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "");
const isOverdue = (dueDate) => dateKey(new Date()) > dateKey(dueDate);
const status = (invoice) => invoice.status === "cancelled" ? ["Cancelled", "bg-slate-500/10 text-slate-700 dark:text-slate-200"] : invoice.paymentStatus === "paid" ? ["Paid", "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"] : invoice.paymentStatus === "partial" ? ["Partially paid", "bg-amber-500/10 text-amber-700 dark:text-amber-300"] : Number(invoice.balanceDue || 0) > 0 && isOverdue(invoice.dueDate) ? ["Overdue", "bg-rose-500/10 text-rose-700 dark:text-rose-300"] : ["Pending", "bg-brand-500/10 text-brand-700 dark:text-brand-200"];
const templateCategoryLabel = (value) => ({ INVOICE_CREATED: "Invoice Created", DUE_TODAY: "Payment Due Today", PAYMENT_OVERDUE: "Payment Overdue", PAYMENT_REMINDER: "Payment Reminder", PAYMENT_RECEIVED: "Payment Received", CREDIT_NOTE: "Credit Note", SALES_RETURN: "Sales Return", QUOTATION: "Quotation", CUSTOM: "Custom" }[value] || String(value || "Custom").replaceAll("_", " "));

const InvoiceDetailPage = () => {
  const { invoiceId } = useParams();
  const navigate = useNavigate();
  const { business: workspaceBusiness, user } = authStore();
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [active, setActive] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [customerAdvances, setCustomerAdvances] = useState(null);
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [advanceAllocationAmount, setAdvanceAllocationAmount] = useState("");
  const [selectedAdvancePaymentId, setSelectedAdvancePaymentId] = useState("");
  const [advanceError, setAdvanceError] = useState("");
  const [eInvoice, setEInvoice] = useState(null);
  const [eInvoiceResult, setEInvoiceResult] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [providerStatus, setProviderStatus] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [communicationForm, setCommunicationForm] = useState({ channel: "EMAIL", category: "INVOICE_CREATED", templateId: "" });
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentForm, setPaymentForm] = useState(newPaymentForm);
  const [paymentError, setPaymentError] = useState("");
  const [reversing, setReversing] = useState(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getInvoiceRequest(invoiceId);
      setInvoice(data);
      if (data.gstSnapshot) {
        try {
          setEInvoice(await getEInvoiceDetailsRequest(invoiceId));
        } catch {
          setEInvoice(data.eInvoice || null);
        }
      } else {
        setEInvoice(null);
      }
      try {
        const [deliveryRows, reminderRows, allocationRows, communicationData, templateRows] = await Promise.all([
          communicationDeliveriesRequest({ invoiceId }),
          communicationScheduledRequest({ invoiceId }),
          listInvoiceAllocationsRequest(invoiceId),
          communicationSummaryRequest(),
          communicationTemplatesRequest(),
        ]);
        setDeliveries(deliveryRows || []);
        setReminders(reminderRows || []);
        setAllocations(allocationRows || []);
        setProviderStatus(communicationData?.providerStatus || null);
        setTemplates(templateRows || []);
      } catch {
        setDeliveries([]);
        setReminders([]);
        setAllocations([]);
        setProviderStatus(null);
        setTemplates([]);
      }
    } catch (err) {
      setError(err.response?.status === 404 ? "Invoice not found." : err.response?.data?.message || "Unable to load invoice.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [invoiceId]);

  const download = async () => {
    try {
      setActive("pdf");
      const blob = await downloadInvoicePdfRequest(invoice._id, true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${invoice.invoiceNumber}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      uiStore.getState().pushToast({ tone: "success", message: "Invoice PDF downloaded." });
    } catch (err) {
      setError(err.response?.data?.message || "Unable to download invoice PDF.");
    } finally {
      setActive("");
    }
  };

  const email = async () => {
    const recipient = window.prompt("Send invoice to email:", invoice.customerId?.email || invoice.customerDetails?.email || "");
    if (!recipient) return;
    try {
      setActive("email");
      await emailInvoiceRequest(invoice._id, recipient);
      uiStore.getState().pushToast({ tone: "success", message: "Invoice emailed successfully." });
    } catch (err) {
      setError(err.response?.data?.message || "Unable to email invoice.");
    } finally {
      setActive("");
    }
  };

  const checkReadiness = async () => {
    try {
      setActive("echeck");
      const data = await checkEInvoiceReadinessRequest(invoice._id);
      setEInvoice(data.metadata);
      setEInvoiceResult(data);
      uiStore.getState().pushToast({ tone: data.readiness?.readiness === "READY" ? "success" : "info", message: data.readiness?.readiness === "READY" ? "Invoice is e-invoice ready." : "E-invoice readiness needs attention." });
    } catch (err) {
      setError(err.response?.data?.message || "Unable to check e-invoice readiness.");
    } finally {
      setActive("");
    }
  };

  const preparePayload = async () => {
    try {
      setActive("epayload");
      const data = await prepareEInvoicePayloadRequest(invoice._id);
      setEInvoice(data.metadata);
      setEInvoiceResult(data);
      uiStore.getState().pushToast({ tone: "success", message: "Validated e-invoice payload prepared. IRP submission is not configured." });
    } catch (err) {
      setError(err.response?.data?.message || "Unable to prepare e-invoice payload.");
    } finally {
      setActive("");
    }
  };

  const sendViaChannel = async () => {
    const channel = communicationForm.channel;
    try {
      setActive(`send-${channel}`);
      const row = await sendInvoiceCommunicationRequest(invoice._id, { channel, category: communicationForm.category, templateId: communicationForm.templateId || undefined });
      uiStore.getState().pushToast({ tone: row.status === "SENT" ? "success" : "info", message: row.status === "SENT" ? `${channel} message sent.` : `${channel} message recorded as ${row.status}.` });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || `Unable to send via ${channel}.`);
    } finally {
      setActive("");
    }
  };

  const scheduleReminder = async () => {
    const scheduledFor = window.prompt("Schedule reminder at ISO date/time:", new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16));
    if (!scheduledFor) return;
    try {
      setActive("schedule-reminder");
      await scheduleInvoiceReminderRequest(invoice._id, { channel: "EMAIL", scheduledFor });
      uiStore.getState().pushToast({ tone: "success", message: "Reminder scheduled." });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to schedule reminder.");
    } finally {
      setActive("");
    }
  };

  const cancel = async () => {
    try {
      setActive("cancel");
      await cancelInvoiceRequest(invoice._id);
      setShowCancel(false);
      uiStore.getState().pushToast({ tone: "success", message: "Invoice cancelled successfully." });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to cancel invoice.");
    } finally {
      setActive("");
    }
  };

  const openPayment = () => {
    setPaymentError("");
    setPaymentForm(newPaymentForm(invoice.balanceDue));
    setPaymentOpen(true);
  };

    const handleApplyAdvance = async (e) => {
    e.preventDefault();
    const amount = Number(advanceAllocationAmount);
    if (!amount || amount <= 0) return setAdvanceError("Enter a valid allocation amount.");
    if (amount > invoice.balanceDue) return setAdvanceError("Allocation cannot exceed invoice balance due.");
    if (!selectedAdvancePaymentId) return setAdvanceError("Select an advance payment.");

    try {
      setActive("advance");
      setAdvanceError("");
      await allocatePaymentRequest(selectedAdvancePaymentId, {
        invoiceId: invoice._id,
        allocatedAmount: amount,
      });
      setShowAdvanceModal(false);
      uiStore.getState().pushToast({ tone: "success", message: `${money(amount)} advance credit applied to ${invoice.invoiceNumber}.` });
      await load();
    } catch (err) {
      setAdvanceError(err.response?.data?.message || err.message || "Failed to apply advance.");
    } finally {
      setActive("");
    }
  };

  const handleReissue = async () => {
    if (!window.confirm(`Are you sure you want to reissue a replacement invoice for cancelled invoice ${invoice.invoiceNumber}?`)) return;
    try {
      setActive("reissue");
      const reissued = await reissueInvoiceRequest(invoice._id);
      uiStore.getState().pushToast({ tone: "success", message: `Invoice reissued successfully as ${reissued.invoiceNumber}.` });
      navigate(`/dashboard/invoices/${reissued._id}`);
    } catch (err) {
      setError(err.response?.data?.message || err.message || "Unable to reissue invoice.");
    } finally {
      setActive("");
    }
  };

  const recordPayment = async (event) => {
    event.preventDefault();
    const amount = Number(paymentForm.amount);
    const balance = Number(invoice.balanceDue || 0);
    if (!Number.isFinite(amount) || amount <= 0) return setPaymentError("Enter an amount greater than zero.");
    if (amount > balance) return setPaymentError(`Payment cannot exceed the remaining balance of ${money(balance)}.`);
    try {
      setActive("payment");
      setPaymentError("");
      const payment = await createPaymentRequest({ ...paymentForm, amount, direction: "RECEIVED", currency: "INR", customerId: invoice.customerId?._id || invoice.customerId });
      await allocatePaymentRequest(payment._id, { invoiceId: invoice._id, allocatedAmount: amount });
      setPaymentOpen(false);
      uiStore.getState().pushToast({ tone: "success", message: `${money(amount)} received and applied to ${invoice.invoiceNumber}.` });
      await load();
    } catch (err) {
      setPaymentError(err.response?.data?.message || err.message || "Unable to record payment.");
    } finally {
      setActive("");
    }
  };

  const reversePayment = async (row) => {
    const reason = window.prompt("Reason for reversing this payment:");
    if (!reason?.trim()) return;
    try {
      setReversing(row.allocationId);
      await reversePaymentAllocationRequest(row.allocationId, { amount: row.allocatedAmount, reason: reason.trim() });
      uiStore.getState().pushToast({ tone: "success", message: "Payment reversed and invoice balance restored." });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to reverse payment.");
    } finally {
      setReversing(null);
    }
  };

  const downloadReceipt = (row) => {
    const receipt = `PAYMENT RECEIPT\n\nInvoice: ${invoice.invoiceNumber}\nCustomer: ${invoice.customerId?.name || invoice.customerDetails?.name || "Customer"}\nPayment date: ${date(row.payment?.paymentDate || row.createdAt)}\nAmount received: ${money(row.allocatedAmount)}\nMethod: ${row.payment?.paymentMethod || "Not captured"}\nReference: ${row.payment?.referenceNumber || "—"}\nStatus: ${row.reversal ? "REVERSED" : "RECEIVED"}\n`;
    const url = URL.createObjectURL(new Blob([receipt], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${invoice.invoiceNumber}-payment-receipt.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (loading) return <LoadingState title="Loading invoice" description="Fetching invoice details for this business." />;
  if (!invoice) return <ErrorState title="Invoice unavailable" description={error || "The requested invoice could not be found."} />;

  const [paymentLabel, paymentClass] = status(invoice);
  const customer = invoice.customerId || invoice.customerDetails || {};
  const business = invoice.sellerSnapshot ? { ...invoice.sellerSnapshot, gstNumber: invoice.sellerSnapshot.gstTaxId } : invoice.businessDetails || {};
  const isRealEstateSelfHosted = isRealEstateSelfHostedWorkspace(null, workspaceBusiness);
  const hasNotesOrTerms = Boolean(invoice.notes || invoice.termsAndConditions);
  const canManagePayments = ["owner", "admin", "accountant"].includes(user?.role);

  return <div className="mx-auto max-w-[1500px] space-y-6 pb-8">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <button onClick={() => navigate("/dashboard/invoices")} className="inline-flex items-center gap-2 text-sm font-medium" style={{ color: "var(--text-muted)" }}><ArrowLeft size={17} /> Back to invoices</button>
      <div className="flex flex-wrap gap-2">
        <button disabled={active === "pdf"} onClick={download} className="inline-flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}><Download size={16} /> {active === "pdf" ? "Preparing..." : "Download PDF"}</button>
        <button disabled={active === "email"} onClick={email} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-3.5 py-2.5 text-sm font-semibold text-white"><Mail size={16} /> {active === "email" ? "Sending..." : "Email invoice"}</button>
      </div>
    </div>
    {error ? <div className="flex items-start justify-between gap-3 rounded-xl border border-rose-500/25 bg-rose-500/5 p-4 text-sm text-rose-700 dark:text-rose-200"><span className="flex gap-2"><CircleAlert size={18} />{error}</span><button onClick={() => setError("")}>×</button></div> : null}

    <section className="rounded-2xl border p-5 sm:p-7" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div><p className="text-sm font-medium text-brand-600">Invoice document</p><h2 className="mt-2 text-3xl font-semibold tracking-tight">{invoice.invoiceNumber}</h2><p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>Issued {date(invoice.invoiceDate)} · Due {date(invoice.dueDate)}</p></div>
        <div className="flex flex-wrap gap-2"><span className={`rounded-full px-3 py-1.5 text-sm font-medium ${paymentClass}`}>{paymentLabel}</span><span className="rounded-full bg-slate-500/10 px-3 py-1.5 text-sm font-medium capitalize" style={{ color: "var(--text-muted)" }}>{invoice.status}</span></div>
      </div>
    </section>

    <div className={`grid gap-6 ${isRealEstateSelfHosted ? "" : "xl:grid-cols-[minmax(0,1fr)_330px]"}`}>
      <main className="space-y-6">
        <section className="rounded-2xl border p-5 sm:p-7" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
          <div className="grid gap-8 sm:grid-cols-2"><Party title="From" party={business} /><Party title="Bill to" party={customer} link={customer._id ? () => navigate("/dashboard/customers") : null} /></div>
          <div className="mt-8 overflow-x-auto rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
            <table className="min-w-[760px] w-full text-left text-sm">
              <thead className="bg-slate-500/[.05] text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}><tr><th className="p-3.5">Item</th><th className="p-3.5 text-right">Quantity</th><th className="p-3.5 text-right">Rate</th><th className="p-3.5 text-right">Discount</th><th className="p-3.5 text-right">Tax/GST</th><th className="p-3.5 text-right">Amount</th></tr></thead>
              <tbody>{invoice.lineItems?.map((item, index) => <tr key={`${item.productId}-${index}`} className="border-t" style={{ borderColor: "var(--panel-border)" }}><td className="p-3.5 font-medium">{item.productName}<p className="mt-1 text-xs font-normal" style={{ color: "var(--text-muted)" }}>{invoice.gstSnapshot?.lines?.[index]?.hsnSac ? `HSN/SAC ${invoice.gstSnapshot.lines[index].hsnSac}` : ""}</p></td><td className="p-3.5 text-right">{item.quantity}</td><td className="p-3.5 text-right">{money(item.rate)}</td><td className="p-3.5 text-right">{money(item.discount)}</td><td className="p-3.5 text-right">{item.taxRate ? `${item.taxRate}% · ${money(item.tax)}` : "—"}</td><td className="p-3.5 text-right font-semibold">{money(item.itemTotal)}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="ml-auto mt-5 max-w-sm space-y-3 text-sm"><AmountRow label="Subtotal" value={money(invoice.subtotal)} /><AmountRow label="Discount" value={`− ${money(invoice.totalDiscount)}`} /><AmountRow label="Tax/GST" value={money(invoice.totalTax)} />{Number(invoice.shippingCharges) ? <AmountRow label="Shipping" value={money(invoice.shippingCharges)} /> : null}{Number(invoice.roundOff) ? <AmountRow label="Round-off" value={money(invoice.roundOff)} /> : null}<div className="flex justify-between border-t pt-3 text-base font-semibold" style={{ borderColor: "var(--panel-border)" }}><span>Grand total</span><span>{money(invoice.grandTotal)}</span></div></div>
        </section>
        {(!isRealEstateSelfHosted || hasNotesOrTerms) ? <section className="rounded-2xl border p-5 sm:p-6" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><h3 className="text-lg font-semibold">Notes & terms</h3><div className="mt-4 grid gap-5 md:grid-cols-2"><div><p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Notes</p><p className="mt-2 text-sm">{invoice.notes || "No notes provided."}</p></div><div><p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Terms & conditions</p><p className="mt-2 text-sm">{invoice.termsAndConditions || "No terms provided."}</p></div></div></section> : null}
        {!isRealEstateSelfHosted ? <section className="rounded-2xl border p-5 sm:p-6" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><h3 className="text-lg font-semibold">Activity</h3><div className="mt-4"><Timeline invoice={invoice} /></div></section> : null}
      </main>
      <aside className={isRealEstateSelfHosted ? "columns-1 md:columns-2 xl:columns-3 [column-gap:1.5rem]" : "space-y-6"}>
        {invoice.gstSnapshot ? <div className={isRealEstateSelfHosted ? "mb-6 break-inside-avoid" : ""}><GstEInvoicePanel invoice={invoice} eInvoice={eInvoice || invoice.eInvoice} result={eInvoiceResult} active={active} onCheck={checkReadiness} onPrepare={preparePayload} showEInvoiceActions={!isRealEstateSelfHosted} /></div> : null}
        {!isRealEstateSelfHosted ? <CommunicationPanel deliveries={deliveries} reminders={reminders} templates={templates} form={communicationForm} setForm={setCommunicationForm} providerStatus={providerStatus} active={active} onSend={sendViaChannel} onSchedule={scheduleReminder} /> : null}
        <div className={isRealEstateSelfHosted ? "mb-6 break-inside-avoid" : ""}><PaymentSummary invoice={invoice} paymentLabel={paymentLabel} paymentClass={paymentClass} canRecord={canManagePayments && invoice.status !== "cancelled" && Number(invoice.balanceDue || 0) > 0} onRecord={openPayment} customerAdvances={customerAdvances} onApplyAdvance={() => setShowAdvanceModal(true)} /></div>
        {(!isRealEstateSelfHosted || allocations.length) ? <div className={isRealEstateSelfHosted ? "mb-6 break-inside-avoid" : ""}><PaymentAllocations invoice={invoice} rows={allocations} canReverse={canManagePayments} reversing={reversing} onReverse={reversePayment} onReceipt={downloadReceipt} /></div> : null}
        <div className={isRealEstateSelfHosted ? "mb-6 break-inside-avoid" : ""}><section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><h3 className="text-lg font-semibold">Document details</h3><dl className="mt-4 space-y-3 text-sm"><AmountRow label="Created" value={timestamp(invoice.createdAt)} /><AmountRow label="Last updated" value={timestamp(invoice.updatedAt)} /></dl></section></div>
        {invoice.status !== "cancelled" ? (
  <div className={isRealEstateSelfHosted ? "mb-6 break-inside-avoid" : ""}>
    <section className="rounded-2xl border border-rose-500/30 p-5">
      <h3 className="text-lg font-semibold text-rose-600">Invoice actions</h3>
      <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
        Cancellation is consequential and reverses the invoice stock and accounting impact.
      </p>
      <button onClick={() => setShowCancel(true)} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-rose-500/40 px-4 py-2.5 text-sm font-medium text-rose-600">
        <Trash2 size={16} /> Cancel invoice
      </button>
    </section>
  </div>
) : (
  <div className={isRealEstateSelfHosted ? "mb-6 break-inside-avoid" : ""}>
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 p-5">
      <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">Cancelled Invoice</h3>
      {invoice.reissuedInvoiceNumber ? (
        <p className="mt-2 text-sm text-emerald-600 font-semibold">
          Replaced by reissued invoice: <strong>{invoice.reissuedInvoiceNumber}</strong>
        </p>
      ) : canManagePayments ? (
        <div className="space-y-3 mt-3">
          <p className="text-xs text-slate-500">
            This invoice is cancelled. You can reissue a replacement invoice referencing this record.
          </p>
          <button onClick={handleReissue} disabled={active === "reissue"} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50">
            <RefreshCw size={16} className={active === "reissue" ? "animate-spin" : ""} />
            {active === "reissue" ? "Reissuing..." : "Reissue Replacement Invoice"}
          </button>
        </div>
      ) : null}
    </section>
  </div>
)}
      </aside>
    </div>

    {showAdvanceModal && customerAdvances?.advances?.length > 0 && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
    <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900 space-y-4">
      <div className="flex items-center justify-between border-b pb-3 dark:border-slate-800">
        <h3 className="font-bold text-base text-slate-900 dark:text-white">Apply Customer Advance</h3>
        <button onClick={() => setShowAdvanceModal(false)} className="text-slate-400 hover:text-slate-600">
          <X size={18} />
        </button>
      </div>

      <p className="text-xs text-slate-500">
        Allocate existing unallocated payments/advances to settle invoice {invoice.invoiceNumber}.
      </p>

      {advanceError && (
        <p className="rounded-xl bg-rose-500/10 p-3 text-xs text-rose-600 font-medium">{advanceError}</p>
      )}

      <form onSubmit={handleApplyAdvance} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
            Select Advance Payment
          </label>
          <select
            value={selectedAdvancePaymentId}
            onChange={(e) => {
              setSelectedAdvancePaymentId(e.target.value);
              const found = customerAdvances.advances.find(a => a.paymentId === e.target.value);
              if (found) {
                setAdvanceAllocationAmount(String(Math.min(found.unallocatedAmount, invoice.balanceDue)));
              }
            }}
            className="w-full rounded-xl border border-slate-200 p-2.5 text-xs dark:border-slate-800 dark:bg-slate-800"
          >
            {customerAdvances.advances.map(a => (
              <option key={a.paymentId} value={a.paymentId}>
                {date(a.paymentDate)} · {a.paymentMethod} · Avail: {money(a.unallocatedAmount)} (Ref: {a.referenceNumber || "—"})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
            Amount to Allocate (₹)
          </label>
          <input
            type="number"
            min="0.01"
            max={invoice.balanceDue}
            step="0.01"
            required
            value={advanceAllocationAmount}
            onChange={(e) => setAdvanceAllocationAmount(e.target.value)}
            className="w-full rounded-xl border border-slate-200 p-2.5 text-xs dark:border-slate-800 dark:bg-slate-800"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => setShowAdvanceModal(false)}
            className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={active === "advance"}
            className="rounded-xl bg-emerald-600 px-5 py-2 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {active === "advance" ? "Applying..." : "Confirm Allocation"}
          </button>
        </div>
      </form>
    </div>
  </div>
)}

      {showCancel ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"><div className="w-full max-w-md rounded-2xl border p-6 shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><CircleAlert className="text-rose-600" /><h3 className="mt-4 text-lg font-semibold">Cancel this invoice?</h3><p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>Invoice <strong>{invoice.invoiceNumber}</strong> will be cancelled and its stock impact reversed. This cannot be undone.</p><div className="mt-6 flex justify-end gap-3"><button onClick={() => setShowCancel(false)} disabled={active === "cancel"} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Keep invoice</button><button onClick={cancel} disabled={active === "cancel"} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{active === "cancel" ? "Cancelling..." : "Cancel invoice"}</button></div></div></div> : null}
    {paymentOpen ? <PaymentModal invoice={invoice} form={paymentForm} setForm={setPaymentForm} error={paymentError} saving={active === "payment"} onClose={() => !active && setPaymentOpen(false)} onSubmit={recordPayment} /> : null}
  </div>;
};

const Party = ({ title, party, link }) => <div><p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{title}</p>{link ? <button onClick={link} className="mt-2 text-left text-lg font-semibold text-brand-600 hover:underline">{party.name || "Customer"}</button> : <p className="mt-2 text-lg font-semibold">{party.name || "Business"}</p>}<div className="mt-2 space-y-1 text-sm" style={{ color: "var(--text-muted)" }}>{party.email ? <p>{party.email}</p> : null}{party.phone ? <p>{party.phone}</p> : null}{party.address || party.billingAddress ? <p>{party.address || party.billingAddress}</p> : null}{party.gstNumber ? <p>GST: {party.gstNumber}</p> : null}</div></div>;
const AmountRow = ({ label, value }) => <div className="flex items-center justify-between gap-4"><span style={{ color: "var(--text-muted)" }}>{label}</span><span className="text-right font-medium">{value}</span></div>;

const PaymentSummary = ({ invoice, paymentLabel, paymentClass, canRecord, onRecord, customerAdvances, onApplyAdvance }) => <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><p className="text-sm font-medium text-brand-600">Payment</p><h3 className="mt-1 text-lg font-semibold">Payment summary</h3><div className="mt-5 space-y-3"><AmountRow label="Invoice total" value={money(invoice.grandTotal)} /><AmountRow label="Amount received" value={money(invoice.amountPaid)} /><AmountRow label="Balance due" value={money(invoice.balanceDue)} /><AmountRow label="Status" value={<span className={`rounded-full px-2.5 py-1 text-xs font-medium ${paymentClass}`}>{paymentLabel}</span>} /></div>{canRecord && customerAdvances?.totalUnallocatedAmount > 0 ? <div className="mt-4 rounded-xl border border-emerald-300 bg-emerald-50/80 p-3 text-xs dark:border-emerald-800/60 dark:bg-emerald-950/40"><div className="flex items-center justify-between font-semibold text-emerald-900 dark:text-emerald-200"><span>Unallocated Advance:</span><span className="text-sm font-bold text-emerald-700 dark:text-emerald-300">{money(customerAdvances.totalUnallocatedAmount)}</span></div><button type="button" onClick={onApplyAdvance} className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 font-bold text-white hover:bg-emerald-700 shadow-sm"><CheckCircle2 size={14} /> Apply Customer Advance</button></div> : null}{canRecord ? <button type="button" onClick={onRecord} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white"><ReceiptIndianRupee size={16} /> Pay remaining {money(invoice.balanceDue)}</button> : null}{invoice.financialRead?.reconciliation?.status === "MISMATCH" ? <p className="mt-5 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">Payment history needs review because the allocated amount does not match the invoice balance.</p> : null}</section>;

const PaymentAllocations = ({ rows, canReverse, reversing, onReverse, onReceipt }) => {
  return <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><h3 className="text-lg font-semibold">Payment history</h3><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Every instalment remains recorded with its date, mode and reference.</p>{rows.length ? <div className="mt-4 space-y-3">{rows.map((row) => <div key={row.allocationId || row._id} className="rounded-xl border p-3 text-sm" style={{ borderColor: "var(--panel-border)" }}><div className="flex items-start justify-between gap-3"><div><p className={`font-semibold ${row.reversal ? "line-through opacity-60" : ""}`}>{money(row.allocatedAmount)}</p><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{date(row.payment?.paymentDate || row.createdAt)} · {row.payment?.paymentMethod || "Method not captured"}</p></div><span className={`rounded-full px-2 py-1 text-xs ${row.reversal ? "bg-rose-500/10 text-rose-700" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{row.reversal ? "Reversed" : "Received"}</span></div><dl className="mt-3 grid gap-2 text-xs"><AmountRow label="Reference" value={row.payment?.referenceNumber || "—"} />{row.reversal ? <><AmountRow label="Reversed on" value={date(row.reversal.createdAt)} /><AmountRow label="Reason" value={row.reversal.reason} /></> : null}</dl><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => onReceipt(row)} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium" style={{ borderColor: "var(--panel-border)" }}><Download size={13} /> Receipt</button>{canReverse && !row.reversal ? <button type="button" disabled={reversing === row.allocationId} onClick={() => onReverse(row)} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/30 px-2.5 py-1.5 text-xs font-medium text-rose-600 disabled:opacity-50">{reversing === row.allocationId ? <LoaderCircle size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reverse</button> : null}</div></div>)}</div> : <EmptyState title="No payments recorded" description="Use Record payment to add the first receipt against this invoice." />}</section>;
};

const PaymentModal = ({ invoice, form, setForm, error, saving, onClose, onSubmit }) => <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"><form onSubmit={onSubmit} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-5 shadow-2xl sm:p-6" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">Record payment</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Add an instalment to {invoice.invoiceNumber}. Invoice total stays unchanged.</p></div><button type="button" onClick={onClose} disabled={saving} className="rounded-lg p-2 hover:bg-slate-500/10"><X size={18} /></button></div><div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-slate-500/[.06] p-3 text-sm"><div><p className="text-xs" style={{ color: "var(--text-muted)" }}>Total</p><p className="mt-1 font-semibold">{money(invoice.grandTotal)}</p></div><div><p className="text-xs" style={{ color: "var(--text-muted)" }}>Received</p><p className="mt-1 font-semibold text-emerald-600">{money(invoice.amountPaid)}</p></div><div><p className="text-xs" style={{ color: "var(--text-muted)" }}>Due</p><p className="mt-1 font-semibold text-amber-600">{money(invoice.balanceDue)}</p></div></div>{error ? <p className="mt-4 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-600">{error}</p> : null}<div className="mt-5 grid gap-4 sm:grid-cols-2"><label><span className="mb-2 flex items-center justify-between gap-2 text-sm font-medium"><span>Amount received</span><button type="button" onClick={() => setForm((value) => ({ ...value, amount: String(invoice.balanceDue) }))} className="text-xs font-semibold text-brand-600">Full balance</button></span><input type="number" min="0.01" max={invoice.balanceDue} step="0.01" required value={form.amount} onChange={(event) => setForm((value) => ({ ...value, amount: event.target.value }))} className="field" /></label><label><span className="mb-2 block text-sm font-medium">Payment date</span><input type="date" required value={form.paymentDate} onChange={(event) => setForm((value) => ({ ...value, paymentDate: event.target.value }))} className="field" /></label><label><span className="mb-2 block text-sm font-medium">Payment mode</span><select value={form.paymentMethod} onChange={(event) => setForm((value) => ({ ...value, paymentMethod: event.target.value }))} className="field"><option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option><option value="CARD">Card</option><option value="OTHER">Other</option></select></label><label><span className="mb-2 block text-sm font-medium">Reference</span><input value={form.referenceNumber} onChange={(event) => setForm((value) => ({ ...value, referenceNumber: event.target.value }))} placeholder="UTR / cheque / transaction ID" className="field" /></label><label className="sm:col-span-2"><span className="mb-2 block text-sm font-medium">Notes</span><textarea rows="3" value={form.notes} onChange={(event) => setForm((value) => ({ ...value, notes: event.target.value }))} placeholder="Optional payment note" className="field" /></label></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} disabled={saving} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Cancel</button><button disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{saving ? <LoaderCircle size={16} className="animate-spin" /> : <ReceiptIndianRupee size={16} />}{saving ? "Recording..." : "Record payment"}</button></div></form></div>;

const GstEInvoicePanel = ({ invoice, eInvoice, result, active, onCheck, onPrepare, showEInvoiceActions }) => {
  const breakup = invoice.gstBreakup || {};
  const snapshot = invoice.gstSnapshot || {};
  const firstLine = snapshot.lines?.[0] || {};
  const hsnSac = firstLine.hsnSac || Object.keys(breakup.hsnSacSummary || {})[0] || "";
  const hasSupplyStates = Boolean(snapshot.supplierStateCode && snapshot.placeOfSupplyCode);
  const statusLabel = eInvoice?.eInvoiceStatus || eInvoice?.status || (invoice.gstSnapshot ? "READY" : "NOT_REQUIRED");
  const errors = result?.readiness?.errors || [];
  return <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-brand-600">{showEInvoiceActions ? "GST & e-invoice" : "GST details"}</p><h3 className="mt-1 text-lg font-semibold">Tax snapshot</h3></div>{showEInvoiceActions ? <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusLabel === "READY" || statusLabel === "GENERATED" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : statusLabel === "FAILED" ? "bg-rose-500/10 text-rose-700 dark:text-rose-300" : "bg-slate-500/10 text-slate-600 dark:text-slate-300"}`}>{statusLabel}</span> : null}</div><div className="mt-4 space-y-2 text-sm"><AmountRow label="Taxable value" value={money(breakup.taxableValue || snapshot.taxableValue)} /><AmountRow label="CGST" value={money(breakup.cgst || snapshot.cgst)} /><AmountRow label="SGST" value={money(breakup.sgst || snapshot.sgst)} /><AmountRow label="IGST" value={money(breakup.igst || snapshot.igst)} />{hsnSac ? <AmountRow label="HSN/SAC" value={hsnSac} /> : null}<AmountRow label="GST rate" value={firstLine.rate !== undefined ? `${firstLine.rate}%` : "Mixed"} />{hasSupplyStates ? <AmountRow label="Supply" value={snapshot.supplierStateCode === snapshot.placeOfSupplyCode ? "Intra-state" : "Inter-state"} /> : null}{snapshot.placeOfSupplyCode ? <AmountRow label="Place of supply" value={snapshot.placeOfSupply || snapshot.placeOfSupplyCode} /> : null}</div>{showEInvoiceActions ? <>{eInvoice?.irn ? <div className="mt-4 rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-200"><p className="flex items-center gap-2 font-medium"><ShieldCheck size={16} /> IRN available</p><p className="mt-1 break-all">{eInvoice.irn}</p>{eInvoice.acknowledgementNumber ? <p className="mt-1">Ack: {eInvoice.acknowledgementNumber}</p> : null}</div> : <p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">Government IRP submission is not configured. BillStack can validate readiness and prepare the payload only.</p>}{errors.length ? <div className="mt-4 space-y-2">{errors.map((error) => <p key={error.code + error.message} className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-200">{error.code}: {error.message}</p>)}</div> : result?.readiness?.readiness === "READY" ? <p className="mt-4 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={15} /> Readiness validation passed.</p> : null}<div className="mt-5 grid gap-2"><button type="button" onClick={onCheck} disabled={active === "echeck"} className="inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium" style={{ borderColor: "var(--panel-border)" }}><FileCheck2 size={16} /> {active === "echeck" ? "Checking..." : "Check readiness"}</button><button type="button" onClick={onPrepare} disabled={active === "epayload"} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><QrCode size={16} /> {active === "epayload" ? "Preparing..." : "Prepare e-invoice"}</button></div></> : null}</section>;
};

const CommunicationPanel = ({ deliveries, reminders, templates, form, setForm, providerStatus, active, onSend, onSchedule }) => {
  const whatsappReady = Boolean(providerStatus?.whatsapp?.configured);
  const emailReady = providerStatus?.email?.configured !== false;
  const matchingTemplates = (templates || []).filter((template) => template.isActive !== false && template.channel === form.channel && template.category === form.category);
  const canSend = form.channel === "EMAIL" ? emailReady : form.channel === "WHATSAPP" ? whatsappReady : false;
  return <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><p className="text-sm font-medium text-brand-600">Communications</p><h3 className="mt-1 text-lg font-semibold">Send and remind</h3><p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>Choose a matching active template or use the default. WhatsApp and SMS stay disabled until their providers are configured.</p><div className="mt-4 grid gap-2"><label className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Channel<select value={form.channel} onChange={(event) => setForm((value) => ({ ...value, channel: event.target.value, templateId: "" }))} className="field mt-2"><option value="EMAIL" disabled={!emailReady}>Email{emailReady ? "" : " (not configured)"}</option><option value="WHATSAPP" disabled={!whatsappReady}>WhatsApp{whatsappReady ? "" : " (not configured)"}</option></select></label><label className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Category<select value={form.category} onChange={(event) => setForm((value) => ({ ...value, category: event.target.value, templateId: "" }))} className="field mt-2"><option value="INVOICE_CREATED">Invoice Created</option><option value="DUE_TODAY">Payment Due Today</option><option value="PAYMENT_OVERDUE">Payment Overdue</option><option value="PAYMENT_REMINDER">Payment Reminder</option></select></label><label className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Template<select value={form.templateId || ""} onChange={(event) => setForm((value) => ({ ...value, templateId: event.target.value }))} className="field mt-2"><option value="">Use default template</option>{matchingTemplates.map((template) => <option key={template._id} value={template._id}>{template.name}{template.isDefault ? " (default)" : ""}</option>)}</select></label><button onClick={onSend} disabled={active === `send-${form.channel}` || !canSend} className="inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium disabled:opacity-50" style={{ borderColor: "var(--panel-border)" }}>{form.channel === "WHATSAPP" ? <MessageCircle size={16} /> : <Mail size={16} />} {active === `send-${form.channel}` ? "Sending..." : canSend ? `Send ${templateCategoryLabel(form.category)}` : `${form.channel} not configured`}</button><button onClick={onSchedule} disabled={active === "schedule-reminder" || !emailReady} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><BellRing size={16} /> {active === "schedule-reminder" ? "Scheduling..." : "Schedule email reminder"}</button></div><div className="mt-5 space-y-3"><HistoryBlock title="Upcoming reminders" rows={reminders} empty="No reminders scheduled." mapper={(row) => `${row.channel} / ${row.status} / ${row.scheduledFor ? new Date(row.scheduledFor).toLocaleString("en-IN") : "-"}`} /><HistoryBlock title="Delivery status" rows={deliveries} empty="No message history yet." mapper={(row) => `${row.channel} / ${row.status}${row.failureReason ? ` / ${row.failureReason}` : ""}`} /></div></section>;
};

const HistoryBlock = ({ title, rows, mapper, empty }) => <div><p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{title}</p>{rows.slice(0, 3).map((row) => <p key={row._id} className="mt-2 rounded-lg bg-slate-500/10 px-3 py-2 text-xs">{mapper(row)}</p>)}{!rows.length ? <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>{empty}</p> : null}</div>;
const Timeline = ({ invoice }) => <div className="space-y-4 border-l pl-4" style={{ borderColor: "var(--panel-border)" }}><div><p className="font-medium">Invoice created</p><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{timestamp(invoice.createdAt)}</p></div>{invoice.updatedAt && invoice.updatedAt !== invoice.createdAt ? <div><p className="font-medium">Invoice last updated</p><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{timestamp(invoice.updatedAt)}</p></div> : null}{invoice.status === "cancelled" ? <div><p className="font-medium">Invoice cancelled</p><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>The current API does not provide a separate cancellation timestamp.</p></div> : null}</div>;

export default InvoiceDetailPage;
