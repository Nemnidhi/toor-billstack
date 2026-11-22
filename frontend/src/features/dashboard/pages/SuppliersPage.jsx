import { useEffect, useState } from "react";
import {
  createSupplierRequest,
  deleteSupplierRequest,
  listProductsRequest,
  listSuppliersRequest,
  updateSupplierRequest,
} from "../../auth/api";
import { TDS_KINDS } from "../../../components/ui/TdsFields";
import DocumentsPanel from "../../../components/ui/DocumentsPanel";

const initialForm = {
  supplierName: "",
  phone: "",
  email: "",
  address: "",
  gstNumber: "",
  pan: "",
  tdsKind: "",
  tdsRate: "",
  msmeType: "",
  udyamNumber: "",
  msmeTrader: "false",
  msmeCreditDays: "",
  productsSupplied: [],
  notes: "",
  paymentStatus: "unpaid",
};

const SuppliersPage = () => {
  const [filters, setFilters] = useState({
    page: 1,
    limit: 10,
    search: "",
    sortBy: "createdAt",
    sortOrder: "desc",
    paymentStatus: "",
  });
  const [result, setResult] = useState({ items: [], pagination: { page: 1, totalPages: 1, total: 0 } });
  const [productOptions, setProductOptions] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [editingId, setEditingId] = useState("");
  const [docsOpen, setDocsOpen] = useState("");
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const loadSuppliers = async () => {
    setIsLoading(true);
    try {
      const data = await listSuppliersRequest(filters);
      setResult(data);
    } catch (error) {
      setServerError(error.response?.data?.message || "Unable to load suppliers");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSuppliers();
  }, [filters.page, filters.limit, filters.search, filters.sortBy, filters.sortOrder, filters.paymentStatus]);

  useEffect(() => {
    const loadProducts = async () => {
      try {
        const data = await listProductsRequest({ page: 1, limit: 100, sortBy: "name", sortOrder: "asc" });
        setProductOptions(data.items);
      } catch (_error) {}
    };

    loadProducts();
  }, []);

  const handleFilterChange = (event) => {
    const { name, value } = event.target;
    setFilters((current) => ({ ...current, page: 1, [name]: value }));
  };

  const handleFormChange = (event) => {
    const { name, value, options } = event.target;

    if (name === "productsSupplied") {
      const selectedValues = Array.from(options)
        .filter((option) => option.selected)
        .map((option) => option.value);
      setForm((current) => ({ ...current, productsSupplied: selectedValues }));
      return;
    }

    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleEdit = (supplier) => {
    setEditingId(supplier._id);
    setForm({
      supplierName: supplier.supplierName || "",
      phone: supplier.phone || "",
      email: supplier.email || "",
      address: supplier.address || "",
      gstNumber: supplier.gstNumber || "",
      pan: supplier.pan || "",
      tdsKind: supplier.tdsKind || "",
      tdsRate: supplier.tdsRate ?? "",
      msmeType: supplier.msmeType || "",
      udyamNumber: supplier.udyamNumber || "",
      msmeTrader: supplier.msmeTrader ? "true" : "false",
      msmeCreditDays: supplier.msmeCreditDays || "",
      productsSupplied: (supplier.productsSupplied || []).map((item) => item._id || item),
      notes: supplier.notes || "",
      paymentStatus: supplier.paymentStatus || "unpaid",
    });
  };

  const resetForm = () => {
    setEditingId("");
    setForm(initialForm);
    setErrors({});
    setServerError("");
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsSaving(true);
    setErrors({});
    setServerError("");

    try {
      if (editingId) {
        await updateSupplierRequest(editingId, form);
      } else {
        await createSupplierRequest(form);
      }

      resetForm();
      await loadSuppliers();
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setServerError(error.response?.data?.message || "Unable to save supplier");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (supplierId) => {
    try {
      await deleteSupplierRequest(supplierId);
      await loadSuppliers();
    } catch (error) {
      setServerError(error.response?.data?.message || "Unable to delete supplier");
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-white/10 bg-white/5 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-brand-300">Suppliers</p>
            <h2 className="mt-3 text-3xl font-semibold text-white">Supplier management</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <input name="search" value={filters.search} onChange={handleFilterChange} placeholder="Search supplier, email, GST" className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
            <select name="paymentStatus" value={filters.paymentStatus} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="">All payment status</option>
              <option value="paid">Paid</option>
              <option value="partial">Partial</option>
              <option value="unpaid">Unpaid</option>
            </select>
            <select name="sortBy" value={filters.sortBy} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="createdAt">Created</option>
              <option value="supplierName">Name</option>
              <option value="paymentStatus">Payment status</option>
            </select>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <form onSubmit={handleSubmit} className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <h3 className="text-xl font-semibold text-white">{editingId ? "Edit supplier" : "Add supplier"}</h3>
          <div className="mt-5 grid gap-4">
            {[
              ["supplierName", "Supplier name"],
              ["phone", "Phone"],
              ["email", "Email"],
              ["address", "Address"],
              ["gstNumber", "GST number"],
              ["pan", "PAN (needed for TDS; without it TDS is 20%)"],
            ].map(([name, label]) => (
              <label key={name} className="block">
                <span className="mb-2 block text-sm text-slate-300">{label}</span>
                <input name={name} value={form[name]} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
                {errors[name] ? <span className="mt-2 block text-xs text-rose-400">{errors[name]}</span> : null}
              </label>
            ))}
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">TDS we deduct when paying them</span>
              <select name="tdsKind" value={form.tdsKind} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                <option value="">No TDS</option>
                {TDS_KINDS.map((kind) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
              </select>
            </label>
            {form.tdsKind ? (
              <label className="block">
                <span className="mb-2 block text-sm text-slate-300">Their TDS rate % (blank = usual; set only for a lower-deduction certificate)</span>
                <input name="tdsRate" type="number" min="0" max="100" step="0.01" value={form.tdsRate} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
              </label>
            ) : null}
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">MSME (Udyam) status</span>
              <select name="msmeType" value={form.msmeType} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                <option value="">Not MSME / not known</option>
                <option value="MICRO">Micro</option>
                <option value="SMALL">Small</option>
                <option value="MEDIUM">Medium</option>
              </select>
            </label>
            {form.msmeType ? (
              <>
                <label className="block">
                  <span className="mb-2 block text-sm text-slate-300">Udyam registration number</span>
                  <input name="udyamNumber" value={form.udyamNumber} onChange={handleFormChange} placeholder="UDYAM-MP-00-0000000" className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm text-slate-300">Credit days agreed in writing (max 45; blank = 15 days)</span>
                  <input name="msmeCreditDays" type="number" min="0" max="45" value={form.msmeCreditDays} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
                </label>
                <label className="block">
                  <span className="mb-2 block text-sm text-slate-300">Registered as a trader (wholesale / retail)?</span>
                  <select name="msmeTrader" value={form.msmeTrader} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                    <option value="false">No: the 45-day rule applies</option>
                    <option value="true">Yes: trader, outside s.43B(h)</option>
                  </select>
                </label>
              </>
            ) : null}
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Products supplied</span>
              <select name="productsSupplied" multiple value={form.productsSupplied} onChange={handleFormChange} className="min-h-32 w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                {productOptions.map((product) => (
                  <option key={product._id} value={product._id}>
                    {product.name} {product.sku ? `(${product.sku})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Payment status</span>
              <select name="paymentStatus" value={form.paymentStatus} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                <option value="unpaid">Unpaid</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Notes</span>
              <textarea name="notes" rows="4" value={form.notes} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
            </label>
          </div>
          {serverError ? <p className="mt-4 text-sm text-rose-400">{serverError}</p> : null}
          <div className="mt-5 flex gap-3">
            <button type="submit" disabled={isSaving} className="rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white">
              {isSaving ? "Saving..." : editingId ? "Update supplier" : "Create supplier"}
            </button>
            {editingId ? (
              <button type="button" onClick={resetForm} className="rounded-2xl border border-white/10 px-5 py-3 text-sm text-slate-200">
                Cancel
              </button>
            ) : null}
          </div>
        </form>

        <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-xl font-semibold text-white">Supplier list</h3>
            <p className="text-sm text-slate-400">{result.pagination.total} total</p>
          </div>
          {isLoading ? (
            <p className="text-sm text-slate-400">Loading suppliers...</p>
          ) : (
            <div className="space-y-3">
              {result.items.map((supplier) => (
                <div key={supplier._id} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:justify-between">
                    <div>
                      <p className="text-lg font-semibold text-white">{supplier.supplierName}</p>
                      <div className="mt-2 grid gap-1 text-sm text-slate-300">
                        <p>{supplier.email || "No email"}</p>
                        <p>{supplier.phone || "No phone"}</p>
                        <p>Payment: {supplier.paymentStatus}</p>
                        <p>Products: {(supplier.productsSupplied || []).length}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => setDocsOpen(docsOpen === supplier._id ? "" : supplier._id)} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200">Documents{supplier.attachments?.length ? ` (${supplier.attachments.length})` : ""}</button>
                      <button onClick={() => handleEdit(supplier)} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200">Edit</button>
                      <button onClick={() => handleDelete(supplier._id)} className="rounded-xl border border-rose-500/40 px-4 py-2 text-sm text-rose-300">Delete</button>
                    </div>
                  </div>
                  {docsOpen === supplier._id ? <DocumentsPanel recordType="supplier" recordId={supplier._id} documents={supplier.attachments || []} defaultKind="AGREEMENT" kinds={["AGREEMENT", "CERTIFICATE", "OTHER"]} /> : null}
                </div>
              ))}
              {!result.items.length ? <p className="text-sm text-slate-400">No suppliers found.</p> : null}
            </div>
          )}
          <div className="mt-5 flex items-center justify-between">
            <button type="button" disabled={filters.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200 disabled:opacity-40">Previous</button>
            <p className="text-sm text-slate-400">Page {result.pagination.page} of {result.pagination.totalPages}</p>
            <button type="button" disabled={filters.page >= result.pagination.totalPages} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200 disabled:opacity-40">Next</button>
          </div>
        </div>
      </section>
    </div>
  );
};

export default SuppliersPage;

