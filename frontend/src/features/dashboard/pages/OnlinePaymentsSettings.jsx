import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { uiStore } from "../../../store/uiStore";
import api from "../../../api/axios";
import { decideOnlinePaymentSettlementRequest, onlinePaymentSettingsRequest, onlinePaymentSettlementsRequest, saveOnlinePaymentSettingsRequest } from "../../auth/api";

const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS = { POSTED: "In the books", NEEDS_REVIEW: "Needs review", RECORDED_BY_HAND: "Recorded by hand" };

/**
 * Razorpay settlements. One is posted to the bank by itself only when every payment and refund in it
 * is already in BillStack; otherwise it waits here with the lines BillStack doesn't know.
 */
function Settlements() {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setRows(await onlinePaymentSettlementsRequest());
    } catch {
      setRows(null);
    }
  };
  useEffect(() => {
    load();
  }, []);
  if (!rows?.length) return null;
  const decide = async (row, action) => {
    if (action === "post" && !window.confirm(`Post ${money(row.amount)} to the bank from Razorpay - Settlements Due? Record the lines BillStack doesn't know first (e.g. as receipts by Razorpay).`)) return;
    setBusy(row.id);
    setError("");
    try {
      await decideOnlinePaymentSettlementRequest(row.id, action);
      uiStore.getState().pushToast({ tone: "success", message: action === "post" ? "Settlement posted to the bank." : "Marked as recorded by hand." });
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || "That did not work.");
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--panel-border)" }}>
      <p className="text-sm font-semibold">Settlements to the bank</p>
      <p className="mt-1 text-xs opacity-70">Posted by themselves when every payment and refund in them is already in BillStack. Anything else waits here.</p>
      {error ? <p role="alert" className="mt-2 text-sm text-rose-600">{error}</p> : null}
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.id} className={`rounded-xl p-3 text-xs ${row.status === "NEEDS_REVIEW" ? "bg-amber-500/10" : "bg-slate-500/[.06]"}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{money(row.amount)} on {row.settledAt ? new Date(row.settledAt).toLocaleDateString("en-IN") : "-"} · UTR {row.utr || "-"}</span>
              <span className="rounded-full bg-slate-500/10 px-2 py-0.5">{STATUS[row.status] || row.status}</span>
            </div>
            {row.status === "NEEDS_REVIEW" ? (
              <>
                <p className="mt-1">Why: {row.reason}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={busy === row.id} onClick={() => decide(row, "post")} className="rounded-lg bg-brand-600 px-3 py-1.5 font-semibold text-white disabled:opacity-60">Post to the bank</button>
                  <button type="button" disabled={busy === row.id} onClick={() => decide(row, "by_hand")} className="rounded-lg border px-3 py-1.5 disabled:opacity-60" style={{ borderColor: "var(--panel-border)" }}>I recorded it myself</button>
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Settings > Invoice & Payment: this business's own Razorpay account, so customers can pay an
 * invoice online through a payment link and the payment is recorded by itself. Secrets are typed
 * here by the owner, stored encrypted, and never shown again.
 */
export default function OnlinePaymentsSettings({ canEdit }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ keyId: "", keySecret: "", webhookSecret: "", linkExpiryDays: 30, enabled: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const data = await onlinePaymentSettingsRequest();
      setSettings(data);
      setForm({ keyId: data.keyId || "", keySecret: "", webhookSecret: "", linkExpiryDays: data.linkExpiryDays ?? 30, enabled: data.enabled });
    } catch (err) {
      setError(err?.response?.data?.message || "Could not load online payment settings.");
    }
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (enabled) => {
    setBusy(true);
    setError("");
    try {
      const data = await saveOnlinePaymentSettingsRequest({ ...form, enabled, linkExpiryDays: Number(form.linkExpiryDays) });
      setSettings(data);
      setForm((v) => ({ ...v, keySecret: "", webhookSecret: "", enabled: data.enabled }));
      uiStore.getState().pushToast({ tone: "success", message: data.enabled ? "Online payments are on." : "Saved." });
    } catch (err) {
      setError(err?.response?.data?.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return error ? <p className="mt-4 text-sm text-rose-600">{error}</p> : null;
  // The API's own address (it can differ from this page's): webhookPath starts with /api.
  const apiBase = new URL(api.defaults.baseURL, window.location.origin);
  const webhookUrl = `${apiBase.origin}${apiBase.pathname.replace(/\/api\/?$/, "")}${settings.webhookPath}`;
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      uiStore.getState().pushToast({ tone: "success", message: "Copied." });
    } catch {
      window.prompt("Copy:", text);
    }
  };
  const field = "w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm";

  return (
    <section className="mt-6 rounded-2xl border p-5" style={{ borderColor: "var(--panel-border)" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Online payments (Razorpay)</p>
          <p className="mt-1 text-xs opacity-70">This company's own Razorpay account: customers pay an invoice through a link, the money goes to this company, and the payment is recorded against the invoice by itself.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${settings.enabled ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-slate-500/10"}`}>{settings.enabled ? "On" : "Off"}</span>
      </div>
      {!settings.canStoreSecrets ? <p className="mt-3 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">The server cannot store secrets yet: BILLSTACK_DATA_KEY must be set on the server first.</p> : null}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="min-w-0">
          <span className="mb-1 block text-sm font-medium">Key ID</span>
          <input value={form.keyId} disabled={!canEdit} onChange={(e) => setForm((v) => ({ ...v, keyId: e.target.value.trim() }))} placeholder="rzp_live_..." className={field} autoComplete="off" />
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-sm font-medium">Key secret {settings.keySecretSaved ? "(saved; type to replace)" : ""}</span>
          <input type="password" value={form.keySecret} disabled={!canEdit} onChange={(e) => setForm((v) => ({ ...v, keySecret: e.target.value }))} className={field} autoComplete="new-password" />
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-sm font-medium">Webhook secret {settings.webhookSecretSaved ? "(saved; type to replace)" : ""}</span>
          <input type="password" value={form.webhookSecret} disabled={!canEdit} onChange={(e) => setForm((v) => ({ ...v, webhookSecret: e.target.value }))} className={field} autoComplete="new-password" />
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-sm font-medium">Link stays open for (days, 0 = no end)</span>
          <input type="number" min={0} max={180} value={form.linkExpiryDays} disabled={!canEdit} onChange={(e) => setForm((v) => ({ ...v, linkExpiryDays: e.target.value }))} className={field} />
        </label>
      </div>
      <div className="mt-4 rounded-xl bg-slate-500/[.06] p-3 text-xs">
        <p className="font-medium">In Razorpay: Settings &gt; Webhooks &gt; Add new webhook</p>
        <p className="mt-1 break-all font-mono">{webhookUrl}</p>
        <button type="button" onClick={() => copy(webhookUrl)} className="mt-1 inline-flex items-center gap-1 underline"><Copy size={12} /> Copy the URL</button>
        <p className="mt-2">Same secret as above. Events: {settings.webhookEvents.join(", ")}.</p>
        <p className="mt-1 opacity-70">A paid link is recorded to "Razorpay - Settlements Due" (1030) with Razorpay's fee as a bank charge; each settlement moves the money to the bank with its UTR, so the bank statement line matches it. A refund shows on its invoice until it is recorded.</p>
      </div>
      <Settlements />
      {error ? <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p> : null}
      {canEdit ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => save(true)} className="rounded-xl bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? "Checking with Razorpay..." : settings.enabled ? "Save" : "Check keys and switch on"}</button>
          {settings.enabled ? <button type="button" disabled={busy} onClick={() => save(false)} className="rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: "var(--panel-border)" }}>Switch off</button> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs opacity-70">Only the owner or an admin can change these.</p>
      )}
    </section>
  );
}
