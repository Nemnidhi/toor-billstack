import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { CheckCircle2, CircleAlert, Download, FilePlus2, Loader2, Mail, MoreHorizontal, Pencil, Plus, Printer, Search, Send, Trash2, X } from "lucide-react";
import { allocatePaymentRequest, cancelInvoiceRequest, createCustomerRequest, createInvoiceRequest, createPaymentRequest, getInvoiceRequest, createProductRequest, dashboardSummaryRequest, downloadInvoicePdfRequest, emailInvoiceRequest, listCustomersRequest, listInvoicesRequest, listProductsRequest, sendInvoiceCommunicationRequest, updateInvoiceRequest } from "../../auth/api";
import { uiStore } from "../../../store/uiStore";
import { authStore } from "../../../store/authStore";
import { useCreateAction } from "../../workspace/useCreateAction";
import { isRealEstateSelfHostedWorkspace } from "../../workspace/workspaceVisibility";
import { recordInvoicePayment } from "../invoicePaymentWorkflow";
import { listInvoiceAllocationsRequest } from "../../auth/api";
import gstStates from "../../../../../shared/indian-gst-states.json";
import { previewInvoiceTaxRequest } from "../../auth/api";
import { gstStates as customerGstStates, stateCodeFromGstin, updateCustomerGstFields, validateOptionalGstin } from "../gstIdentity";

import { isInvoicePreviewReady } from "../invoicePreview";
import { handoffRate, hasInvoiceRate } from "../invoiceHandoff";

