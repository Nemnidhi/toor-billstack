import { useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Send, X } from "lucide-react";
import { amountInWords } from "./invoiceReview";

const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const dateText = (value) => (value ? new Date(`${String(value).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const muted = { color: "var(--text-muted)" };

// Read-only preview of the invoice exactly as it will be issued, plus the checks from reviewInvoice().
export default function InvoiceReviewModal({
  review, form, totals, customer, business, gstPreview, placeOfSupplyName, sending, editing, busy, onConfirm, onClose,
}) {
  const confirmRef = useRef(null);
  const blocked = review.blockers.length > 0;

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", onKey);
    confirmRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const intra = gstPreview ? gstPreview.supplierStateCode === gstPreview.placeOfSupplyCode : null;
  const paidNow = !editing && form.paymentMode === "full" ? totals.grand
    : !editing && form.paymentMode === "partial" ? Math.min(Math.max(Number(form.upfrontPaymentAmount || 0), 0), totals.grand) : 0;
  const goldhawk = business?.billingEntityCode === "GOLDHAWK";
  const verb = editing ? "Update invoice" : sending ? "Confirm, issue & send" : "Confirm & issue";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 p-3 sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="invoice-review-title" className="my-2 w-full max-w-3xl rounded-2xl border shadow-2xl" style={{ borderColor: "var(--panel-border)", background: "var(--theme-surface-strong)" }}>
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--panel-border)" }}>
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-300"><FileText size={14} /> Invoice preview</p>
            <h3 id="invoice-review-title" className="mt-1 text-lg font-semibold">{editing ? "Review before updating" : "Review before issuing"}</h3>
            <p className="mt-0.5 text-xs" style={muted}>Nothing has been created yet. Check the details below, then confirm.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close preview" className="rounded-lg p-2 hover:bg-slate-500/10 disabled:opacity-40"><X size={18} /></button>
        </div>

        {blocked ? (
          <div role="alert" className="mx-5 mt-4 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3.5 text-sm">
            <p className="flex items-center gap-2 font-semibold text-rose-700 dark:text-rose-300"><AlertTriangle size={16} /> Fix these before issuing</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs" style={muted}>{review.blockers.map((message) => <li key={message}>{message}</li>)}</ul>
          </div>
        ) : null}
        {review.warnings.length ? (
          <div role="status" className="mx-5 mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5 text-sm">
            <p className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300"><AlertTriangle size={16} /> Please double-check</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs" style={muted}>{review.warnings.map((message) => <li key={message}>{message}</li>)}</ul>
          </div>
        ) : !blocked ? (
          <p className="mx-5 mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3.5 py-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={15} /> All checks passed.</p>
        ) : null}

        <div className="m-5 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--panel-border)" }}>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-3" style={{ borderColor: "var(--panel-border)" }}>
            <div>
              <p className="text-base font-bold">{business?.name || "Your business"}</p>
              {goldhawk ? <p className="text-xs" style={muted}>Non-GST / exempt services</p> : null}
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-xs">
              <dt style={muted}>Invoice no.</dt><dd className="text-right font-semibold">Assigned when issued</dd>
              <dt style={muted}>Issue date</dt><dd className="text-right font-semibold">{dateText(form.invoiceDate)}</dd>
              <dt style={muted}>Due date</dt><dd className="text-right font-semibold">{dateText(form.dueDate)}</dd>
            </dl>
          </div>

          <div className="grid gap-4 border-b py-3 sm:grid-cols-2" style={{ borderColor: "var(--panel-border)" }}>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={muted}>Bill to</p>
              <p className="mt-1 font-semibold">{customer?.name || "—"}</p>
              <p className="text-xs" style={muted}>GSTIN: {customer?.gstNumber || "—"}</p>
              {customer?.phone ? <p className="text-xs" style={muted}>Mobile: {customer.phone}</p> : null}
              {customer?.email ? <p className="text-xs" style={muted}>Email: {customer.email}</p> : null}
              {customer?.billingAddress ? <p className="text-xs" style={muted}>{customer.billingAddress}</p> : null}
            </div>
            {!goldhawk ? (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide" style={muted}>Place of supply</p>
                <p className="mt-1 font-semibold">{placeOfSupplyName || "Not set"}</p>
                {intra != null ? <p className="text-xs" style={muted}>{intra ? "Intra-state: CGST + SGST" : "Inter-state: IGST"}</p> : null}
              </div>
            ) : null}
          </div>

          <div className="overflow-x-auto py-3">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr style={muted}>
                  <th className="pb-2 pr-2 font-semibold">#</th><th className="pb-2 pr-2 font-semibold">Item</th><th className="pb-2 pr-2 font-semibold">HSN/SAC</th>
                  <th className="pb-2 pr-2 text-right font-semibold">Qty</th><th className="pb-2 pr-2 text-right font-semibold">Rate</th>
                  <th className="pb-2 pr-2 text-right font-semibold">Disc.</th><th className="pb-2 pr-2 text-right font-semibold">GST</th><th className="pb-2 text-right font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {form.lineItems.map((item, index) => {
                  const row = totals.items[index] || {};
                  return (
                    <tr key={index} className="border-t align-top" style={{ borderColor: "var(--panel-border)" }}>
                      <td className="py-2 pr-2" style={muted}>{index + 1}</td>
                      <td className="py-2 pr-2 font-medium">{item.productName || (item.productId ? "Saved service" : "—")}</td>
                      <td className="py-2 pr-2" style={muted}>{item.hsnSac || "—"}</td>
                      <td className="py-2 pr-2 text-right">{item.quantity}</td>
                      <td className="py-2 pr-2 text-right">{money(item.rate)}</td>
                      <td className="py-2 pr-2 text-right" style={muted}>{Number(item.discountValue || 0) ? (item.discountType === "amount" ? money(item.discountValue) : `${item.discountValue}%`) : "—"}</td>
                      <td className="py-2 pr-2 text-right" style={muted}>{goldhawk ? "—" : `${Number(item.taxRate || 0)}%`}</td>
                      <td className="py-2 text-right font-semibold">{money(row.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="ml-auto max-w-xs space-y-1 border-t pt-3 text-xs" style={{ borderColor: "var(--panel-border)" }}>
            <div className="flex justify-between"><span style={muted}>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            {totals.discount ? <div className="flex justify-between"><span style={muted}>Discount</span><span>- {money(totals.discount)}</span></div> : null}
            {!goldhawk && gstPreview && intra ? (<>
              <div className="flex justify-between"><span style={muted}>CGST</span><span>{money(gstPreview.cgst)}</span></div>
              <div className="flex justify-between"><span style={muted}>SGST</span><span>{money(gstPreview.sgst)}</span></div>
            </>) : null}
            {!goldhawk && gstPreview && intra === false ? <div className="flex justify-between"><span style={muted}>IGST</span><span>{money(gstPreview.igst)}</span></div> : null}
            {!goldhawk && !gstPreview ? <div className="flex justify-between"><span style={muted}>GST (estimated)</span><span>{money(totals.tax)}</span></div> : null}
            {totals.shipping ? <div className="flex justify-between"><span style={muted}>Shipping</span><span>{money(totals.shipping)}</span></div> : null}
            {totals.roundOff ? <div className="flex justify-between"><span style={muted}>Round-off</span><span>{money(totals.roundOff)}</span></div> : null}
            <div className="flex items-end justify-between border-t pt-2 text-sm" style={{ borderColor: "var(--panel-border)" }}><span className="font-semibold">Grand total</span><strong className="text-lg">{money(totals.grand)}</strong></div>
            {paidNow > 0 ? <div className="flex justify-between"><span style={muted}>Paid now</span><span className="font-semibold text-emerald-600 dark:text-emerald-300">{money(paidNow)}</span></div> : null}
            <div className="flex justify-between"><span style={muted}>Balance due</span><span className="font-semibold text-amber-600 dark:text-amber-300">{money(Math.max(totals.grand - paidNow, 0))}</span></div>
          </div>
          <p className="mt-3 text-xs" style={muted}><span className="font-semibold">In words:</span> {amountInWords(totals.grand)}</p>
          {form.notes ? <p className="mt-2 whitespace-pre-line text-xs" style={muted}><span className="font-semibold">Notes:</span> {form.notes}</p> : null}
          {form.termsAndConditions ? <p className="mt-1 whitespace-pre-line text-xs" style={muted}><span className="font-semibold">Terms:</span> {form.termsAndConditions}</p> : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t px-5 py-4" style={{ borderColor: "var(--panel-border)" }}>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl border px-4 py-2.5 text-sm font-medium disabled:opacity-50" style={{ borderColor: "var(--panel-border)" }}>Back to edit</button>
          <button type="button" ref={confirmRef} onClick={onConfirm} disabled={busy || blocked} className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} {busy ? "Working…" : verb}
          </button>
        </div>
      </div>
    </div>
  );
}
