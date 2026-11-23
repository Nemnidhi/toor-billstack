import { useEffect, useState } from "react";
import { Copy, ExternalLink, Link2, MessageCircle, RotateCcw } from "lucide-react";
import { uiStore } from "../../../store/uiStore";
import {
  cancelInvoicePaymentLinkRequest,
  communicationSettingsRequest,
  invoicePaymentLinksRequest,
  makeInvoicePaymentLinkRequest,
  recordInvoicePaymentLinkRequest,
  recordInvoiceRefundRequest,
  sendInvoiceCommunicationRequest,
} from "../../auth/api";

const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const errorText = (err, fallback) => err?.response?.data?.message || fallback;
const sameAmount = (a, b) => Math.round(Number(a || 0) * 100) === Math.round(Number(b || 0) * 100);

/**
 * The invoice's payment link (Razorpay, the business's own account) and its WhatsApp messages (sent
 * from the company's WhatsApp app). Loads on its own so it shows in every workspace.
 */
export default function InvoicePayOnline({ invoice, canManage, noun = "customer", onChanged }) {
  const [links, setLinks] = useState(null);
  const [whatsapp, setWhatsapp] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setLinks(await invoicePaymentLinksRequest(invoice._id));
    } catch {
      setLinks(null);
    }
    try {
      setWhatsapp((await communicationSettingsRequest())?.whatsapp || null);
    } catch {
      setWhatsapp(null);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice._id, invoice.balanceDue]);

  const run = async (name, fn, success) => {
    setBusy(name);
    setError("");
    try {
      const result = await fn();
      if (success) uiStore.getState().pushToast({ tone: "success", message: typeof success === "function" ? success(result) : success });
      await load();
      if (onChanged) await onChanged();
    } catch (err) {
      setError(errorText(err, "That did not work."));
    } finally {
      setBusy("");
    }
  };

  const open = links?.open;
  const waiting = links?.history?.find((row) => row.status === "PAID_NOT_RECORDED");
  const paid = links?.history?.find((row) => row.status === "PAID");
  const due = Number(invoice.balanceDue || 0);
  const issued = invoice.status === "issued";
  const viaApp = Boolean(whatsapp?.whatsappApp && whatsapp?.configured);
  // Refunds made in Razorpay that are not in the books yet.
  const refunds = (links?.history || []).flatMap((row) => (row.refunds || []).filter((r) => r.status === "NOT_RECORDED").map((r) => ({ ...r, link: row })));
  if (!links?.enabled && !viaApp && !waiting && !refunds.length) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(open.url);
      uiStore.getState().pushToast({ tone: "success", message: "Payment link copied." });
    } catch {
      window.prompt("Copy the payment link:", open.url);
    }
  };
  const sendWhatsApp = (category, label) =>
    run(
      `wa-${category}`,
      () => sendInvoiceCommunicationRequest(invoice._id, { channel: "WHATSAPP", category }),
      (row) => (["SKIPPED", "FAILED"].includes(row?.status) ? `${label} not sent: ${row.failureReason || row.status}` : `${label} sent on WhatsApp.`),
    );
  const button = "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium disabled:opacity-60";

  return (
    <section className="rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
      <p className="text-sm font-medium text-brand-600">Get paid</p>
      <h3 className="mt-1 text-lg font-semibold">Pay online & WhatsApp</h3>
      {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-200">{error}</p> : null}

      {waiting ? (
        <div className="mt-3 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          <p>Paid online {money(waiting.paidAmount)} ({waiting.providerPaymentId}) but not recorded: {waiting.recordError || "unknown reason"}.</p>
          {canManage ? (
            <button type="button" disabled={busy === "record"} onClick={() => run("record", () => recordInvoicePaymentLinkRequest(invoice._id), "Payment recorded.")} className={`${button} mt-2`} style={{ borderColor: "var(--panel-border)" }}>
              <RotateCcw size={14} /> {busy === "record" ? "Recording..." : "Record it now"}
            </button>
          ) : null}
        </div>
      ) : null}

      {refunds.map((refund) => (
        <div key={refund.refundId} className="mt-3 rounded-xl bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          <p>
            Refunded {money(refund.amount)} through Razorpay on {refund.refundedAt ? new Date(refund.refundedAt).toLocaleDateString("en-IN") : "-"} ({refund.refundId}): not in the books yet.
            {refund.link.fullRefund ? " Reversing the payment makes the invoice due again." : " A part refund: record it with a credit note and a refund payment, then mark it done."}
          </p>
          {canManage ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {refund.link.fullRefund ? (
                <button type="button" disabled={Boolean(busy)} onClick={() => run(`refund-${refund.refundId}`, () => recordInvoiceRefundRequest(invoice._id, refund.refundId, "reverse"), "Payment reversed for the refund.")} className={button} style={{ borderColor: "var(--panel-border)" }}>
                  <RotateCcw size={14} /> Reverse the payment
                </button>
              ) : null}
              <button type="button" disabled={Boolean(busy)} onClick={() => run(`refund-${refund.refundId}`, () => recordInvoiceRefundRequest(invoice._id, refund.refundId, "done"), "Refund marked as recorded.")} className={button} style={{ borderColor: "var(--panel-border)" }}>
                I recorded it myself
              </button>
            </div>
          ) : null}
        </div>
      ))}

      {links?.enabled ? (
        <div className="mt-3 space-y-2 text-sm">
          {open ? (
            <>
              <p style={{ color: "var(--text-muted)" }}>
                Payment link for {money(open.amount)}
                {!sameAmount(open.amount, due) ? " (the amount due has changed: make a new one)" : ""}
              </p>
              <p className="break-all font-mono text-xs">{open.url}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={copy} className={button} style={{ borderColor: "var(--panel-border)" }}>
                  <Copy size={14} /> Copy
                </button>
                <a href={open.url} target="_blank" rel="noreferrer" className={button} style={{ borderColor: "var(--panel-border)" }}>
                  <ExternalLink size={14} /> Open
                </a>
                {canManage ? (
                  <button type="button" disabled={busy === "cancel"} onClick={() => run("cancel", () => cancelInvoicePaymentLinkRequest(invoice._id), "Payment link cancelled.")} className={button} style={{ borderColor: "var(--panel-border)" }}>
                    Cancel link
                  </button>
                ) : null}
              </div>
            </>
          ) : paid && due <= 0 ? (
            <p className="text-emerald-700 dark:text-emerald-300">
              Paid online {money(paid.paidAmount)} on {paid.paidAt ? new Date(paid.paidAt).toLocaleDateString("en-IN") : "-"} ({paid.providerPaymentId}).
            </p>
          ) : due > 0 && issued ? (
            <p style={{ color: "var(--text-muted)" }}>No payment link yet. One is made when the invoice goes out on WhatsApp or email.</p>
          ) : null}
          {due > 0 && issued && (!open || !sameAmount(open.amount, due)) ? (
            <button type="button" disabled={busy === "make"} onClick={() => run("make", () => makeInvoicePaymentLinkRequest(invoice._id), "Payment link ready.")} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">
              <Link2 size={14} /> {busy === "make" ? "Making..." : `Make a link for ${money(due)}`}
            </button>
          ) : null}
        </div>
      ) : null}

      {viaApp && issued ? (
        <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Goes from the company's WhatsApp number, only to a {noun} who agreed to WhatsApp messages (the tick on the {noun}).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={Boolean(busy)} onClick={() => sendWhatsApp("INVOICE_CREATED", "Invoice")} className={button} style={{ borderColor: "var(--panel-border)" }}>
              <MessageCircle size={14} /> {busy === "wa-INVOICE_CREATED" ? "Sending..." : "Send invoice"}
            </button>
            {due > 0 ? (
              <button type="button" disabled={Boolean(busy)} onClick={() => sendWhatsApp("PAYMENT_REMINDER", "Reminder")} className={button} style={{ borderColor: "var(--panel-border)" }}>
                <MessageCircle size={14} /> {busy === "wa-PAYMENT_REMINDER" ? "Sending..." : "Send payment reminder"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
