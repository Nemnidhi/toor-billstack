import { useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, IndianRupee, Plus, ReceiptText, Search, X } from "lucide-react";
import { EmptyState, LoadingState } from "../../../components/ui/PageState";
import PageHeader from "../../../components/ui/PageHeader";
import { uiStore } from "../../../store/uiStore";
import { useCreateAction } from "../../workspace/useCreateAction";
import {
  cancelExpenseRequest,
  createExpenseRequest,
  expenseCategoriesRequest,
  expenseSummaryRequest,
  listExpensesRequest,
  updateExpenseRequest,
} from "../../auth/api";

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
};

const paymentStatuses = ["UNPAID", "PAID", "PARTIAL"];
const paymentMethods = ["", "CASH", "BANK_TRANSFER", "CHEQUE", "UPI", "CARD", "OTHER"];
const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const humanize = (value) => {
  const text = String(value || "").replaceAll("_", " ").toLowerCase();
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
  const [editor, setEditor] = useState(null);
  const [form, setForm] = useState(blankExpense);
  const [saving, setSaving] = useState(false);
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

  const openCreate = () => { setForm(blankExpense); setEditor("new"); };
  useCreateAction({ ready: !loading, moduleKey: "expenses", roles: ["owner", "admin", "accountant"], onCreate: openCreate, focusSelector: '#expense-editor input' });
  const openEdit = (expense) => {
    setForm({
      ...blankExpense,
      ...expense,
      expenseDate: expense.expenseDate ? new Date(expense.expenseDate).toISOString().slice(0, 10) : blankExpense.expenseDate,
      amountBeforeTax: expense.amountBeforeTax ?? "",
      gstRate: expense.gstRate ?? "",
    });
    setEditor(expense);
  };
  const updateForm = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const updateFilter = (key, value) => setFilters((current) => ({ ...current, page: 1, [key]: value }));

  const saveExpense = async (event) => {
    event.preventDefault();
    if (savingLock.current) return;
    savingLock.current = true;
    setSaving(true);
    setError("");
    try {
      const estimatedRawTotal = estimateExpenseTotal(form);
      const paidAmount =
        form.paymentStatus === "PAID" && form.paidAmount === ""
          ? estimatedRawTotal
          : form.paymentStatus === "UNPAID" && form.paidAmount === ""
            ? 0
            : Number(form.paidAmount || 0);
      const payload = {
        ...form,
        amountBeforeTax: Number(form.amountBeforeTax || 0),
        paidAmount,
        gstRate: Number(form.gstRate || 0),
      };
      if (editor === "new") await createExpenseRequest(payload);
      else await updateExpenseRequest(editor._id, payload);
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
                <tr key={expense._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                  <td className="p-4 whitespace-nowrap font-semibold">{expense.expenseNumber}</td>
                  <td className="p-4 whitespace-nowrap">{date(expense.expenseDate)}</td>
                  <td className="p-4">{expense.category}{expense.customCategory ? ` / ${expense.customCategory}` : ""}</td>
                  <td className="p-4">{expense.vendorName || expense.supplierId?.supplierName || "—"}<p className="text-xs" style={{ color: "var(--text-muted)" }}>{expense.description || ""}</p></td>
                  <td className="p-4 whitespace-nowrap text-right font-semibold">{money(expense.totalAmount)}</td>
                  <td className="p-4 whitespace-nowrap text-right">{money(expense.taxAmount)}<p className="text-xs" style={{ color: "var(--text-muted)" }}>{expense.gstType === "GST_RECORDED" ? `${expense.gstRate}% recorded` : expense.gstType === "NONE" ? "No GST" : humanize(expense.gstType)}</p></td>
                  <td className="p-4"><StatusPill value={expense.paymentStatus} /><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Paid {money(expense.paidAmount)} · Due {money(expense.balanceAmount)}</p><p className="text-xs" style={{ color: "var(--text-muted)" }}>{expense.paymentMethod ? humanize(expense.paymentMethod) : "No method"}</p></td>
                  <td className="p-4 text-right"><div className="flex justify-end gap-2"><button onClick={() => openEdit(expense)} disabled={expense.status === "CANCELLED"} className="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-40" style={{ borderColor: "var(--panel-border)" }}>Edit</button><button onClick={() => cancelExpense(expense)} disabled={expense.status === "CANCELLED"} className="rounded-lg border border-rose-500/25 px-3 py-1.5 text-xs text-rose-600 disabled:opacity-40">{expense.status === "CANCELLED" ? "Cancelled" : "Cancel"}</button></div></td>
                </tr>
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

      {editor ? <ExpenseModal form={form} setForm={updateForm} categories={categories} saving={saving} error={error} estimatedTotal={estimatedTotal} mode={editor === "new" ? "new" : "edit"} onSave={saveExpense} onClose={() => setEditor(null)} /> : null}
    </div>
  );
};

const StatusPill = ({ value }) => {
  const tone = value === "PAID" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : value === "PARTIAL" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-rose-500/10 text-rose-700 dark:text-rose-300";
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`}><span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />{value === "PARTIAL" ? "Partly paid" : humanize(value)}</span>;
};

const ExpenseModal = ({ form, setForm, categories, saving, error, estimatedTotal, mode, onSave, onClose }) => (
  <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/55 p-4">
    <form id="expense-editor" onSubmit={onSave} className="mx-auto my-6 w-full max-w-3xl rounded-2xl border p-6 shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}>
      <div className="flex justify-between gap-4"><div><p className="text-sm font-medium text-brand-600">Expense details</p><h3 className="mt-1 text-xl font-semibold">{mode === "new" ? "Add expense" : "Edit expense"}</h3></div><button type="button" disabled={saving} onClick={onClose}><X size={20} /></button></div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Expense date"><input required type="date" value={form.expenseDate || ""} onChange={(e) => setForm("expenseDate", e.target.value)} className="field" /></Field>
        <Field label="Category"><select value={form.category || "Miscellaneous"} onChange={(e) => setForm("category", e.target.value)} className="field">{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>
        <Field label="Custom category"><input value={form.customCategory || ""} onChange={(e) => setForm("customCategory", e.target.value)} className="field" /></Field>
        <Field label="Vendor / payee"><input value={form.vendorName || ""} onChange={(e) => setForm("vendorName", e.target.value)} className="field" /></Field>
        <Field label="Amount before GST"><input required min="0" step="0.01" type="number" value={form.amountBeforeTax || ""} onChange={(e) => setForm("amountBeforeTax", e.target.value)} className="field" /></Field>
        <Field label="Paid amount"><input min="0" step="0.01" type="number" value={form.paidAmount || ""} onChange={(e) => setForm("paidAmount", e.target.value)} className="field" /></Field>
        <Field label="Payment status"><select value={form.paymentStatus || "UNPAID"} onChange={(e) => setForm("paymentStatus", e.target.value)} className="field">{paymentStatuses.map((item) => <option key={item} value={item}>{humanize(item)}</option>)}</select></Field>
        <Field label="Payment method"><select value={form.paymentMethod || ""} onChange={(e) => setForm("paymentMethod", e.target.value)} className="field">{paymentMethods.map((item) => <option key={item} value={item}>{item ? humanize(item) : "Not recorded"}</option>)}</select></Field>
        <Field label="Reference number"><input value={form.referenceNumber || ""} onChange={(e) => setForm("referenceNumber", e.target.value)} className="field" /></Field>
      </div>
      <div className="mt-5 rounded-xl border p-4" style={{ borderColor: "var(--panel-border)" }}>
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={Boolean(form.gstEnabled)} onChange={(e) => setForm("gstEnabled", e.target.checked)} /> Record GST on this expense</label>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="GST rate"><input min="0" max="100" step="0.01" type="number" value={form.gstRate || ""} onChange={(e) => setForm("gstRate", e.target.value)} disabled={!form.gstEnabled} className="field disabled:opacity-50" /></Field>
          <div><p className="text-sm font-medium">Estimated total</p><p className="mt-3 text-2xl font-semibold">{estimatedTotal}</p><p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>Final total is calculated when you save.</p></div>
        </div>
      </div>
      <Field label="Description"><input value={form.description || ""} onChange={(e) => setForm("description", e.target.value)} className="field" /></Field>
      <Field label="Notes"><textarea rows="3" value={form.notes || ""} onChange={(e) => setForm("notes", e.target.value)} className="field" /></Field>
      {error ? <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p> : null}<div className="mt-6 flex justify-end gap-3"><button type="button" disabled={saving} onClick={onClose} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Cancel</button><button disabled={saving} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{saving ? "Saving..." : "Save expense"}</button></div>
    </form>
  </div>
);

const Field = ({ label, children }) => <label className="block"><span className="mb-2 block text-sm font-medium">{label}</span>{children}</label>;

export default ExpensesPage;
