import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Camera, CircleAlert, IndianRupee, Plus, ReceiptText, Search, X } from "lucide-react";
import { EmptyState, LoadingState } from "../../../components/ui/PageState";
import PageHeader from "../../../components/ui/PageHeader";
import CentreInput, { forgetCentres } from "../../../components/ui/CentreInput";
import ReportTagFields from "../../../components/ui/ReportTagFields";
import { TDS_KINDS } from "../../../components/ui/TdsFields";
import DocumentsPanel from "../../../components/ui/DocumentsPanel";
import { uiStore } from "../../../store/uiStore";
import { useCreateAction } from "../../workspace/useCreateAction";
import {
  cancelExpenseRequest,
  createExpenseRequest,
  expenseCategoriesRequest,
  expenseSummaryRequest,
  listExpensesRequest,
  listSuppliersRequest,
  rcmDocumentsRequest,
  readBillRequest,
  readBillStatusRequest,
  updateExpenseRequest,
} from "../../auth/api";
import { uploadDocumentRequest } from "../../accounting/api";

const blankExpense = {
  expenseDate: new Date().toISOString().slice(0, 10),
  category: "Miscellaneous",
  customCategory: "",
  vendorName: "",
  description: "",
  amountBeforeTax: "",
  paidAmount: "",
  gstEnabled: false,
  gstRate: "",
  gstType: "NONE",
  paymentStatus: "UNPAID",
  paymentMethod: "",
  referenceNumber: "",
  notes: "",
  centre: "",
  businessLine: "",
  reportCategory: "",
  supplierId: "",
  supplierInvoiceNumber: "",
  supplierInvoiceDate: "",
  supplierGstin: "",
  placeOfSupplyCode: "",
  itcEligible: true,
  // "__supplier__" = take the supplier's usual TDS type; "" = no TDS on this bill
  tdsKind: "__supplier__",
  tdsRate: "",
  tdsAmount: "",
};

// TDS on this bill as the server will work it out: typed amount, else rate x amount before GST
// (the typed rate, else the supplier's own rate, else the usual rate; at least 20% without PAN).
const estimateExpenseTds = (form, supplier) => {
  const kindKey = form.tdsKind === "__supplier__" ? supplier?.tdsKind || "" : form.tdsKind;
  if (!kindKey) return { kindKey: "", rate: 0, amount: 0 };
  if (form.tdsAmount !== "" && form.tdsAmount !== null && form.tdsAmount !== undefined) return { kindKey, rate: Number(form.tdsRate || 0), amount: Number(form.tdsAmount) };
  const kind = TDS_KINDS.find((item) => item.key === kindKey);
  let rate = form.tdsRate !== "" && form.tdsRate !== null && form.tdsRate !== undefined ? Number(form.tdsRate) : null;
  if (rate === null) {
    rate = supplier?.tdsRate !== null && supplier?.tdsRate !== undefined ? Number(supplier.tdsRate) : kind?.rate || 0;
    if (supplier && !supplier.pan) rate = Math.max(rate, 20);
  }
  return { kindKey, rate, amount: Math.round((Number(form.amountBeforeTax || 0) * rate) / 100) };
};

const paymentStatuses = ["UNPAID", "PAID", "PARTIAL"];
// CARD: a debit card (paid from the bank). CREDIT_CARD: owed to the card until its bill is paid.
const paymentMethods = ["", "CASH", "BANK_TRANSFER", "CHEQUE", "UPI", "CARD", "CREDIT_CARD", "OTHER"];
const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const humanize = (value) => {
  const text = String(value || "").replaceAll("_", " ").toLowerCase();
  if (text === "card") return "Debit card";
  return text === "upi" ? "UPI" : text.charAt(0).toUpperCase() + text.slice(1);
};
const date = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

const estimateExpenseTotal = (form) => {
  const base = Number(form.amountBeforeTax || 0);
  const gst = form.gstEnabled ? (base * Number(form.gstRate || 0)) / 100 : 0;
  return Math.round((base + gst + Number.EPSILON) * 100) / 100;
};

