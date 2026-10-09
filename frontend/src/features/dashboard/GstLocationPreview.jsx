import { useEffect, useState } from "react";
import { authStore } from "../../store/authStore";
import states from "../../../../shared/indian-gst-states.json";
import { previewInvoiceTaxRequest } from "../auth/api";

export default function GstLocationPreview({ form, setForm, customers, lineItems = form.lineItems }) {
  const { business } = authStore();
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const customer = customers.find(row => row._id === form.customerId);
  const pos = form.placeOfSupplyCode ?? customer?.placeOfSupplyCode ?? customer?.stateCode ?? "";
  const payloadKey = JSON.stringify({ customerId: form.customerId, placeOfSupplyCode: pos, lineItems, shippingCharges: form.shippingCharges, roundOff: form.roundOff });
  useEffect(() => {
    let active = true;
    setPreview(null); setError("");
    if (!business?.gstConfiguration?.enabled || !form.customerId || !lineItems?.length || lineItems.some(line => !line.productId && !line.productName)) return;
    const timer = setTimeout(() => previewInvoiceTaxRequest(JSON.parse(payloadKey)).then(data => { if (active) setPreview(data?.gstSnapshot); }).catch(err => { if (!active || err.response?.status === 404) return; setError(err.response?.data?.message || "GST preview unavailable"); }), 350);
    return () => { active = false; clearTimeout(timer); };
  }, [payloadKey, business?.gstConfiguration?.enabled]);
  if (!business?.gstConfiguration?.enabled) return null;
  const money = value => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(value || 0);
  return <div className="space-y-2"><label className="form-field"><span className="form-label">Place of supply</span><select value={pos} onChange={event => setForm(current => ({ ...current, placeOfSupplyCode: event.target.value }))} className="field"><option value="">Select state</option>{Object.entries(states).map(([code, state]) => <option key={code} value={code}>{state} ({code})</option>)}</select></label>{preview && <p className="text-xs" style={{ color: "var(--text-muted)" }}>{preview.supplierStateCode === preview.placeOfSupplyCode ? "Intra-state" : "Inter-state"} · CGST {money(preview.cgst)} · SGST {money(preview.sgst)} · IGST {money(preview.igst)}</p>}{error && <p role="status" className="text-xs text-rose-600">{error}</p>}</div>;
}
