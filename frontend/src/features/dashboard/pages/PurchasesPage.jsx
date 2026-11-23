import { useEffect, useState } from "react";
import {
  createPurchaseRequest,
  listProductsRequest,
  listPurchasesRequest,
  listSuppliersRequest,
} from "../../auth/api";
import CentreInput, { forgetCentres } from "../../../components/ui/CentreInput";
import ReportTagFields from "../../../components/ui/ReportTagFields";
import DocumentsPanel from "../../../components/ui/DocumentsPanel";

const initialItem = {
  productId: "",
  quantity: 1,
  purchasePrice: 0,
  tax: 0,
  discount: 0,
};

const PurchasesPage = () => {
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [result, setResult] = useState({ items: [], pagination: { page: 1, totalPages: 1, total: 0 } });
  const [filters, setFilters] = useState({
    page: 1,
    limit: 10,
    supplierId: "",
    paymentStatus: "",
    sortBy: "purchaseDate",
    sortOrder: "desc",
  });
  const [form, setForm] = useState({
    supplierId: "",
    paidAmount: 0,
    paymentStatus: "unpaid",
    purchaseDate: new Date().toISOString().slice(0, 10),
    centre: "",
    businessLine: "",
    reportCategory: "",
    supplierInvoiceNumber: "",
    supplierInvoiceDate: "",
    itcEligible: true,
    productsPurchased: [initialItem],
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [docsOpen, setDocsOpen] = useState("");

  const loadPurchases = async () => {
    setIsLoading(true);
    try {
      const data = await listPurchasesRequest(filters);
      setResult(data);
    } catch (error) {
      setServerError(error.response?.data?.message || "Unable to load purchases");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadPurchases();
  }, [filters.page, filters.limit, filters.supplierId, filters.paymentStatus, filters.sortBy, filters.sortOrder]);

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const [supplierData, productData] = await Promise.all([
          listSuppliersRequest({ page: 1, limit: 100, sortBy: "supplierName", sortOrder: "asc" }),
          listProductsRequest({ page: 1, limit: 100, sortBy: "name", sortOrder: "asc" }),
        ]);
        setSuppliers(supplierData.items);
        setProducts(productData.items);
      } catch (_error) {}
    };

    loadOptions();
  }, []);

  const handleFilterChange = (event) => {
    const { name, value } = event.target;
    setFilters((current) => ({ ...current, page: 1, [name]: value }));
  };

  const handleFormChange = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleItemChange = (index, field, value) => {
    setForm((current) => ({
      ...current,
      productsPurchased: current.productsPurchased.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item
      ),
    }));
  };

  const addItem = () => {
    setForm((current) => ({
      ...current,
      productsPurchased: [...current.productsPurchased, initialItem],
    }));
  };

  const removeItem = (index) => {
    setForm((current) => ({
      ...current,
      productsPurchased: current.productsPurchased.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const resetForm = () => {
    setForm({
      supplierId: "",
      paidAmount: 0,
      paymentStatus: "unpaid",
      purchaseDate: new Date().toISOString().slice(0, 10),
      centre: "",
    businessLine: "",
    reportCategory: "",
      supplierInvoiceNumber: "",
      supplierInvoiceDate: "",
      itcEligible: true,
      productsPurchased: [initialItem],
    });
    setErrors({});
    setServerError("");
  };

  const totalAmount = form.productsPurchased.reduce((sum, item) => {
    const quantity = Number(item.quantity || 0);
    const purchasePrice = Number(item.purchasePrice || 0);
    const tax = Number(item.tax || 0);
    const discount = Number(item.discount || 0);
    return sum + quantity * purchasePrice + tax - discount;
  }, 0);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsSaving(true);
    setErrors({});
    setServerError("");

    try {
      await createPurchaseRequest(form);
      if (form.centre) forgetCentres();
      resetForm();
      await loadPurchases();
    } catch (error) {
      setErrors(error.response?.data?.errors || {});
      setServerError(error.response?.data?.message || "Unable to create purchase");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-white/10 bg-white/5 p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-brand-300">Purchases</p>
            <h2 className="mt-3 text-3xl font-semibold text-white">Supplier purchases and stock-in</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <select name="supplierId" value={filters.supplierId} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="">All suppliers</option>
              {suppliers.map((supplier) => (
                <option key={supplier._id} value={supplier._id}>{supplier.supplierName}</option>
              ))}
            </select>
            <select name="paymentStatus" value={filters.paymentStatus} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="">All payment status</option>
              <option value="paid">Paid</option>
              <option value="partial">Partial</option>
              <option value="unpaid">Unpaid</option>
            </select>
            <select name="sortOrder" value={filters.sortOrder} onChange={handleFilterChange} className="rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </select>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <form onSubmit={handleSubmit} className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <h3 className="text-xl font-semibold text-white">Create purchase</h3>
          <div className="mt-5 grid gap-4">
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Supplier</span>
              <select name="supplierId" value={form.supplierId} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                <option value="">Select supplier</option>
                {suppliers.map((supplier) => (
                  <option key={supplier._id} value={supplier._id}>{supplier.supplierName}</option>
                ))}
              </select>
              {errors.supplierId ? <span className="mt-2 block text-xs text-rose-400">{errors.supplierId}</span> : null}
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Purchase date</span>
              <input type="date" name="purchaseDate" value={form.purchaseDate} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Supplier's bill number (for GSTR-2B matching)</span>
              <input name="supplierInvoiceNumber" value={form.supplierInvoiceNumber} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Supplier's bill date</span>
              <input type="date" name="supplierInvoiceDate" value={form.supplierInvoiceDate} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.itcEligible !== false} onChange={(event) => setForm((current) => ({ ...current, itcEligible: event.target.checked }))} />
              Claim input credit on this bill (untick for blocked credit, s.17(5))
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Centre / property (optional)</span>
              <CentreInput value={form.centre} onChange={(value) => setForm((current) => ({ ...current, centre: value }))} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
            </label>
            <ReportTagFields
              value={form}
              onChange={(field, value) => setForm((current) => ({ ...current, [field]: value }))}
              className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white"
              labelClassName="mb-2 block text-sm text-slate-300"
            />
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Paid amount</span>
              <input name="paidAmount" value={form.paidAmount} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
              {errors.paidAmount ? <span className="mt-2 block text-xs text-rose-400">{errors.paidAmount}</span> : null}
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-slate-300">Payment status</span>
              <select name="paymentStatus" value={form.paymentStatus} onChange={handleFormChange} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                <option value="unpaid">Unpaid</option>
                <option value="partial">Partial</option>
                <option value="paid">Paid</option>
              </select>
            </label>

            <div className="space-y-4">
              {form.productsPurchased.map((item, index) => (
                <div key={`${index}-${item.productId}`} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="block md:col-span-2">
                      <span className="mb-2 block text-sm text-slate-300">Product</span>
                      <select value={item.productId} onChange={(event) => handleItemChange(index, "productId", event.target.value)} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white">
                        <option value="">Select product</option>
                        {products.map((product) => (
                          <option key={product._id} value={product._id}>{product.name}</option>
                        ))}
                      </select>
                      {errors[`productsPurchased.${index}.productId`] ? <span className="mt-2 block text-xs text-rose-400">{errors[`productsPurchased.${index}.productId`]}</span> : null}
                    </label>
                    {[
                      ["quantity", "Quantity"],
                      ["purchasePrice", "Purchase price"],
                      ["tax", "Tax"],
                      ["discount", "Discount"],
                    ].map(([field, label]) => (
                      <label key={field} className="block">
                        <span className="mb-2 block text-sm text-slate-300">{label}</span>
                        <input value={item[field]} onChange={(event) => handleItemChange(index, field, event.target.value)} className="w-full rounded-2xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white" />
                        {errors[`productsPurchased.${index}.${field}`] ? <span className="mt-2 block text-xs text-rose-400">{errors[`productsPurchased.${index}.${field}`]}</span> : null}
                      </label>
                    ))}
                  </div>
                  {form.productsPurchased.length > 1 ? (
                    <button type="button" onClick={() => removeItem(index)} className="mt-3 rounded-xl border border-rose-500/40 px-4 py-2 text-sm text-rose-300">
                      Remove line
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            <button type="button" onClick={addItem} className="rounded-2xl border border-white/10 px-5 py-3 text-sm text-slate-200">
              Add product line
            </button>

            <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4 text-sm text-slate-300">
              <p>Total amount: <span className="font-semibold text-white">{totalAmount.toFixed(2)}</span></p>
            </div>
          </div>
          {errors.productsPurchased ? <p className="mt-4 text-sm text-rose-400">{errors.productsPurchased}</p> : null}
          {serverError ? <p className="mt-4 text-sm text-rose-400">{serverError}</p> : null}
          <div className="mt-5 flex gap-3">
            <button type="submit" disabled={isSaving} className="rounded-2xl bg-brand-600 px-5 py-3 text-sm font-semibold text-white">
              {isSaving ? "Creating..." : "Create purchase"}
            </button>
          </div>
        </form>

        <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-xl font-semibold text-white">Purchase history</h3>
            <p className="text-sm text-slate-400">{result.pagination.total} total</p>
          </div>
          {isLoading ? (
            <p className="text-sm text-slate-400">Loading purchases...</p>
          ) : (
            <div className="space-y-3">
              {result.items.map((purchase) => (
                <div key={purchase._id} className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                  <p className="text-lg font-semibold text-white">{purchase.supplierId?.supplierName || "Supplier"}</p>
                  <div className="mt-2 grid gap-1 text-sm text-slate-300">
                    <p>Date: {new Date(purchase.purchaseDate).toLocaleDateString()}</p>
                    <p>Total: {purchase.totalAmount}</p>
                    <p>Paid: {purchase.paidAmount}</p>
                    <p>Status: {purchase.paymentStatus}</p>
                    <p>Lines: {(purchase.productsPurchased || []).length}</p>
                  </div>
                  <button type="button" onClick={() => setDocsOpen(docsOpen === purchase._id ? "" : purchase._id)} className="mt-3 rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-200">Documents{purchase.attachments?.length ? ` (${purchase.attachments.length})` : ""}</button>
                  {docsOpen === purchase._id ? <DocumentsPanel recordType="purchase" recordId={purchase._id} documents={purchase.attachments || []} /> : null}
                </div>
              ))}
              {!result.items.length ? <p className="text-sm text-slate-400">No purchases found.</p> : null}
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

export default PurchasesPage;