const ExpensesPage = () => {
  const [filters, setFilters] = useState({ page: 1, limit: 25, search: "", category: "", paymentStatus: "", from: "", to: "" });
  const [result, setResult] = useState({ items: [], pagination: { page: 1, totalPages: 1 } });
  const [summary, setSummary] = useState({ totalExpenses: 0, paid: 0, unpaid: 0, gstRecorded: 0, byCategory: [] });
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [docsOpen, setDocsOpen] = useState("");
  const [editor, setEditor] = useState(null);
  const [form, setForm] = useState(blankExpense);
  const [suppliers, setSuppliers] = useState([]);
  const [saving, setSaving] = useState(false);
  // The bill photo / PDF read into this form: kept to attach to the expense once it is saved.
  const [billFile, setBillFile] = useState(null);
  const savingLock = useRef(false);

  const estimatedTotal = useMemo(() => {
    return money(estimateExpenseTotal(form));
  }, [form.amountBeforeTax, form.gstEnabled, form.gstRate]);

  const loadExpenses = async () => {
    setLoading(true);
    setError("");
    try {
      const [list, totals, categoryList] = await Promise.all([
        listExpensesRequest(filters),
        expenseSummaryRequest(filters),
        categories.length ? Promise.resolve(categories) : expenseCategoriesRequest(),
      ]);
      setResult(list);
      setSummary(totals);
      setCategories(categoryList || []);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load expenses.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadExpenses(); }, [filters.page, filters.search, filters.category, filters.paymentStatus, filters.from, filters.to]);
  useEffect(() => {
    listSuppliersRequest({ page: 1, limit: 200, sortBy: "supplierName", sortOrder: "asc" }).then((data) => setSuppliers(data?.items || [])).catch(() => {});
  }, []);

  const openCreate = () => { setForm(blankExpense); setBillFile(null); setEditor("new"); };
  useCreateAction({ ready: !loading, moduleKey: "expenses", roles: ["owner", "admin", "accountant"], onCreate: openCreate, focusSelector: '#expense-editor input' });
  const openEdit = (expense) => {
    setForm({
      ...blankExpense,
      ...expense,
      expenseDate: expense.expenseDate ? new Date(expense.expenseDate).toISOString().slice(0, 10) : blankExpense.expenseDate,
      amountBeforeTax: expense.amountBeforeTax ?? "",
      gstRate: expense.gstRate ?? "",
      supplierId: expense.supplierId?._id || expense.supplierId || "",
      supplierInvoiceDate: expense.supplierInvoiceDate ? new Date(expense.supplierInvoiceDate).toISOString().slice(0, 10) : "",
      itcEligible: expense.itcEligible !== false,
      tdsKind: expense.tdsKind || "",
      tdsRate: expense.tdsKind ? expense.tdsRate ?? "" : "",
      // leave the amount blank when it is just rate x amount, so it follows edits to the bill
      tdsAmount: expense.tdsKind && Number(expense.tdsAmount) !== Math.round((Number(expense.amountBeforeTax || 0) * Number(expense.tdsRate || 0)) / 100) ? expense.tdsAmount ?? "" : "",
    });
    setBillFile(null);
    setEditor(expense);
  };
  const mergeForm = (fields) => setForm((current) => ({ ...current, ...fields }));
  const updateForm = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const updateFilter = (key, value) => setFilters((current) => ({ ...current, page: 1, [key]: value }));

  const saveExpense = async (event) => {
    event.preventDefault();
    if (savingLock.current) return;
    savingLock.current = true;
    setSaving(true);
    setError("");
    try {
      // Fully paid with no amount typed: the server takes the bill less any TDS.
      const paidAmount =
        form.paymentStatus === "PAID" && form.paidAmount === ""
          ? undefined
          : form.paymentStatus === "UNPAID" && form.paidAmount === ""
            ? 0
            : Number(form.paidAmount || 0);
      const { tdsKind, tdsRate, tdsAmount, ...rest } = form;
      const payload = {
        ...rest,
        supplierId: form.supplierId || null,
        amountBeforeTax: Number(form.amountBeforeTax || 0),
        paidAmount,
        gstRate: Number(form.gstRate || 0),
      };
      if (tdsKind !== "__supplier__") payload.tdsKind = tdsKind;
      if (tdsKind && tdsRate !== "" && tdsRate !== null && tdsRate !== undefined) payload.tdsRate = Number(tdsRate);
      if (tdsKind && tdsAmount !== "" && tdsAmount !== null && tdsAmount !== undefined) payload.tdsAmount = Number(tdsAmount);
      const saved = editor === "new" ? await createExpenseRequest(payload) : await updateExpenseRequest(editor._id, payload);
      if (billFile && saved?._id) {
        await uploadDocumentRequest("expense", saved._id, { fileBase64: billFile.fileBase64, fileName: billFile.fileName, kind: "BILL" }).catch(() => {
          uiStore.getState().pushToast({ tone: "warning", message: "Expense saved, but the bill could not be attached. Attach it from Docs." });
        });
      }
      if (payload.centre) forgetCentres();
      uiStore.getState().pushToast({ tone: "success", message: editor === "new" ? "Expense recorded." : "Expense updated." });
      setEditor(null);
      await loadExpenses();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to save expense.");
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  };

  // Self-invoice and payment voucher for a reverse-charge bill, in a printable window.
  const printRcm = async (expense) => {
    try {
      const docs = await rcmDocumentsRequest(expense._id);
      const win = window.open("", "_blank");
      if (!win) return setError("Allow pop-ups to print the self-invoice.");
      win.document.write(rcmDocumentsHtml(docs));
      win.document.close();
      win.focus();
      win.print();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to prepare the self-invoice.");
    }
  };

  const cancelExpense = async (expense) => {
    const reason = window.prompt(`Cancel ${expense.expenseNumber}?`, "Entered by mistake");
    if (!reason) return;
    try {
      await cancelExpenseRequest(expense._id, reason);
      uiStore.getState().pushToast({ tone: "success", message: "Expense cancelled." });
      await loadExpenses();
    } catch (err) {
      setError(err.response?.data?.message || "Unable to cancel expense.");
    }
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 pb-8">
      <PageHeader
        kicker="Operating spend"
        title="Expenses"
        description="Record operating expenses separately from purchases. GST is recorded for reporting only and is not claimed as input tax credit."
        actions={<button type="button" onClick={openCreate} className="btn-primary"><Plus size={17} /> Add expense</button>}
      />

      {error ? <div role="alert" className="alert alert-error"><CircleAlert size={18} /><span className="flex-1">{error}</span><button type="button" aria-label="Dismiss" onClick={() => setError("")}><X size={16} /></button></div> : null}

      <section className="stat-grid">
        {[["Total expenses", summary.totalExpenses, "All active operating spend", ""], ["Paid", summary.paid, "Paid expense records", "text-emerald-600"], ["Unpaid / partial", summary.unpaid, "Outstanding operating spend", Number(summary.unpaid) > 0 ? "text-amber-600" : ""], ["GST recorded", summary.gstRecorded, "Recorded, not claimed as ITC", ""]].map(([label, value, help, tone]) => (
          <div key={label} className="panel stat-card">
            <div className="flex items-center justify-between"><p className="stat-label">{label}</p><IndianRupee size={15} style={{ color: "var(--text-muted)" }} /></div>
            <p className={`stat-value ${tone}`}>{money(value)}</p>
            <p className="stat-detail">{help}</p>
          </div>
        ))}
      </section>

      <section className="panel overflow-hidden">
        <div className="grid gap-3 border-b p-4 lg:grid-cols-[minmax(220px,1fr)_180px_160px_150px_150px]" style={{ borderColor: "var(--panel-border)" }}>
          <label className="relative"><span className="sr-only">Search expenses</span><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--text-muted)" }} /><input value={filters.search} onChange={(e) => updateFilter("search", e.target.value)} placeholder="Search expense, vendor, reference" className="field pl-9" /></label>
          <select value={filters.category} onChange={(e) => updateFilter("category", e.target.value)} className="field"><option value="">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select>
          <select value={filters.paymentStatus} onChange={(e) => updateFilter("paymentStatus", e.target.value)} className="field"><option value="">All statuses</option>{paymentStatuses.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select>
          <input type="date" aria-label="From date" value={filters.from} onChange={(e) => updateFilter("from", e.target.value)} className="field" />
          <input type="date" aria-label="To date" value={filters.to} onChange={(e) => updateFilter("to", e.target.value)} className="field" />
        </div>
        {loading ? <div className="p-6"><LoadingState title="Loading expenses" description="Fetching operating spend records." /></div> : result.items.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[980px] w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide" style={{ color: "var(--text-muted)", background: "color-mix(in srgb, var(--theme-surface-muted) 65%, transparent)" }}>
                <tr><th className="p-4">Expense #</th><th className="p-4">Date</th><th className="p-4">Category</th><th className="p-4">Vendor</th><th className="p-4 text-right">Amount</th><th className="p-4 text-right">GST</th><th className="p-4">Payment</th><th className="p-4 text-right">Actions</th></tr>
              </thead>
              <tbody>{result.items.map((expense) => (
                <Fragment key={expense._id}>
                <tr className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                  <td className="p-4 whitespace-nowrap font-semibold">{expense.expenseNumber}</td>
                  <td className="p-4 whitespace-nowrap">{date(expense.expenseDate)}</td>
                  <td className="p-4">{expense.category}{expense.customCategory ? ` / ${expense.customCategory}` : ""}{[expense.centre, expense.businessLine, expense.reportCategory].some(Boolean) ? <span className="block text-xs" style={{ color: "var(--text-muted)" }}>{[expense.centre, expense.businessLine, expense.reportCategory].filter(Boolean).join(" · ")}</span> : null}</td>
                  <td className="p-4">{expense.vendorName || expense.supplierId?.supplierName || "—"}<p className="text-xs" style={{ color: "var(--text-muted)" }}>{expense.description || ""}</p></td>
                  <td className="p-4 whitespace-nowrap text-right font-semibold">{money(expense.totalAmount)}</td>
                  <td className="p-4 whitespace-nowrap text-right">{money(expense.taxAmount)}<p className="text-xs" style={{ color: "var(--text-muted)" }}>{expense.gstType === "GST_RECORDED" ? `${expense.gstRate}% recorded` : expense.gstType === "NONE" ? "No GST" : humanize(expense.gstType)}</p></td>
                  <td className="p-4"><StatusPill value={expense.paymentStatus} /><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Paid {money(expense.paidAmount)} · Due {money(expense.balanceAmount)}</p><p className="text-xs" style={{ color: "var(--text-muted)" }}>{expense.paymentMethod ? humanize(expense.paymentMethod) : "No method"}</p></td>
                  <td className="p-4 text-right"><div className="flex justify-end gap-2"><button onClick={() => setDocsOpen(docsOpen === expense._id ? "" : expense._id)} className="rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: "var(--panel-border)" }}>Docs{expense.attachments?.length ? ` (${expense.attachments.length})` : ""}</button><button onClick={() => openEdit(expense)} disabled={expense.status === "CANCELLED"} className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40" style={{ borderColor: "var(--panel-border)" }}>Edit</button>{expense.gstType === "REVERSE_CHARGE" ? <button onClick={() => printRcm(expense)} className="rounded-lg border px-3 py-1.5 text-xs" style={{ borderColor: "var(--panel-border)" }} title={expense.selfInvoiceNumber}>Self-invoice</button> : null}<button onClick={() => cancelExpense(expense)} disabled={expense.status === "CANCELLED"} className="rounded-lg border border-rose-500/25 px-3 py-1.5 text-xs text-rose-600 disabled:opacity-40">{expense.status === "CANCELLED" ? "Cancelled" : "Cancel"}</button></div></td>
                </tr>
                {docsOpen === expense._id ? <tr><td colSpan={8} className="px-4 pb-4"><DocumentsPanel recordType="expense" recordId={expense._id} documents={expense.attachments || []} defaultKind="BILL" kinds={["BILL", "RECEIPT", "AGREEMENT", "OTHER"]} /></td></tr> : null}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        ) : <div className="p-6"><EmptyState title="No expenses found" description="Record operating spend such as rent, utilities, software, travel, or salaries." /></div>}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
          <h3 className="font-semibold">Category summary</h3>
          <div className="mt-4 space-y-3">{summary.byCategory?.length ? summary.byCategory.map((item) => <div key={item.category} className="flex justify-between rounded-xl border p-3" style={{ borderColor: "var(--panel-border)" }}><span>{item.category}</span><strong>{money(item.amount)}</strong></div>) : <p className="text-sm" style={{ color: "var(--text-muted)" }}>No category spend for this filter.</p>}</div>
        </div>
        <div className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
          <h3 className="font-semibold">How expenses are handled</h3>
          <div className="mt-4 space-y-3 text-sm" style={{ color: "var(--text-muted)" }}>
            <p><ReceiptText size={16} className="mr-2 inline text-brand-500" /> Expenses are operating spend, not supplier purchases or inventory receipts.</p>
            <p>GST is stored as a snapshot for reporting visibility. Recording an expense does not claim input tax credit or file GST returns.</p>
            <p>Expense paid/unpaid status is kept on the expense record and does not create customer or supplier ledger/payment allocations.</p>
          </div>
        </div>
      </section>

      {editor ? <ExpenseModal form={form} setForm={updateForm} mergeForm={mergeForm} billFile={billFile} setBillFile={setBillFile} suppliers={suppliers} categories={categories} saving={saving} error={error} estimatedTotal={estimatedTotal} mode={editor === "new" ? "new" : "edit"} onSave={saveExpense} onClose={() => setEditor(null)} /> : null}
    </div>
  );
};

const StatusPill = ({ value }) => {
  const tone = value === "PAID" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : value === "PARTIAL" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />{value === "PARTIAL" ? "Partly paid" : humanize(value)}</span>;
};

const ExpenseTds = ({ form, setForm, suppliers }) => {
  const supplier = suppliers.find((item) => item._id === form.supplierId);
  const tds = estimateExpenseTds(form, supplier);
  const total = estimateExpenseTotal(form);
  return (
    <div className="mt-5 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}>
      <p className="text-sm font-medium">TDS we deduct</p>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Rent above ₹50,000 a month, contractors, professionals and brokers. The payee is paid the bill less TDS; the TDS is deposited with the government by challan (Accounting → TDS).</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        <Field label="TDS type">
          <select value={form.tdsKind ?? "__supplier__"} onChange={(e) => { setForm("tdsKind", e.target.value); setForm("tdsRate", ""); setForm("tdsAmount", ""); }} className="field">
            <option value="__supplier__">{supplier?.tdsKind ? `Supplier's usual (${TDS_KINDS.find((k) => k.key === supplier.tdsKind)?.label || supplier.tdsKind})` : "Supplier's usual (none)"}</option>
            <option value="">No TDS on this bill</option>
            {TDS_KINDS.map((kind) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
          </select>
        </Field>
        <Field label="Rate % (blank = usual)"><input min="0" max="100" step="0.01" type="number" disabled={!tds.kindKey} value={form.tdsRate ?? ""} onChange={(e) => { setForm("tdsRate", e.target.value); setForm("tdsAmount", ""); }} className="field disabled:opacity-50" placeholder={tds.kindKey ? String(tds.rate) : ""} /></Field>
        <Field label="TDS amount (blank = worked out)"><input min="0" step="0.01" type="number" disabled={!tds.kindKey} value={form.tdsAmount ?? ""} onChange={(e) => setForm("tdsAmount", e.target.value)} className="field disabled:opacity-50" placeholder={tds.kindKey ? String(tds.amount) : ""} /></Field>
      </div>
      {tds.kindKey ? (
        <p className="mt-3 text-sm">TDS {money(tds.amount)} · payable to {supplier?.supplierName || form.vendorName || "the payee"}: <strong>{money(Math.max(total - tds.amount, 0))}</strong>{supplier && !supplier.pan ? <span className="text-rose-600"> · no PAN on file, 20% applies</span> : null}</p>
      ) : null}
    </div>
  );
};

const ExpenseModal = ({ form, setForm, mergeForm, billFile, setBillFile, suppliers = [], categories, saving, error, estimatedTotal, mode, onSave, onClose }) => (
  <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/55 p-4">
    <form id="expense-editor" onSubmit={onSave} className="mx-auto my-6 w-full max-w-3xl rounded-2xl border p-6 shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}>
      <div className="flex justify-between gap-4"><div><p className="text-sm font-medium text-brand-600">Expense details</p><h3 className="mt-1 text-xl font-semibold">{mode === "new" ? "Add expense" : "Edit expense"}</h3></div><button type="button" disabled={saving} onClick={onClose}><X size={20} /></button></div>
      {mode === "new" ? <BillReader mergeForm={mergeForm} billFile={billFile} setBillFile={setBillFile} disabled={saving} /> : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Expense date"><input required type="date" value={form.expenseDate || ""} onChange={(e) => setForm("expenseDate", e.target.value)} className="field" /></Field>
        <Field label="Category"><select value={form.category || "Miscellaneous"} onChange={(e) => setForm("category", e.target.value)} className="field">{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
        <Field label="Custom category"><input value={form.customCategory || ""} onChange={(e) => setForm("customCategory", e.target.value)} className="field" /></Field>
        <Field label="Supplier / landlord (optional)"><select value={form.supplierId || ""} onChange={(e) => setForm("supplierId", e.target.value)} className="field"><option value="">Not a saved supplier</option>{suppliers.map((item) => <option key={item._id} value={item._id}>{item.supplierName}</option>)}</select></Field>
        <Field label="Vendor / payee"><input value={form.vendorName || ""} onChange={(e) => setForm("vendorName", e.target.value)} className="field" /></Field>
        <Field label="Centre / property (optional)"><CentreInput value={form.centre} onChange={(value) => setForm("centre", value)} /></Field>
        <ReportTagFields value={form} onChange={(field, value) => setForm(field, value)} />
        <Field label="Amount before GST"><input required min="0" step="0.01" type="number" value={form.amountBeforeTax || ""} onChange={(e) => setForm("amountBeforeTax", e.target.value)} className="field" /></Field>
        <Field label="Paid amount"><input min="0" step="0.01" type="number" value={form.paidAmount || ""} onChange={(e) => setForm("paidAmount", e.target.value)} className="field" /></Field>
        <Field label="Payment status"><select value={form.paymentStatus || "UNPAID"} onChange={(e) => setForm("paymentStatus", e.target.value)} className="field">{paymentStatuses.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field>
        <Field label="Payment method"><select value={form.paymentMethod || ""} onChange={(e) => setForm("paymentMethod", e.target.value)} className="field">{paymentMethods.map((item) => <option key={item} value={item}>{item ? humanize(item) : "Not recorded"}</option>)}</select></Field>
        <Field label="Reference number"><input value={form.referenceNumber || ""} onChange={(e) => setForm("referenceNumber", e.target.value)} className="field" /></Field>
      </div>
      <div className="mt-5 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}>
        <Field label="GST on this bill">
          <select value={gstModeOf(form)} onChange={(e) => { setForm("gstType", e.target.value); setForm("gstEnabled", e.target.value === "GST_RECORDED"); }} className="field">
            <option value="NONE">No GST</option>
            <option value="GST_RECORDED">GST charged on the bill</option>
            <option value="REVERSE_CHARGE">Reverse charge: supplier unregistered (e.g. rent from an unregistered landlord), we pay the GST</option>
            <option value="EXEMPT">Exempt supply</option>
          </select>
        </Field>
        {gstModeOf(form) === "REVERSE_CHARGE" ? <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>The supplier is paid the bill without GST. We owe the GST (paid in cash with GSTR-3B) and claim the same as input credit. A self-invoice number is given on save; print it with the payment voucher from the list.</p> : null}
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label={gstModeOf(form) === "REVERSE_CHARGE" ? "GST rate (default 18%)" : "GST rate"}><input min="0" max="100" step="0.01" type="number" value={form.gstRate || ""} onChange={(e) => setForm("gstRate", e.target.value)} disabled={!["GST_RECORDED", "REVERSE_CHARGE"].includes(gstModeOf(form))} className="field disabled:opacity-50" placeholder={gstModeOf(form) === "REVERSE_CHARGE" ? "18" : ""} /></Field>
          <div><p className="text-sm font-medium">Estimated total</p><p className="mt-3 text-2xl font-semibold">{estimatedTotal}</p><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Final total is calculated when you save.</p></div>
        </div>
        {["GST_RECORDED", "REVERSE_CHARGE"].includes(gstModeOf(form)) ? (
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <Field label="Supplier's GSTIN"><input value={form.supplierGstin || ""} onChange={(e) => setForm("supplierGstin", e.target.value.toUpperCase())} maxLength={15} className="field" placeholder="Blank = the saved supplier's" /></Field>
            <Field label="Supplier's bill number"><input value={form.supplierInvoiceNumber || ""} onChange={(e) => setForm("supplierInvoiceNumber", e.target.value)} className="field" placeholder="As printed on their bill" /></Field>
            <Field label="Supplier's bill date"><input type="date" value={form.supplierInvoiceDate || ""} onChange={(e) => setForm("supplierInvoiceDate", e.target.value)} className="field" /></Field>
            <label className="mt-7 flex items-start gap-2 text-sm"><input type="checkbox" checked={form.itcEligible !== false} onChange={(e) => setForm("itcEligible", e.target.checked)} className="mt-1" /> <span>Claim input credit<span className="block text-xs" style={{ color: "var(--text-muted)" }}>Untick for blocked credit (food, motor cars, personal use: s.17(5)); the GST then stays in the cost.</span></span></label>
          </div>
        ) : null}
      </div>
      <ExpenseTds form={form} setForm={setForm} suppliers={suppliers} />
      <Field label="Description"><input value={form.description || ""} onChange={(e) => setForm("description", e.target.value)} className="field" /></Field>
      <Field label="Notes"><textarea rows="3" value={form.notes || ""} onChange={(e) => setForm("notes", e.target.value)} className="field" /></Field>
      {error ? <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p> : null}<div className="mt-6 flex justify-end gap-3"><button type="button" disabled={saving} onClick={onClose} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Cancel</button><button disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save expense"}</button></div>
    </form>
  </div>
);

// Photos are shrunk to at most 2000 px and sent as JPEG: smaller uploads, the same reading.
const MAX_SIDE = 2000;
const fileToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the file"));
    reader.readAsDataURL(blob);
  });
const shrinkPhoto = (file) =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare the photo"))), "image/jpeg", 0.85);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This photo could not be opened. Try a JPG or PNG."));
    };
    img.src = url;
  });

const BillReader = ({ mergeForm, billFile, setBillFile, disabled }) => {
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [result, setResult] = useState(null);
  useEffect(() => {
    readBillStatusRequest().then((data) => setEnabled(Boolean(data?.enabled))).catch(() => setEnabled(false));
  }, []);

  const pick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setProblem("");
    setResult(null);
    setBusy(true);
    try {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const blob = isPdf ? file : await shrinkPhoto(file);
      if (blob.size > 5 * 1024 * 1024) throw new Error("The file is larger than 5 MB.");
      const fileBase64 = await fileToBase64(blob);
      const fileName = isPdf ? file.name : `${file.name.replace(/\.[^.]+$/, "") || "bill"}.jpg`;
      const data = await readBillRequest({ fileBase64, fileName });
      const filled = Object.fromEntries(Object.entries(data.fields).filter(([, value]) => value !== "" && value !== null && value !== undefined));
      mergeForm({ ...filled, ...(data.fields.gstType === "NONE" ? { gstEnabled: false, gstRate: "" } : {}) });
      setBillFile({ fileBase64, fileName });
      setResult(data);
    } catch (err) {
      setProblem(err.response?.data?.message || err.message || "The bill could not be read.");
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) return null;
  const off = !enabled || busy || disabled;
  return (
    <div className="mt-5 rounded-xl border border-dashed p-4" style={{ borderColor: "var(--panel-border)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold ${off ? "pointer-events-none opacity-50" : ""}`} style={{ borderColor: "var(--panel-border)" }}>
          <Camera size={16} /> {busy ? "Reading the bill..." : billFile ? "Read another bill" : "Fill from a bill photo"}
          <input type="file" accept="image/*,application/pdf" className="sr-only" disabled={off} onChange={pick} />
        </label>
        <p className="min-w-[200px] flex-1 text-xs" style={{ color: "var(--text-muted)" }}>
          {enabled
            ? "Take a photo or pick a PDF of the bill; the form is filled in for you to check. The bill is attached to the expense when you save."
            : "Not switched on: the owner adds an Anthropic API key on the server to read bills from photos."}
        </p>
      </div>
      {problem ? <p role="alert" className="mt-3 text-sm text-rose-600">{problem}</p> : null}
      {result ? (
        <div className="mt-3 text-sm">
          <p className="font-medium text-emerald-700 dark:text-emerald-300">
            Read{result.supplierName ? `, matched to supplier ${result.supplierName}` : ""}. Check every field before saving{result.read?.totalAmount ? `; the bill's total is ${money(result.read.totalAmount)}` : ""}.
          </p>
          {result.warnings?.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-amber-700 dark:text-amber-300">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
        </div>
      ) : null}
    </div>
  );
};

const gstModeOf = (form) => (form.gstType && form.gstType !== "NONE" ? form.gstType : form.gstEnabled ? "GST_RECORDED" : "NONE");

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rcmDocumentsHtml = ({ selfInvoice: s, paymentVoucher: v }) => {
  const party = (p) => `<b>${escapeHtml(p.name)}</b><br>${escapeHtml(p.address || "")}<br>${p.gstin ? `GSTIN: ${escapeHtml(p.gstin)}` : ""}${p.pan ? `<br>PAN: ${escapeHtml(p.pan)}` : ""}`;
  const rows = (t) => `<tr><td>${escapeHtml(t.description || "")}</td><td>${escapeHtml(t.sac || "")}</td><td class="r">${money(t.taxableValue)}</td><td class="r">${escapeHtml(t.rate)}%</td><td class="r">${money(t.igst)}</td><td class="r">${money(t.cgst)}</td><td class="r">${money(t.sgst)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(s.number)}</title><style>
    body{font:13px Arial,sans-serif;color:#111;margin:32px} h2{margin:0 0 4px} .muted{color:#555} table{border-collapse:collapse;width:100%;margin-top:12px} td,th{border:1px solid #999;padding:6px;text-align:left} .r{text-align:right} .grid{display:flex;gap:24px;margin-top:12px} .grid>div{flex:1;border:1px solid #ccc;padding:8px} .page{page-break-after:always;margin-bottom:40px}
  </style></head><body>
  <div class="page"><h2>Self invoice</h2><p class="muted">${escapeHtml(s.title)}</p>
  <p>No. <b>${escapeHtml(s.number)}</b> &nbsp; Date: ${date(s.date)} &nbsp; Reverse charge: Yes &nbsp; Our bill: ${escapeHtml(s.reference)}</p>
  <div class="grid"><div>Recipient (issuer)<br>${party(s.recipient)}</div><div>Supplier<br>${party(s.supplier)}</div></div>
  <table><tr><th>Description</th><th>SAC</th><th class="r">Taxable value</th><th class="r">Rate</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th></tr>${s.lines.map(rows).join("")}</table>
  <p>Tax payable under reverse charge: <b>${money(s.totalTax)}</b><br>${escapeHtml(s.totalInWords)}</p>
  <p style="margin-top:48px">For ${escapeHtml(s.recipient.name)}<br><br>Authorised signatory</p></div>
  <div><h2>Payment voucher</h2><p class="muted">${escapeHtml(v.title)}</p>
  <p>No. <b>${escapeHtml(v.number)}</b> &nbsp; Date: ${v.date ? date(v.date) : "____________"} &nbsp; Against self invoice ${escapeHtml(s.number)}</p>
  <div class="grid"><div>Paid by<br>${party(v.recipient)}</div><div>Paid to<br>${party(v.supplier)}</div></div>
  <table><tr><th>Amount paid</th><th>Rate</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Tax (reverse charge)</th></tr>
  <tr><td>${money(v.amountPaid)}</td><td>${escapeHtml(v.rate)}%</td><td class="r">${money(v.tax.igst)}</td><td class="r">${money(v.tax.cgst)}</td><td class="r">${money(v.tax.sgst)}</td><td class="r">${money(v.totalTax)}</td></tr></table>
  <p>${escapeHtml(v.amountInWords)}</p>
  <p style="margin-top:48px">For ${escapeHtml(v.recipient.name)}<br><br>Authorised signatory</p></div>
  </body></html>`;
};

const Field = ({ label, children }) => <label className="block"><span className="mb-2 block text-sm font-medium">{label}</span>{children}</label>;

export default ExpensesPage;