const today = () => new Date().toISOString().slice(0, 10);
const makeLine = () => ({ productId: "", productName: "", quantity: 1, rate: "", taxRate: 0, hsnSac: "", gstClassification: "TAXABLE", discountType: "percent", discountValue: 0, saveForFuture: false });
const makeForm = () => ({ customerId: "", crmSourceRef: null, invoiceDate: today(), dueDate: today(), shippingCharges: 0, roundOff: 0, notes: "", termsAndConditions: "", paymentMode: "unpaid", upfrontPaymentAmount: "", upfrontPaymentMethod: "BANK_TRANSFER", upfrontPaymentReference: "", lineItems: [makeLine()] });
const makeCustomerForm = () => ({ name: "", phone: "", email: "", gstNumber: "", stateCode: "" });
const makePaymentForm = () => ({ amount: "", paymentMethod: "BANK_TRANSFER", paymentDate: today(), referenceNumber: "", notes: "", idempotencyKey: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}` });
const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const dateKey = (value) => (value ? new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) : "");
const isOverdue = (dueDate) => dateKey(new Date()) > dateKey(dueDate);
const statusInfo = (invoice) => {
  if (invoice.status === "cancelled") return ["Cancelled", "bg-slate-500/10 text-slate-600 dark:text-slate-300"];
  if (invoice.paymentStatus === "paid") return ["Paid", "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"];
  if (invoice.paymentStatus === "partial") return ["Partially paid", "bg-amber-500/10 text-amber-700 dark:text-amber-300"];
  if (invoice.balanceDue > 0 && isOverdue(invoice.dueDate)) return ["Overdue", "bg-rose-500/10 text-rose-700 dark:text-rose-300"];
  return ["Pending", "bg-brand-500/10 text-brand-700 dark:text-brand-200"];
};
const eInvoiceInfo = (invoice) => {
  const value = invoice.eInvoice?.status || (invoice.gstSnapshot ? "READY" : "NOT_REQUIRED");
  if (value === "GENERATED") return ["Generated", "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"];
  if (value === "READY") return ["Ready", "bg-blue-500/10 text-blue-700 dark:text-blue-300"];
  if (value === "FAILED") return ["Needs review", "bg-rose-500/10 text-rose-700 dark:text-rose-300"];
  return ["Not required", "bg-slate-500/10 text-slate-600 dark:text-slate-300"];
};

const InvoicesPage = () => {
  const location = useLocation();
  const { business } = authStore();
  const showEInvoiceStatus = !isRealEstateSelfHostedWorkspace(null, business);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [filters, setFilters] = useState({ page: 1, limit: 10, search: "", paymentStatus: "", status: "", sortBy: "invoiceDate", sortOrder: "desc" });
  const [result, setResult] = useState({ items: [], pagination: { page: 1, totalPages: 1, total: 0 } });
  const [summary, setSummary] = useState(null);
  const [form, setForm] = useState(makeForm);
  const [editingId, setEditingId] = useState("");
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [active, setActive] = useState({ id: "", type: "" });
  const [showEditor, setShowEditor] = useState(false);
  const [openMenu, setOpenMenu] = useState("");
  const [menuPosition, setMenuPosition] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [customerForm, setCustomerForm] = useState(makeCustomerForm);
  const [customerSaving, setCustomerSaving] = useState(false);
  const [customerError, setCustomerError] = useState("");
  const [postIssue, setPostIssue] = useState(null);
  const [crmHandoff, setCrmHandoff] = useState(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentForm, setPaymentForm] = useState(makePaymentForm);
  const [paymentTarget, setPaymentTarget] = useState(null);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const pendingIssue = useRef(null);
  const issuePaymentDetails = useRef(null);
  const issuePaymentKey = useRef(makePaymentForm().idempotencyKey);
  const saveLock = useRef(false);
  const recordedPayments = useRef(new Map());

  useCreateAction({
    ready: !isLoading, moduleKey: "invoices", focusSelector: '#invoice-editor select[name="customerId"]',
    onCreate: () => {
      const handoffCustomerId = sessionStorage.getItem("billstack-invoice-handoff-customer") || "";
      sessionStorage.removeItem("billstack-invoice-handoff-customer");

      let billingCtx = null;
      try {
        const rawCtx = sessionStorage.getItem("billstack-invoice-billing-context");
        if (rawCtx) billingCtx = JSON.parse(rawCtx);
      } catch (_e) {}
      sessionStorage.removeItem("billstack-invoice-billing-context");

      let existingInv = null;
      try {
        const rawExisting = sessionStorage.getItem("billstack-invoice-existing-invoice");
        if (rawExisting) existingInv = JSON.parse(rawExisting);
      } catch (_e) {}
      sessionStorage.removeItem("billstack-invoice-existing-invoice");

      pendingIssue.current = null;
      issuePaymentKey.current = makePaymentForm().idempotencyKey;
      setEditingId("");

      const initialForm = makeForm();
      setCrmHandoff(billingCtx ? { items: billingCtx.prefill?.lineItems?.length || 0, reference: billingCtx.prefill?.reference || "", notes: billingCtx.prefill?.notes || "" } : null);
      if (handoffCustomerId) initialForm.customerId = handoffCustomerId;

      if (billingCtx) {
        if (billingCtx.sourceRef) {
          initialForm.crmSourceRef = billingCtx.sourceRef;
        }
        if (billingCtx.prefill?.notes) {
          initialForm.notes = billingCtx.prefill.notes;
        }
        if (billingCtx.prefill?.reference) {
          initialForm.termsAndConditions = initialForm.termsAndConditions
            ? `${initialForm.termsAndConditions}\nReference: ${billingCtx.prefill.reference}`
            : `Reference: ${billingCtx.prefill.reference}`;
        }
        if (billingCtx.prefill?.lineItems?.length) {
          initialForm.lineItems = billingCtx.prefill.lineItems.map(item => ({
            productId: "",
            productName: item.productName || "",
            quantity: item.quantity || 1,
            ...handoffRate(item),
            taxRate: business?.billingEntityCode === "GOLDHAWK" ? 0 : 18,
            hsnSac: "",
            gstClassification: business?.billingEntityCode === "GOLDHAWK" ? "EXEMPT" : "TAXABLE",
            discountType: "percent",
            discountValue: 0,
            saveForFuture: false,
          }));
        }
      }

      setForm(initialForm);
      setErrors({});
      setPostIssue(null);
      if (existingInv) {
        setMessage(`Note: An invoice (${existingInv.invoiceNumber}) has already been issued for this CRM record.`);
      }
      setShowEditor(true);
      requestAnimationFrame(() => document.getElementById("invoice-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    },
  });

  useEffect(() => {
    if (!openMenu) return undefined;
    const closeOnOutside = (event) => {
      if (event.target?.closest?.("[data-invoice-menu]") || event.target?.closest?.("[data-invoice-menu-trigger]")) return;
      setOpenMenu("");
      setMenuPosition(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") {
        setOpenMenu("");
        setMenuPosition(null);
      }
    };
    window.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnOutside);
    window.addEventListener("scroll", closeOnOutside, true);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnOutside);
      window.removeEventListener("scroll", closeOnOutside, true);
    };
  }, [openMenu]);

  const selectedCustomer = customers.find((customer) => customer._id === form.customerId);
  useEffect(() => {
    if (!selectedCustomer || form.placeOfSupplyCode) return;
    setForm((current) => ({ ...current, placeOfSupplyCode: selectedCustomer.placeOfSupplyCode || selectedCustomer.stateCode || "" }));
  }, [selectedCustomer, form.placeOfSupplyCode]);
  const [gstPreview, setGstPreview] = useState(null);
  const [gstPreviewError, setGstPreviewError] = useState("");
  const [gstPreviewSkipped, setGstPreviewSkipped] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setGstPreview(null); setGstPreviewError(""); setGstPreviewSkipped(false);
    if (!showEditor || !isInvoicePreviewReady(form)) return;
    const timer = setTimeout(() => previewInvoiceTaxRequest({ ...form, lineItems: form.lineItems.map(item => ({ ...item, productId: item.productId || undefined })) }).then(data => { if (!cancelled) { setGstPreview(data?.gstSnapshot || null); setGstPreviewError(""); } }).catch(error => { if (cancelled) return; if (error.response?.status === 404) { setGstPreviewSkipped(true); return; } setGstPreviewError(error.response?.data?.message || "GST preview unavailable"); }), 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [form, showEditor]);
  const totals = useMemo(() => {
    const items = form.lineItems.map((item, index) => {
      const quantity = Number(item.quantity || 0);
      const rate = Number(item.rate || 0);
      const base = quantity * rate;
      const taxRate = business?.billingEntityCode === "GOLDHAWK" ? 0 : Number(item.taxRate || 0);
      const discountValue = Number(item.discountValue || 0);
      const discount = item.discountType === "amount" ? Math.min(base, Math.max(discountValue, 0)) : Math.min(base, (base * Math.max(discountValue, 0)) / 100);
      const taxable = Math.max(base - discount, 0);
      const tax = business?.billingEntityCode === "GOLDHAWK" ? 0 : gstPreview?.lines?.[index]?.totalTax ?? (taxable * Math.max(taxRate, 0)) / 100;
      return { ...item, quantity, rate, base, discount, taxable, tax, total: taxable + tax };
    });
    const subtotal = items.reduce((sum, item) => sum + item.base, 0);
    const discount = items.reduce((sum, item) => sum + item.discount, 0);
    const tax = items.reduce((sum, item) => sum + item.tax, 0);
    const shipping = Number(form.shippingCharges || 0);
    const roundOff = Number(form.roundOff || 0);
    const grand = subtotal - discount + tax + shipping + roundOff;
    return { items, subtotal, discount, tax, shipping, roundOff, grand, due: Math.max(grand, 0) };
  }, [form, gstPreview, business?.billingEntityCode]);

  const loadInvoices = async () => {
    setIsLoading(true);
    try { setResult(await listInvoicesRequest(filters)); } catch (error) { setMessage(error.response?.data?.message || "Unable to load invoices."); } finally { setIsLoading(false); }
  };
  const loadMasterData = async () => {
    try {
      const [customerData, productData, dashboardData] = await Promise.all([
        listCustomersRequest({ page: 1, limit: 100, sortBy: "name", sortOrder: "asc" }),
        listProductsRequest({ page: 1, limit: 100, sortBy: "name", sortOrder: "asc", status: "active" }),
        dashboardSummaryRequest(),
      ]);
      setCustomers(customerData.items || []);
      setProducts(productData.items || []);
      setSummary(dashboardData);
    } catch (error) { setMessage(error.response?.data?.message || "Some invoice data could not be loaded."); }
  };
  useEffect(() => { loadInvoices(); }, [filters.page, filters.search, filters.paymentStatus, filters.status, filters.sortBy, filters.sortOrder]);
  useEffect(() => { loadMasterData(); }, []);

  const changeFilter = (event) => setFilters((current) => ({ ...current, page: 1, [event.target.name]: event.target.value }));
  const changeForm = (event) => { setGstPreviewError(""); setMessage(""); setForm((current) => ({ ...current, [event.target.name]: event.target.value, ...(event.target.name === "customerId" ? { placeOfSupplyCode: customers.find(customer => customer._id === event.target.value)?.placeOfSupplyCode || customers.find(customer => customer._id === event.target.value)?.stateCode || "" } : {}) })); };
  const changeLine = (index, field, value) => setForm((current) => ({
    ...current,
    lineItems: current.lineItems.map((item, position) => {
      if (position !== index) return item;
      const next = { ...item, [field]: value };
      if (field === "productId") {
        const product = products.find((entry) => entry._id === value);
        if (product) {
          next.productName = product.name;
          next.rate = product.sellingPrice || 0;
          next.taxRate = business?.billingEntityCode === "GOLDHAWK" ? 0 : product.taxRate || 0;
          next.hsnSac = product.hsnSac || "";
          next.gstClassification = product.gstClassification || "TAXABLE";
          next.discountValue = product.discount || 0;
          next.discountType = "percent";
          next.saveForFuture = false;
        }
      }
      if (field === 'productName' && !item.productId) {
        const lower = String(value || '').toLowerCase();
        if (!item.hsnSac || ['997212', '997222', '997211', '998599'].includes(item.hsnSac)) {
          if (lower.includes('coworking') || lower.includes('desk') || lower.includes('cabin') || lower.includes('meeting room') || lower.includes('office rent')) {
            next.hsnSac = '997212';
          } else if (lower.includes('brokerage') || lower.includes('commission') || lower.includes('sale') || lower.includes('purchase') || lower.includes('resale')) {
            next.hsnSac = '997222';
          } else if (lower.includes('residential rent')) {
            next.hsnSac = '997211';
          } else if (lower.includes('virtual office')) {
            next.hsnSac = '998599';
          }
        }
      }
      return next;
    }),
  }));
  const resetEditor = () => { pendingIssue.current = null; issuePaymentKey.current = makePaymentForm().idempotencyKey; setEditingId(""); setForm(makeForm()); setErrors({}); setCrmHandoff(null); setShowEditor(false); };
  const edit = (invoice) => {
    setMessage("");
    setGstPreviewError("");
    setEditingId(invoice._id);
    setForm({
      customerId: invoice.customerId?._id || invoice.customerId || "",
      placeOfSupplyCode: invoice.gstSnapshot?.placeOfSupplyCode || "",
      invoiceDate: new Date(invoice.invoiceDate).toISOString().slice(0, 10),
      dueDate: new Date(invoice.dueDate).toISOString().slice(0, 10),
      shippingCharges: invoice.shippingCharges || 0,
      roundOff: invoice.roundOff || 0,
      notes: invoice.notes || "",
      termsAndConditions: invoice.termsAndConditions || "",
      lineItems: invoice.lineItems.map((item) => ({ productId: item.productId || "", productName: item.productName || "", quantity: item.quantity, rate: item.rate, taxRate: item.taxRate || 0, hsnSac: item.hsnSac || "", gstClassification: item.gstClassification || "TAXABLE", discountType: item.discountType || "percent", discountValue: item.discountValue !== undefined ? item.discountValue : item.discount || 0, saveForFuture: false })),
    });
    setShowEditor(true);
    setOpenMenu("");
    requestAnimationFrame(() => document.getElementById("invoice-editor")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const buildInvoicePayload = async () => {
    const lineItems = [];
    for (const line of form.lineItems) {
      if (line.rateRequired !== undefined && !hasInvoiceRate(line.rate)) {
        throw new Error("Enter a valid rate for each CRM invoice item; zero is allowed.");
      }
      let productId = line.productId || "";
      let productName = line.productName?.trim() || "";
      if (!productId && line.saveForFuture) {
        const created = await createProductRequest({ name: productName, sellingPrice: Number(line.rate || 0), taxRate: business?.billingEntityCode === "GOLDHAWK" ? 0 : Number(line.taxRate || 0), hsnSac: line.hsnSac || "", gstClassification: line.gstClassification || "TAXABLE", discount: Number(line.discountValue || 0), trackInventory: false, openingStock: 0, currentStock: 0, status: "active" });
        productId = created._id;
        productName = created.name;
      }
      lineItems.push({ productId: productId || undefined, productName, quantity: Number(line.quantity || 0), rate: Number(line.rate || 0), taxRate: business?.billingEntityCode === "GOLDHAWK" ? 0 : Number(line.taxRate || 0), hsnSac: line.hsnSac || "", gstClassification: line.gstClassification || "TAXABLE", discountType: line.discountType, discountValue: Number(line.discountValue || 0) });
    }
    return { placeOfSupplyCode: form.placeOfSupplyCode || undefined, customerId: form.customerId, crmSourceRef: form.crmSourceRef || undefined, invoiceDate: form.invoiceDate, dueDate: form.dueDate, shippingCharges: Number(form.shippingCharges || 0), roundOff: Number(form.roundOff || 0), notes: form.notes, termsAndConditions: form.termsAndConditions, lineItems };
  };

  const save = async (event, { send = false, recordPaymentAfterIssue = false } = {}) => {
    event.preventDefault();
    if (saveLock.current) return;
    saveLock.current = true;
    setIsSaving(true); setErrors({}); setMessage("");
    try {
      if (!pendingIssue.current && !editingId && form.paymentMode === "partial" && (!Number.isFinite(Number(form.upfrontPaymentAmount)) || Number(form.upfrontPaymentAmount) <= 0 || Number(form.upfrontPaymentAmount) >= totals.grand)) {
        throw new Error("Enter a partial payment greater than zero and less than the invoice total.");
      }
      const payload = pendingIssue.current ? null : await buildInvoicePayload();
      const invoice = pendingIssue.current || (editingId ? await updateInvoiceRequest(editingId, payload) : await createInvoiceRequest(payload));
      if (!editingId && !pendingIssue.current) {
        pendingIssue.current = invoice;
        issuePaymentDetails.current = { amount: form.paymentMode === "unpaid" ? 0 : form.paymentMode === "full" ? Number(invoice.grandTotal ?? totals.grand) : Number(form.upfrontPaymentAmount || 0), fields: {
          paymentMethod: form.upfrontPaymentMethod,
          paymentDate: form.invoiceDate,
          referenceNumber: form.upfrontPaymentReference,
          notes: `Payment recorded while issuing invoice ${invoice.invoiceNumber}`,
          idempotencyKey: issuePaymentKey.current,
        } };
      }
      if (!editingId && issuePaymentDetails.current?.amount > 0) {
        await createAndAllocatePayment(invoice, issuePaymentDetails.current.amount, issuePaymentDetails.current.fields);
      }
      let sendError = "";
      if (send) {
        const recipient = invoice.customerId?.email || invoice.customerDetails?.email || selectedCustomer?.email || "";
        if (!recipient) sendError = "Invoice was issued, but the selected customer has no email address for sending.";
        else {
          try { await sendInvoiceCommunicationRequest(invoice._id, { channel: "EMAIL", category: "INVOICE_CREATED" }); } catch (error) { sendError = error.response?.data?.message || "Invoice was issued, but email sending failed."; }
        }
      }
      uiStore.getState().pushToast({ tone: sendError ? "warning" : "success", message: editingId ? "Invoice updated successfully." : form.paymentMode !== "unpaid" ? "Invoice issued and payment recorded." : send ? "Invoice issued. Send status checked." : "Invoice issued successfully." });
      setPostIssue({ invoice, sendError });
      resetEditor();
      if (recordPaymentAfterIssue && !editingId) openPaymentModal(invoice);
      await Promise.all([loadInvoices(), loadMasterData()]);
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setMessage(pendingIssue.current ? `Invoice ${pendingIssue.current.invoiceNumber} is issued. Payment could not be completed. Retry to complete payment without creating another invoice. ${error.response?.data?.message || error.message || ""}` : error.response?.data?.message || error.message || "Unable to save invoice.");
      if (pendingIssue.current) {
        setPostIssue({ invoice: pendingIssue.current, sendError: "" });
        resetEditor();
        await Promise.all([loadInvoices(), loadMasterData()]).catch(() => {});
      }
    } finally { saveLock.current = false; setIsSaving(false); }
  };

  const saveCustomer = async (event) => {
    event.preventDefault();
    if (customerSaving) return;
    if (!validateOptionalGstin(customerForm.gstNumber)) {
      setCustomerError("Enter a valid 15-character GSTIN, or leave it blank for a non-GST customer.");
      return;
    }
    setCustomerSaving(true); setCustomerError("");
    try {
      const customer = await createCustomerRequest(customerForm);
      setCustomers((current) => [customer, ...current]);
      setForm((current) => ({ ...current, customerId: customer._id, placeOfSupplyCode: customer.placeOfSupplyCode || customer.stateCode || "" }));
      setCustomerForm(makeCustomerForm());
      setCustomerOpen(false);
      uiStore.getState().pushToast({ tone: "success", message: "Customer added and selected." });
    } catch (error) { setCustomerError(error.response?.data?.message || "Unable to add customer."); } finally { setCustomerSaving(false); }
  };

  const openPaymentModal = async (invoice) => {
    setOpenMenu("");
    setMenuPosition(null);
    setMessage("");
    setGstPreviewError("");
    setPaymentError("");
    setActive({ id: invoice._id, type: "payment" });
    try {
      const freshInvoice = await getInvoiceRequest(invoice._id);
      const authoritativeInvoice = freshInvoice?.invoice || freshInvoice?.data || freshInvoice;
      const outstanding = Number(authoritativeInvoice?.balanceDue || 0);
      if (outstanding <= 0) {
        setPostIssue((current) => (current?.invoice?._id === invoice._id ? null : current));
        await Promise.all([loadInvoices(), loadMasterData()]);
        uiStore.getState().pushToast({ tone: "success", message: "This invoice is already paid." });
        return;
      }
      setPaymentTarget(authoritativeInvoice);
      setPaymentForm({ ...makePaymentForm(), amount: outstanding });
      setPaymentOpen(true);
    } catch (error) {
      setMessage(error.response?.data?.message || "Unable to refresh invoice balance.");
    } finally {
      setActive({ id: "", type: "" });
    }
  };

  const toggleActionMenu = (event, invoiceId) => {
    if (openMenu === invoiceId) {
      setOpenMenu("");
      setMenuPosition(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPosition({ top: Math.min(rect.bottom + 8, window.innerHeight - 300), right: Math.max(window.innerWidth - rect.right, 12) });
    setOpenMenu(invoiceId);
  };

  const createAndAllocatePayment = (invoice, amount, paymentFields = paymentForm) => recordInvoicePayment({
    invoice, amount, fields: paymentFields,
    recordedPaymentId: recordedPayments.current.get(paymentFields.idempotencyKey),
    onRecorded: (paymentId) => recordedPayments.current.set(paymentFields.idempotencyKey, paymentId),
    api: { getInvoice: getInvoiceRequest, createPayment: createPaymentRequest, allocatePayment: allocatePaymentRequest, listAllocations: listInvoiceAllocationsRequest },
  });

  const recordPayment = async (event) => {
    event.preventDefault();
    const invoice = paymentTarget || postIssue?.invoice;
    if (!invoice || paymentSaving) return;
    const amount = Number(paymentForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) return setPaymentError("Enter an amount greater than zero.");
    setPaymentSaving(true); setPaymentError("");
    try {
      const freshInvoice = await getInvoiceRequest(invoice._id);
      const authoritativeInvoice = freshInvoice?.invoice || freshInvoice?.data || freshInvoice;
      const outstanding = Number(authoritativeInvoice?.balanceDue || 0);
      if (outstanding <= 0) {
        setPaymentError("This invoice is already paid. Refreshing invoice list now.");
        await Promise.all([loadInvoices(), loadMasterData()]);
        return;
      }
      if (amount > outstanding) {
        setPaymentForm((current) => ({ ...current, amount: String(outstanding) }));
        setPaymentError(`Only ${money(outstanding)} is outstanding now. Amount has been updated.`);
        await loadInvoices();
        return;
      }
      await createAndAllocatePayment(authoritativeInvoice, amount, paymentForm);
      setPaymentOpen(false);
      setPaymentTarget(null);
      setPostIssue((current) => (current?.invoice?._id === (authoritativeInvoice._id || invoice._id) ? null : current));
      setPaymentForm(makePaymentForm());
      uiStore.getState().pushToast({ tone: "success", message: "Payment recorded and allocated to the invoice." });
      await Promise.all([loadInvoices(), loadMasterData()]);
    } catch (error) { setPaymentError(error.response?.data?.message || "Unable to record payment."); } finally { setPaymentSaving(false); }
  };

  const download = async (invoice) => {
    try {
      setActive({ id: invoice._id, type: "pdf" });
      const blob = await downloadInvoicePdfRequest(invoice._id, true);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${invoice.invoiceNumber}.pdf`; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      uiStore.getState().pushToast({ tone: "success", message: "Invoice PDF downloaded." });
    } catch (error) { setMessage(error.response?.data?.message || "Unable to download invoice PDF."); } finally { setActive({ id: "", type: "" }); setOpenMenu(""); }
  };
  const print = async (invoice) => {
    try {
      setActive({ id: invoice._id, type: "print" });
      const blob = await downloadInvoicePdfRequest(invoice._id, false);
      const url = URL.createObjectURL(blob);
      const popup = window.open(url, "_blank");
      if (popup) popup.onload = () => popup.print();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (error) { setMessage(error.response?.data?.message || "Unable to open print view."); } finally { setActive({ id: "", type: "" }); setOpenMenu(""); }
  };
  const email = async (invoice) => {
    const recipient = invoice.customerId?.email || invoice.customerDetails?.email || "";
    if (!recipient) { setMessage("This customer does not have an email address."); setOpenMenu(""); return; }
    try { setActive({ id: invoice._id, type: "email" }); await emailInvoiceRequest(invoice._id, recipient); uiStore.getState().pushToast({ tone: "success", message: "Invoice emailed successfully." }); } catch (error) { setMessage(error.response?.data?.message || "Unable to email invoice."); } finally { setActive({ id: "", type: "" }); setOpenMenu(""); }
  };
  const whatsapp = (invoice) => {
    const text = [`Invoice ${invoice.invoiceNumber}`, `Customer: ${invoice.customerId?.name || invoice.customerDetails?.name || ""}`, `Total: ${money(invoice.grandTotal)}`, `Due: ${formatDate(invoice.dueDate)}`, "Please contact us for the PDF copy."].join("\n");
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    setOpenMenu("");
  };
  const cancel = async () => {
    if (!cancelTarget) return;
    try { setActive({ id: cancelTarget._id, type: "cancel" }); await cancelInvoiceRequest(cancelTarget._id); uiStore.getState().pushToast({ tone: "success", message: "Invoice cancelled successfully." }); setCancelTarget(null); await loadInvoices(); } catch (error) { setMessage(error.response?.data?.message || "Unable to cancel invoice."); } finally { setActive({ id: "", type: "" }); }
  };

  const renderActionMenu = () => {
    const invoice = result.items.find((item) => item._id === openMenu);
    if (!invoice || !menuPosition) return null;
    const busy = active.id === invoice._id;
    const allocationBacked = invoice.financialRead?.source === "allocations";
    return createPortal(
      <div data-invoice-menu className="fixed z-[70] max-h-[min(320px,calc(100vh-24px))] w-52 overflow-y-auto rounded-xl border p-1 text-left shadow-2xl" style={{ top: Math.max(menuPosition.top, 12), right: menuPosition.right, borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}>
        {!allocationBacked ? <button type="button" onClick={() => edit(invoice)} disabled={busy || invoice.status === "cancelled"} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-500/10 disabled:opacity-40">{active.type === "edit" ? <Loader2 size={15} className="animate-spin" /> : <Pencil size={15} />} Edit</button> : <p className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>Amount details are locked after a payment is allocated.</p>}
        {invoice.status !== "cancelled" && Number(invoice.balanceDue || 0) > 0 ? <button type="button" onClick={() => openPaymentModal(invoice)} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-brand-600 hover:bg-brand-500/10 disabled:opacity-40">{active.type === "payment" ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} {invoice.paymentStatus === "partial" ? `Pay remaining ${money(invoice.balanceDue)}` : "Record payment"}</button> : null}
        <button type="button" onClick={() => download(invoice)} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-500/10 disabled:opacity-40">{active.type === "pdf" ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download PDF</button>
        <button type="button" onClick={() => print(invoice)} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-500/10 disabled:opacity-40">{active.type === "print" ? <Loader2 size={15} className="animate-spin" /> : <Printer size={15} />} Print</button>
        <button type="button" onClick={() => email(invoice)} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-500/10 disabled:opacity-40">{active.type === "email" ? <Loader2 size={15} className="animate-spin" /> : <Mail size={15} />} Email invoice</button>
        <button type="button" onClick={() => whatsapp(invoice)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-slate-500/10"><Send size={15} /> WhatsApp share</button>
        {invoice.status !== "cancelled" ? <button type="button" onClick={() => { setCancelTarget(invoice); setOpenMenu(""); setMenuPosition(null); }} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-500/10"><Trash2 size={15} /> Cancel invoice</button> : null}
      </div>,
      document.body
    );
  };

  const cards = summary ? [
    { label: "Total invoices", value: summary.metrics.totalInvoices, note: "Issued invoices" },
    { label: "Total sales", value: money(summary.metrics.totalSales), note: "Issued value" },
    { label: "Paid", value: money(summary.metrics.paidAmount), note: "Recorded collection" },
    { label: "Pending", value: money(summary.metrics.unpaidAmount), note: "Outstanding balance" },
    { label: "Overdue", value: summary.metrics.overdueInvoices, note: "Past due invoices" },
  ] : [];
  const upfrontPaidPreview = !editingId && form.paymentMode === "full"
    ? totals.grand
    : !editingId && form.paymentMode === "partial"
      ? Math.min(Math.max(Number(form.upfrontPaymentAmount || 0), 0), totals.grand)
      : 0;
  const balanceAfterUpfrontPayment = Math.max(totals.grand - upfrontPaidPreview, 0);

  return <div className="mx-auto max-w-[1500px] space-y-6 pb-8">
    <section className="flex flex-col gap-4 rounded-2xl border p-5 sm:p-7 lg:flex-row lg:items-end lg:justify-between" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><div><p className="text-sm font-medium text-brand-600 dark:text-brand-300">Sales workspace</p><h2 className="mt-2 text-3xl font-semibold tracking-tight">Invoices</h2><p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>Create, issue, send, and collect invoice payments without leaving this screen.</p></div><button type="button" onClick={() => { resetEditor(); setShowEditor(true); setPostIssue(null); }} className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white hover:bg-brand-700"><FilePlus2 size={17} /> Create invoice</button></section>
    {cards.length ? <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{cards.map((card) => <div key={card.label} className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><p className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{card.label}</p><p className="mt-2 text-xl font-semibold">{card.value}</p><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{card.note}</p></div>)}</section> : null}
    {message ? <div className="flex items-start gap-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-700 dark:text-rose-200"><CircleAlert size={18} className="shrink-0" /><span className="flex-1">{message}</span><button type="button" onClick={() => setMessage("")} className="shrink-0 rounded-lg p-1 hover:bg-rose-500/10" aria-label="Dismiss error"><X size={15} /></button></div> : null}

    {postIssue ? <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><p className="flex items-center gap-2 text-sm font-semibold text-emerald-600"><CheckCircle2 size={17} /> Invoice {postIssue.invoice.invoiceNumber} is issued</p>{postIssue.sendError ? <p className="mt-1 text-sm text-amber-600">{postIssue.sendError}</p> : <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{Number(postIssue.invoice.balanceDue || 0) > 0 ? "You can now record a partial or full payment for this invoice." : "Payment completed for this invoice."}</p>}</div><div className="flex flex-wrap gap-2">{postIssue.sendError ? <button type="button" onClick={async () => { try { await sendInvoiceCommunicationRequest(postIssue.invoice._id, { channel: "EMAIL", category: "INVOICE_CREATED" }); setPostIssue((current) => ({ ...current, sendError: "" })); uiStore.getState().pushToast({ tone: "success", message: "Invoice sent successfully." }); } catch (error) { setPostIssue((current) => ({ ...current, sendError: error.response?.data?.message || "Unable to send invoice." })); } }} className="rounded-xl border px-4 py-2.5 text-sm font-medium" style={{ borderColor: "var(--panel-border)" }}>Retry send</button> : null}{Number(postIssue.invoice.balanceDue || 0) > 0 ? <button type="button" onClick={() => openPaymentModal(postIssue.invoice)} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white">Record Payment</button> : null}</div></div></section> : null}

    {showEditor ? <form id="invoice-editor" onSubmit={(event) => save(event)} className="rounded-2xl border p-4 sm:p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><div className="flex flex-wrap items-start justify-between gap-4 border-b pb-5" style={{ borderColor: "var(--panel-border)" }}><div><p className="text-sm font-medium text-brand-600 dark:text-brand-300">{editingId ? "Editing invoice" : "New invoice"}</p><h3 className="mt-1 text-xl font-semibold">{editingId ? "Update invoice details" : "Create an invoice"}</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Select the customer and enter the item or service, quantity, and rate below. Review the total before issuing.</p></div><button type="button" onClick={resetEditor} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--panel-border)" }}><X size={16} /> Close</button></div>{crmHandoff ? <div className="mt-4 flex items-start gap-3 rounded-xl border border-brand-500/25 bg-brand-500/5 p-3.5 text-sm"><span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/15 text-brand-700 dark:text-brand-200"><FilePlus2 size={16} /></span><div className="min-w-0"><p className="font-semibold">Prefilled from CRM · {crmHandoff.items} item{crmHandoff.items === 1 ? "" : "s"}</p><p className="mt-0.5 break-words text-xs" style={{ color: "var(--text-muted)" }}>{crmHandoff.notes || "Review the items, rates and dates below, then issue the invoice."}</p></div></div> : null}
      {business?.billingEntityCode === "GOLDHAWK" ? (
  <div className="mt-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/50 p-3 text-xs text-slate-600 dark:text-slate-300 font-medium">
    Billing Entity: <strong>Goldhawk Infrabulls Pvt. Ltd.</strong> · Non-GST / Exempt Services
  </div>
) : (
  gstPreview && (
    <div className="mt-3 rounded-xl border p-3 text-sm">
      Tax treatment: {gstPreview.supplierStateCode === gstPreview.placeOfSupplyCode ? "Intra-state" : "Inter-state"} · CGST {money(gstPreview.cgst)} · SGST {money(gstPreview.sgst)} · IGST {money(gstPreview.igst)}
    </div>
  )
)}{gstPreviewError ? <div role="status" className="mt-2 flex items-start justify-between gap-3 text-sm text-rose-600"><span>{gstPreviewError}</span><button type="button" onClick={() => setGstPreviewError("")} className="shrink-0 rounded-lg p-1 hover:bg-rose-500/10" aria-label="Dismiss GST preview error"><X size={15} /></button></div> : null}
      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]"><div className="space-y-6"><section><div className="flex items-center justify-between gap-3"><h4 className="font-semibold">Customer</h4><button type="button" onClick={() => setCustomerOpen(true)} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium" style={{ borderColor: "var(--panel-border)" }}><Plus size={16} /> Add new customer</button></div><label className="mt-4 block"><span className="mb-2 block text-sm font-medium">Search/select customer</span><div className="relative"><Search size={16} className="pointer-events-none absolute left-3 top-3.5" style={{ color: "var(--text-muted)" }} /><select name="customerId" value={form.customerId} onChange={changeForm} className="field pl-9"><option value="">Select customer</option>{customers.map((customer) => <option key={customer._id} value={customer._id}>{customer.name}{customer.phone ? ` · ${customer.phone}` : ""}</option>)}</select></div>{errors.customerId ? <span className="mt-1 block text-xs text-rose-500">{errors.customerId}</span> : null}</label></section>
        <section className="border-t pt-6" style={{ borderColor: "var(--panel-border)" }}><h4 className="font-semibold">Invoice details</h4><label className="mt-3 block"><span className="mb-1 block text-sm font-medium">Place of Supply</span><select name="placeOfSupplyCode" value={form.placeOfSupplyCode || ""} onChange={changeForm} className="field"><option value="">Customer billing state / select state</option>{Object.entries(gstStates).map(([code,state]) => <option key={code} value={code}>{state} ({code})</option>)}</select></label><div className="mt-4 grid gap-4 sm:grid-cols-3"><div><span className="mb-2 block text-sm font-medium">Invoice number</span><div className="rounded-xl border bg-slate-500/5 px-3 py-3 text-sm" style={{ borderColor: "var(--panel-border)", color: "var(--text-muted)" }}>Generated when issued</div></div><label><span className="mb-2 block text-sm font-medium">Issue date</span><input type="date" name="invoiceDate" value={form.invoiceDate} onChange={changeForm} className="field" /></label><label><span className="mb-2 block text-sm font-medium">Due date</span><input type="date" name="dueDate" value={form.dueDate} onChange={changeForm} className="field" /></label></div></section>
        <section className="border-t pt-5" style={{ borderColor: "var(--panel-border)" }}><div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="font-semibold">Items</h4><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Select a service or type a manual item.</p></div><button type="button" onClick={() => setForm((current) => ({ ...current, lineItems: [...current.lineItems, makeLine()] }))} className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium" style={{ borderColor: "var(--panel-border)" }}><Plus size={16} /> Add item</button></div><div className="mt-4 space-y-3">{form.lineItems.map((item, index) => <div key={index} className="rounded-xl border bg-slate-500/[.03] p-4 transition-colors hover:bg-slate-500/[.05]" style={{ borderColor: "var(--panel-border)" }}><p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}><span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-500/15 text-[11px] text-brand-700 dark:text-brand-200">{index + 1}</span>Line item</p><div className="grid gap-3 md:grid-cols-[minmax(150px,1fr)_minmax(180px,1.2fr)_80px_110px] xl:grid-cols-4"><label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Item</span><select value={item.productId} onChange={(event) => changeLine(index, "productId", event.target.value)} className="field py-2"><option value="">Manual / one-off</option>{products.map((product) => <option key={product._id} value={product._id}>{product.name}{product.trackInventory ? ` · stock ${product.currentStock}` : " · service"}</option>)}</select></label><label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Description</span><input value={item.productName} disabled={Boolean(item.productId)} onChange={(event) => changeLine(index, "productName", event.target.value)} placeholder="Type item or service" className="field py-2 disabled:opacity-70" /></label><label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Qty</span><input value={item.quantity} onChange={(event) => changeLine(index, "quantity", event.target.value)} className="field py-2" /></label><label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Rate</span><input value={item.rate} placeholder="0.00" onChange={(event) => changeLine(index, "rate", event.target.value)} className={"field py-2 " + (item.rateRequired && !hasInvoiceRate(item.rate) ? "border-amber-400 dark:border-amber-500" : "")} />{item.rateRequired && !hasInvoiceRate(item.rate) ? <span className="text-[10px] text-amber-600 dark:text-amber-400 font-semibold block mt-0.5">Confirmation required</span> : null}</label><label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Discount</span><div className="flex"><input value={item.discountValue} onChange={(event) => changeLine(index, "discountValue", event.target.value)} className="field rounded-r-none py-2" /><select value={item.discountType} onChange={(event) => changeLine(index, "discountType", event.target.value)} className="field w-16 rounded-l-none border-l-0 py-2 text-xs"><option value="percent">%</option><option value="amount">₹</option></select></div></label>{business?.billingEntityCode === "GOLDHAWK" ? (
  <div>
    <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>GST</span>
    <div className="flex h-10 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/60 px-3 text-xs font-semibold text-slate-500">
      Non-GST (0%)
    </div>
  </div>
) : (
  <label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>GST %</span><input value={item.taxRate} onChange={(event) => changeLine(index, "taxRate", event.target.value)} className="field py-2" /></label>
)}<label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>HSN/SAC</span><input value={item.hsnSac} disabled={Boolean(item.productId)} onChange={(event) => changeLine(index, "hsnSac", event.target.value)} className="field py-2 disabled:opacity-70" /></label><div className="flex items-end justify-between gap-3 md:col-span-4 xl:col-span-1"><label className="flex items-center gap-2 pb-2 text-xs" style={{ color: "var(--text-muted)" }}><input type="checkbox" checked={!item.productId && item.saveForFuture} disabled={Boolean(item.productId)} onChange={(event) => changeLine(index, "saveForFuture", event.target.checked)} /> Save</label><div className="pb-2 text-right"><p className="text-xs" style={{ color: "var(--text-muted)" }}>Amount</p><p className="font-semibold">{money(totals.items[index]?.total)}</p></div><button type="button" disabled={form.lineItems.length === 1} onClick={() => setForm((current) => ({ ...current, lineItems: current.lineItems.filter((_, position) => position !== index) }))} className="rounded-lg p-2 pb-2 text-rose-500 disabled:opacity-30"><Trash2 size={16} /></button></div></div></div>)}</div>{errors.lineItems ? <p className="mt-2 text-xs text-rose-500">{errors.lineItems}</p> : null}</section>
        <section className="border-t pt-6" style={{ borderColor: "var(--panel-border)" }}><h4 className="font-semibold">Notes and terms</h4><div className="mt-4 grid gap-4 md:grid-cols-2"><label><span className="mb-2 block text-sm font-medium">Notes</span><textarea name="notes" value={form.notes} onChange={changeForm} rows="3" className="field" /></label><label><span className="mb-2 block text-sm font-medium">Terms and conditions</span><textarea name="termsAndConditions" value={form.termsAndConditions} onChange={changeForm} rows="3" className="field" /></label></div></section></div>
        <aside className="h-fit rounded-2xl border p-5 xl:sticky xl:top-24" style={{ borderColor: "var(--panel-border)", background: "color-mix(in srgb, var(--panel-bg) 80%, var(--accent) 2%)" }}><p className="text-sm font-medium text-brand-600 dark:text-brand-300">Invoice summary</p><h4 className="mt-1 text-lg font-semibold">Amount due</h4><div className="mt-5 space-y-3 text-sm"><div className="flex justify-between"><span style={{ color: "var(--text-muted)" }}>Subtotal</span><span>{money(totals.subtotal)}</span></div><div className="flex justify-between"><span style={{ color: "var(--text-muted)" }}>Discount</span><span>- {money(totals.discount)}</span></div><div className="flex justify-between"><span style={{ color: "var(--text-muted)" }}>Tax</span><span>{money(totals.tax)}</span></div><label className="flex items-center justify-between gap-3"><span style={{ color: "var(--text-muted)" }}>Shipping</span><input name="shippingCharges" value={form.shippingCharges} onChange={changeForm} className="field !w-24 !px-2 !py-1.5 text-right" /></label><label className="flex items-center justify-between gap-3"><span style={{ color: "var(--text-muted)" }}>Round-off</span><input name="roundOff" value={form.roundOff} onChange={changeForm} className="field !w-24 !px-2 !py-1.5 text-right" /></label></div><div className="mt-5 rounded-xl border p-3 text-xs" style={{ borderColor: "var(--panel-border)" }}><div className="mb-2 flex items-center justify-between"><span className="font-semibold">GST preview</span><span className="rounded-full bg-brand-500/10 px-2 py-1 text-brand-700 dark:text-brand-200">{gstPreview ? "Calculated" : gstPreviewError ? "Unavailable" : gstPreviewSkipped ? "Estimated" : isInvoicePreviewReady(form) ? "Calculating…" : "Add item details"}</span></div><div className="space-y-1" style={{ color: "var(--text-muted)" }}><p>Taxable: {money(totals.subtotal - totals.discount)}</p><p>Tax: {money(totals.tax)}</p><p>HSN/SAC values are snapshotted when the invoice is issued.</p></div></div><div className="mt-5 border-t pt-4" style={{ borderColor: "var(--panel-border)" }}><div className="flex items-end justify-between"><span className="font-medium">Grand total</span><strong className="text-2xl">{money(totals.grand)}</strong></div>{!editingId ? <div className="mt-4 rounded-xl border p-3" style={{ borderColor: "var(--panel-border)" }}><label><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Payment at issue</span><select value={form.paymentMode || "unpaid"} onChange={(event) => setForm((current) => ({ ...current, paymentMode: event.target.value, upfrontPaymentAmount: event.target.value === "full" ? "" : current.upfrontPaymentAmount }))} className="field"><option value="unpaid">Unpaid / collect later</option><option value="partial">Partial received</option><option value="full">Full paid</option></select></label>{form.paymentMode === "partial" ? <label className="mt-3 block"><span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Received amount</span><input type="number" min="0" max={totals.grand} value={form.upfrontPaymentAmount || ""} onChange={(event) => setForm((current) => ({ ...current, upfrontPaymentAmount: event.target.value }))} className="field" /></label> : null}{form.paymentMode !== "unpaid" ? <div className="mt-3 grid gap-3"><select value={form.upfrontPaymentMethod || "BANK_TRANSFER"} onChange={(event) => setForm((current) => ({ ...current, upfrontPaymentMethod: event.target.value }))} className="field"><option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option><option value="CARD">Card</option><option value="OTHER">Other</option></select><input value={form.upfrontPaymentReference || ""} onChange={(event) => setForm((current) => ({ ...current, upfrontPaymentReference: event.target.value }))} placeholder="Reference optional" className="field" /></div> : null}</div> : null}<div className="mt-3 flex justify-between text-sm"><span style={{ color: "var(--text-muted)" }}>Paid now</span><span className="font-semibold text-emerald-600 dark:text-emerald-300">{money(upfrontPaidPreview)}</span></div><div className="mt-2 flex justify-between text-sm"><span style={{ color: "var(--text-muted)" }}>Balance due</span><span className="font-semibold text-amber-600 dark:text-amber-300">{money(balanceAfterUpfrontPayment)}</span></div></div><button type="submit" disabled={isSaving} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"><Send size={16} /> {isSaving ? "Issuing..." : editingId ? "Update invoice" : "Issue Invoice"}</button>{!editingId ? <button type="button" disabled={isSaving} onClick={(event) => save(event, { send: true })} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold disabled:opacity-60" style={{ borderColor: "var(--panel-border)" }}><Mail size={16} /> Issue & Send</button> : null}<button type="button" onClick={resetEditor} className="mt-2 w-full rounded-xl px-4 py-2.5 text-sm" style={{ color: "var(--text-muted)" }}>Cancel</button></aside></div>
    </form> : null}

    <section className="rounded-2xl border p-5 sm:p-6" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}><div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div><h3 className="text-xl font-semibold">All invoices</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{result.pagination.total} invoice{result.pagination.total === 1 ? "" : "s"} in your workspace</p></div><div className="grid gap-3 sm:grid-cols-2 xl:flex"><label className="relative"><Search size={16} className="absolute left-3 top-3.5" style={{ color: "var(--text-muted)" }} /><input name="search" value={filters.search} onChange={changeFilter} placeholder="Search invoice or customer" className="w-full rounded-xl border bg-transparent py-3 pl-9 pr-3 text-sm sm:w-64" style={{ borderColor: "var(--panel-border)" }} /></label><select name="paymentStatus" value={filters.paymentStatus} onChange={changeFilter} className="rounded-xl border bg-transparent px-3 py-3 text-sm" style={{ borderColor: "var(--panel-border)" }}><option value="">All payments</option><option value="paid">Paid</option><option value="partial">Partially paid</option><option value="unpaid">Pending</option><option value="cancelled">Cancelled</option></select><select name="status" value={filters.status} onChange={changeFilter} className="rounded-xl border bg-transparent px-3 py-3 text-sm" style={{ borderColor: "var(--panel-border)" }}><option value="">All invoice status</option><option value="issued">Issued</option><option value="cancelled">Cancelled</option></select>{(filters.search || filters.paymentStatus || filters.status) ? <button type="button" onClick={() => setFilters((current) => ({ ...current, page: 1, search: "", paymentStatus: "", status: "" }))} className="rounded-xl px-3 py-3 text-sm font-medium text-brand-600">Clear filters</button> : null}</div></div><div className="relative mt-5 overflow-x-auto rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>{isLoading ? <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 backdrop-blur-sm"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading invoices...</div> : null}<table className="min-w-[760px] w-full text-left text-sm"><thead className="bg-slate-500/5 text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)" }}><tr><th className="p-3.5">Invoice #</th><th className="p-3.5">Customer</th><th className="p-3.5">Issue date</th><th className="p-3.5">Due date</th><th className="p-3.5 text-right">Amount</th><th className="p-3.5">Payment status</th>{showEInvoiceStatus ? <th className="p-3.5">GST / E-invoice</th> : null}<th className="p-3.5">Invoice status</th><th className="p-3.5" /></tr></thead><tbody>{isLoading ? <tr><td colSpan={showEInvoiceStatus ? 9 : 8} className="py-14 text-center" style={{ color: "var(--text-muted)" }}>Loading invoices...</td></tr> : result.items.map((invoice) => { const info = statusInfo(invoice); const einfo = eInvoiceInfo(invoice); const busy = active.id === invoice._id; return <tr key={invoice._id} className="border-t hover:bg-slate-500/[.035]" style={{ borderColor: "var(--panel-border)" }}><td className="p-3.5 font-semibold">{invoice.invoiceNumber}</td><td className="p-3.5"><p className="font-medium">{invoice.customerId?.name || invoice.customerDetails?.name || "Customer"}</p><p className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>{invoice.customerId?.email || invoice.customerDetails?.email || "—"}</p></td><td className="p-3.5" style={{ color: "var(--text-muted)" }}>{formatDate(invoice.invoiceDate)}</td><td className="p-3.5" style={{ color: "var(--text-muted)" }}>{formatDate(invoice.dueDate)}</td><td className="p-3.5 text-right font-semibold">{money(invoice.grandTotal)}<p className="mt-0.5 text-xs font-normal" style={{ color: "var(--text-muted)" }}>Due {money(invoice.balanceDue)}</p></td><td className="p-3.5"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${info[1]}`}>{info[0]}</span></td>{showEInvoiceStatus ? <td className="p-3.5"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${einfo[1]}`}>{invoice.gstSnapshot ? "GST" : "Legacy"} · {einfo[0]}</span></td> : null}<td className="p-3.5 capitalize" style={{ color: "var(--text-muted)" }}>{invoice.status}</td><td className="p-3.5 text-right"><button data-invoice-menu-trigger type="button" onClick={(event) => toggleActionMenu(event, invoice._id)} className="rounded-lg p-2 hover:bg-slate-500/10"><MoreHorizontal size={18} /></button></td></tr>; })}{!isLoading && !result.items.length ? <tr><td colSpan={showEInvoiceStatus ? 9 : 8} className="py-14 text-center"><p className="font-medium">No invoices found</p><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>{filters.search || filters.paymentStatus || filters.status ? "Try clearing filters or searching with another term." : "Create your first invoice to start tracking sales."}</p></td></tr> : null}</tbody></table></div>{renderActionMenu()}</section>

    {customerOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"><form onSubmit={saveCustomer} className="w-full max-w-lg rounded-2xl border p-6 shadow-xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">Add customer</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>GSTIN is optional. Its state is detected automatically; manual entry remains available.</p></div><button type="button" onClick={() => setCustomerOpen(false)} className="rounded-lg p-2 hover:bg-slate-500/10"><X size={18} /></button></div>{customerError ? <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{customerError}</p> : null}<div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="sm:col-span-2"><span className="mb-2 block text-sm font-medium">Name</span><input required value={customerForm.name} onChange={(event) => setCustomerForm((current) => ({ ...current, name: event.target.value }))} className="field" /></label><label><span className="mb-2 block text-sm font-medium">Mobile</span><input value={customerForm.phone} onChange={(event) => setCustomerForm((current) => ({ ...current, phone: event.target.value }))} className="field" /></label><label><span className="mb-2 block text-sm font-medium">Email</span><input type="email" value={customerForm.email} onChange={(event) => setCustomerForm((current) => ({ ...current, email: event.target.value }))} className="field" /></label><label><span className="mb-2 block text-sm font-medium">GSTIN (optional)</span><input maxLength={15} value={customerForm.gstNumber} onChange={(event) => setCustomerForm((current) => updateCustomerGstFields(current, event.target.value))} placeholder="23ABCDE1234F1Z5" className="w-full rounded-xl border bg-transparent px-3 py-3 text-sm uppercase" style={{ borderColor: "var(--panel-border)" }} /></label><label><span className="mb-2 block text-sm font-medium">Customer state</span><select value={customerForm.stateCode} onChange={(event) => setCustomerForm((current) => ({ ...current, stateCode: event.target.value, placeOfSupplyCode: event.target.value }))} disabled={Boolean(stateCodeFromGstin(customerForm.gstNumber))} className="w-full rounded-xl border bg-transparent px-3 py-3 text-sm disabled:opacity-70" style={{ borderColor: "var(--panel-border)" }}><option value="">Select state manually</option>{Object.entries(customerGstStates).map(([code, state]) => <option key={code} value={code}>{state} ({code})</option>)}</select></label></div>{stateCodeFromGstin(customerForm.gstNumber) ? <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">State detected from GSTIN: {customerGstStates[stateCodeFromGstin(customerForm.gstNumber)]} ({stateCodeFromGstin(customerForm.gstNumber)})</p> : null}<div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setCustomerOpen(false)} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Cancel</button><button disabled={customerSaving} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{customerSaving ? "Adding..." : "Add and select"}</button></div></form></div> : null}
    {paymentOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"><form onSubmit={recordPayment} className="w-full max-w-lg rounded-2xl border p-6 shadow-xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">Record Payment</h3><p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>Records the received amount for invoice {paymentTarget?.invoiceNumber || postIssue?.invoice?.invoiceNumber}.</p></div><button type="button" onClick={() => { if (!paymentSaving) { setPaymentOpen(false); setPaymentTarget(null); } }} className="rounded-lg p-2 hover:bg-slate-500/10"><X size={18} /></button></div>{paymentError ? <p className="mt-3 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{paymentError}</p> : null}<div className="mt-5 grid gap-4 sm:grid-cols-2"><label><span className="mb-2 block text-sm font-medium">Amount</span><input value={paymentForm.amount} onChange={(event) => setPaymentForm((current) => ({ ...current, amount: event.target.value }))} className="field" /></label><label><span className="mb-2 block text-sm font-medium">Method</span><select value={paymentForm.paymentMethod} onChange={(event) => setPaymentForm((current) => ({ ...current, paymentMethod: event.target.value }))} className="field"><option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CASH">Cash</option><option value="CHEQUE">Cheque</option><option value="CARD">Card</option><option value="OTHER">Other</option></select></label><label><span className="mb-2 block text-sm font-medium">Payment date</span><input type="date" value={paymentForm.paymentDate} onChange={(event) => setPaymentForm((current) => ({ ...current, paymentDate: event.target.value }))} className="field" /></label><label><span className="mb-2 block text-sm font-medium">Reference</span><input value={paymentForm.referenceNumber} onChange={(event) => setPaymentForm((current) => ({ ...current, referenceNumber: event.target.value }))} className="field" /></label><label className="sm:col-span-2"><span className="mb-2 block text-sm font-medium">Notes</span><textarea rows="3" value={paymentForm.notes} onChange={(event) => setPaymentForm((current) => ({ ...current, notes: event.target.value }))} className="field" /></label></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => { if (!paymentSaving) { setPaymentOpen(false); setPaymentTarget(null); } }} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Cancel</button><button disabled={paymentSaving} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{paymentSaving ? "Recording..." : "Record Payment"}</button></div></form></div> : null}
    {cancelTarget ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"><div className="w-full max-w-md rounded-2xl border p-6 shadow-xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-600"><CircleAlert size={20} /></div><h3 className="mt-4 text-lg font-semibold">Cancel this invoice?</h3><p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>Invoice <strong>{cancelTarget.invoiceNumber}</strong> will be cancelled and its stock impact reversed. This cannot be undone.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setCancelTarget(null)} disabled={active.type === "cancel"} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Keep invoice</button><button type="button" onClick={cancel} disabled={active.type === "cancel"} className="rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{active.type === "cancel" ? "Cancelling..." : "Cancel invoice"}</button></div></div></div> : null}
  </div>;
};

export default InvoicesPage;
