import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, RefreshCw, UploadCloud, XCircle } from "lucide-react";
import {
  cancelTdsChallanRequest,
  createTdsChallanRequest,
  downloadTdsForm140,
  getTdsChallansRequest,
  getTdsForm131Request,
  getTdsMetaRequest,
  getTdsPayableRequest,
  getTdsReceivableRequest,
  importTds26asRequest,
  updateTdsReceivableRequest,
} from "../api";
import { money } from "../../dashboard/reportPresentation";

const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const th = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500";
const td = "px-3 py-2 text-xs text-slate-700 dark:text-slate-300";
const input = "rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200";
const button = "flex items-center gap-1.5 rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50";
const ghost = "flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";

const day = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "-");
const errorText = (err) => err?.response?.data?.message || err?.message || "Something went wrong";

const MATCH_LABEL = {
  MATCHED: ["In 26AS", "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300"],
  MISSING_IN_26AS: ["Not in 26AS yet", "text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300"],
  SHORT_IN_26AS: ["Less in 26AS", "text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300"],
  MORE_IN_26AS: ["More in 26AS", "text-sky-700 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-300"],
  NOT_IN_BOOKS: ["Not in our books", "text-rose-700 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300"],
  NO_TAN: ["Customer TAN missing", "text-rose-700 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300"],
  NO_IMPORT: ["No 26AS imported", "text-slate-600 bg-slate-100 dark:bg-slate-800 dark:text-slate-300"],
};
const MatchBadge = ({ status }) => {
  if (!status) return null;
  const [label, tone] = MATCH_LABEL[status] || [status, "text-slate-600 bg-slate-100"];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>;
};

const fyOptions = (current) => {
  const start = Number(String(current || "2026-27").slice(0, 4));
  return [start, start - 1, start - 2].map((y) => `${y}-${String((y + 1) % 100).padStart(2, "0")}`);
};

// ------------------------------------------------------------------ TDS customers deducted

const ReceivablePanel = ({ params }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);

  const load = async () => {
    setError("");
    try {
      setData(await getTdsReceivableRequest(params));
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => { load(); }, [params.entity, params.fy]);

  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return setError("This file is larger than 5 MB.");
    const reader = new FileReader();
    const isText = /\.(csv|txt)$/i.test(file.name);
    reader.onload = async () => {
      setImporting(true);
      setError("");
      try {
        const payload = isText ? { csvText: reader.result, fileName: file.name } : { fileBase64: String(reader.result).split(",")[1], fileName: file.name };
        const result = await importTds26asRequest(payload, params);
        setNotice(`Imported ${result.rows} TDS line(s), ${money(result.totalTax)} in all.`);
        await load();
      } catch (err) {
        setError(errorText(err));
      } finally {
        setImporting(false);
      }
    };
    if (isText) reader.readAsText(file);
    else reader.readAsDataURL(file);
  };

  const saveCertificate = async () => {
    try {
      await updateTdsReceivableRequest(editing._id, { certificateNumber: editing.certificateNumber, certificateReceivedAt: editing.certificateReceivedAt || null, deductorTan: editing.deductorTan }, params);
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className={card}><p className="text-xs text-slate-500">TDS customers deducted ({params.fy})</p><p className="mt-1 text-xl font-bold">{money(data?.summary?.deducted || 0)}</p></div>
        <div className={card}><p className="text-xs text-slate-500">Certificates received</p><p className="mt-1 text-xl font-bold">{data?.summary?.certificatesReceived || 0}</p></div>
        <div className={card}><p className="text-xs text-slate-500">Certificates pending</p><p className="mt-1 text-xl font-bold">{data?.summary?.certificatesPending || 0}</p></div>
      </div>

      <div className={card}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold">Check against Form 26AS / AIS</h3>
            <p className="text-xs text-slate-500">Download the TDS part of 26AS or AIS from the income-tax portal (CSV, text or Excel) and import it. Each customer's TDS is matched by their TAN and quarter.</p>
          </div>
          <label className={`${button} cursor-pointer`}>
            <UploadCloud className="h-4 w-4" /> {importing ? "Importing..." : "Import 26AS / AIS"}
            <input type="file" accept=".csv,.txt,.xlsx,.xls" className="hidden" onChange={onFile} disabled={importing} />
          </label>
        </div>
        {notice && <p className="mb-2 text-xs text-emerald-700">{notice}</p>}
        {data?.match ? (
          <div className="overflow-x-auto">
            <p className="mb-2 text-xs text-slate-500">Last import: {data.match.fileName || "file"} on {day(data.match.importedAt)}. {data.match.totals.problems ? `${data.match.totals.problems} line(s) need a look.` : "Everything matches."}</p>
            <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
              <thead><tr><th className={th}>Quarter</th><th className={th}>Deductor</th><th className={th}>TAN</th><th className={`${th} text-right`}>In our books</th><th className={`${th} text-right`}>In 26AS</th><th className={`${th} text-right`}>Difference</th><th className={th}>Status</th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.match.rows.map((row) => (
                  <tr key={`${row.deductorTan}-${row.quarter}`}>
                    <td className={td}>{row.quarter}</td><td className={td}>{row.deductorName}</td><td className={td}>{row.deductorTan}</td>
                    <td className={`${td} text-right`}>{money(row.inBooks)}</td><td className={`${td} text-right`}>{money(row.in26as)}</td><td className={`${td} text-right`}>{money(row.difference)}</td>
                    <td className={td}><MatchBadge status={row.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-slate-500">No 26AS imported for {params.fy} yet.</p>
        )}
      </div>

      <div className={card}>
        <h3 className="mb-3 text-sm font-bold">TDS deducted by customers</h3>
        {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
        {!data?.rows?.length ? (
          <p className="text-xs text-slate-500">No receipts with TDS in {params.fy}. When a customer pays less because they deducted TDS, enter the TDS on the receipt.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
              <thead><tr><th className={th}>Date</th><th className={th}>Qtr</th><th className={th}>Customer</th><th className={th}>TAN</th><th className={th}>Section</th><th className={`${th} text-right`}>Settled</th><th className={`${th} text-right`}>TDS</th><th className={th}>26AS</th><th className={th}>Certificate</th><th className={th}></th></tr></thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.rows.map((row) => (
                  <tr key={row._id} className={row.status === "REVERSED" ? "opacity-50" : ""}>
                    <td className={td}>{day(row.deductedOn)}</td><td className={td}>{row.quarter}</td><td className={td}>{row.customerName}</td><td className={td}>{row.deductorTan || "-"}</td><td className={td}>{row.section}</td>
                    <td className={`${td} text-right`}>{money(row.grossAmount)}</td><td className={`${td} text-right font-semibold`}>{money(row.amount)}</td>
                    <td className={td}>{row.status === "REVERSED" ? "Reversed" : <MatchBadge status={row.in26as} />}</td>
                    <td className={td}>{row.certificateNumber ? `${row.certificateNumber} (${day(row.certificateReceivedAt)})` : "Pending"}</td>
                    <td className={td}>{row.status === "OPEN" && <button className={ghost} onClick={() => setEditing({ ...row, certificateReceivedAt: row.certificateReceivedAt ? String(row.certificateReceivedAt).slice(0, 10) : "" })}>Update</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 dark:bg-slate-900">
            <h3 className="text-sm font-bold">Form 131 / 16A from {editing.customerName}</h3>
            <label className="block text-xs">Customer TAN<input className={`${input} mt-1 w-full uppercase`} value={editing.deductorTan || ""} onChange={(e) => setEditing({ ...editing, deductorTan: e.target.value })} placeholder="e.g. BPLA12345B" /></label>
            <label className="block text-xs">Certificate number<input className={`${input} mt-1 w-full`} value={editing.certificateNumber || ""} onChange={(e) => setEditing({ ...editing, certificateNumber: e.target.value })} /></label>
            <label className="block text-xs">Received on<input type="date" className={`${input} mt-1 w-full`} value={editing.certificateReceivedAt || ""} onChange={(e) => setEditing({ ...editing, certificateReceivedAt: e.target.value })} /></label>
            <div className="flex justify-end gap-2"><button className={ghost} onClick={() => setEditing(null)}>Close</button><button className={button} onClick={saveCertificate}>Save</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ TDS we deducted

const PayablePanel = ({ params }) => {
  const [data, setData] = useState(null);
  const [challans, setChallans] = useState([]);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState({});
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setError("");
    try {
      const [payable, list] = await Promise.all([getTdsPayableRequest(params), getTdsChallansRequest(params)]);
      setData(payable);
      setChallans(list || []);
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => { load(); setPicked({}); }, [params.entity, params.fy]);

  const pending = useMemo(() => (data?.rows || []).filter((row) => !row.challanId), [data]);
  const pickedRows = pending.filter((row) => picked[row.expenseId]);
  const pickedTotal = pickedRows.reduce((sum, row) => sum + Number(row.tdsAmount || 0), 0);

  const pickMonth = (period) => setPicked(Object.fromEntries(pending.filter((row) => row.period === period).map((row) => [row.expenseId, true])));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await createTdsChallanRequest({ ...form, expenseIds: pickedRows.map((row) => row.expenseId), taxAmount: pickedTotal }, params);
      setForm(null);
      setPicked({});
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (challan) => {
    const reason = window.prompt("Why cancel this challan? The bills will show as not deposited again.");
    if (reason === null) return;
    try {
      await cancelTdsChallanRequest(challan._id, reason, params);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className={card}><p className="text-xs text-slate-500">TDS we deducted ({params.fy})</p><p className="mt-1 text-xl font-bold">{money(data?.summary?.deducted || 0)}</p></div>
        <div className={card}><p className="text-xs text-slate-500">Still to deposit</p><p className="mt-1 text-xl font-bold">{money(data?.summary?.pending || 0)}</p></div>
        <div className={card}><p className="text-xs text-slate-500">Months past the due date</p><p className={`mt-1 text-xl font-bold ${data?.summary?.overdueMonths ? "text-rose-600" : ""}`}>{data?.summary?.overdueMonths || 0}</p></div>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}

      {!!data?.limits?.length && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="mb-1 flex items-center gap-1.5 font-bold"><AlertTriangle className="h-4 w-4" /> TDS limit crossed, but some bills have no TDS</p>
          {data.limits.map((row) => (
            <p key={row.supplierId}>{row.supplierName} ({row.section}): {row.reasons.join("; ")}. Bills without TDS: {row.billsWithoutTds.join(", ")}.</p>
          ))}
        </div>
      )}

      <div className={card}>
        <h3 className="mb-3 text-sm font-bold">By month</h3>
        <p className="mb-3 text-xs text-slate-500">TDS deducted in a month is due by the 7th of the next month (March's by 30 April). Late deposit costs 1.5% a month interest.</p>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
            <thead><tr><th className={th}>Month</th><th className={th}>Due by</th><th className={`${th} text-right`}>Deducted</th><th className={`${th} text-right`}>Deposited</th><th className={`${th} text-right`}>Pending</th><th className={th}></th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(data?.months || []).map((m) => (
                <tr key={m.period}>
                  <td className={td}>{m.period}</td><td className={td}>{day(m.dueDate)}</td>
                  <td className={`${td} text-right`}>{money(m.deducted)}</td><td className={`${td} text-right`}>{money(m.deposited)}</td>
                  <td className={`${td} text-right font-semibold ${m.overdue ? "text-rose-600" : ""}`}>{money(m.pending)}{m.overdue ? " (late)" : ""}</td>
                  <td className={td}>{m.pending > 0 && <button className={ghost} onClick={() => pickMonth(m.period)}>Pick these bills</button>}</td>
                </tr>
              ))}
              {!data?.months?.length && <tr><td className={td} colSpan={6}>No bills with TDS in {params.fy}.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className={card}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">Bills with TDS</h3>
          <button className={button} disabled={!pickedRows.length} onClick={() => setForm({ challanDate: new Date().toISOString().slice(0, 10), bsrCode: "", challanSerial: "", cin: "", interestAmount: "", feeAmount: "", paymentMethod: "BANK_TRANSFER", notes: "" })}>
            Record challan for {pickedRows.length} bill(s), {money(pickedTotal)}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
            <thead><tr><th className={th}></th><th className={th}>Bill</th><th className={th}>Date</th><th className={th}>Payee</th><th className={th}>PAN</th><th className={th}>Section</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>Rate</th><th className={`${th} text-right`}>TDS</th><th className={th}>Challan</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {(data?.rows || []).map((row) => (
                <tr key={row.expenseId}>
                  <td className={td}>{!row.challanId && <input type="checkbox" checked={!!picked[row.expenseId]} onChange={(e) => setPicked({ ...picked, [row.expenseId]: e.target.checked })} />}</td>
                  <td className={td}>{row.expenseNumber}</td><td className={td}>{day(row.expenseDate)}</td><td className={td}>{row.payeeName}</td>
                  <td className={td}>{row.payeePan || <span className="text-rose-600">No PAN</span>}</td><td className={td}>{row.section}</td>
                  <td className={`${td} text-right`}>{money(row.amountBeforeTax)}</td><td className={`${td} text-right`}>{row.tdsRate}%</td><td className={`${td} text-right font-semibold`}>{money(row.tdsAmount)}</td>
                  <td className={td}>{row.challanId ? `${row.challanSerial || "-"} / ${day(row.challanDate)}` : "Not deposited"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={card}>
        <h3 className="mb-3 text-sm font-bold">Challans</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
            <thead><tr><th className={th}>Date</th><th className={th}>Month</th><th className={th}>BSR</th><th className={th}>Serial</th><th className={`${th} text-right`}>Tax</th><th className={`${th} text-right`}>Interest + fee</th><th className={th}>Bills</th><th className={th}>Status</th><th className={th}></th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {challans.map((c) => (
                <tr key={c._id} className={c.status === "CANCELLED" ? "opacity-50" : ""}>
                  <td className={td}>{day(c.challanDate)}</td><td className={td}>{c.period}</td><td className={td}>{c.bsrCode || "-"}</td><td className={td}>{c.challanSerial || "-"}</td>
                  <td className={`${td} text-right`}>{money(c.taxAmount)}</td><td className={`${td} text-right`}>{money(Number(c.interestAmount || 0) + Number(c.feeAmount || 0))}</td>
                  <td className={td}>{c.expenseIds?.length || 0}</td><td className={td}>{c.status === "CANCELLED" ? "Cancelled" : "Deposited"}</td>
                  <td className={td}>{c.status !== "CANCELLED" && <button className={ghost} onClick={() => cancel(c)}><XCircle className="h-3.5 w-3.5" /> Cancel</button>}</td>
                </tr>
              ))}
              {!challans.length && <tr><td className={td} colSpan={9}>No challans recorded.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {form && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg space-y-3 rounded-2xl bg-white p-5 dark:bg-slate-900">
            <h3 className="text-sm font-bold">Record TDS challan: {money(pickedTotal)} for {pickedRows.length} bill(s)</h3>
            <p className="text-xs text-slate-500">Enter the details from the challan receipt (ITNS 281 / e-pay tax). The bank is credited with tax + interest + fee.</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs">Challan date<input type="date" className={`${input} mt-1 w-full`} value={form.challanDate} onChange={(e) => setForm({ ...form, challanDate: e.target.value })} /></label>
              <label className="text-xs">Paid by<select className={`${input} mt-1 w-full`} value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}><option value="BANK_TRANSFER">Bank / net banking</option><option value="CASH">Cash</option></select></label>
              <label className="text-xs">BSR code<input className={`${input} mt-1 w-full`} maxLength={7} value={form.bsrCode} onChange={(e) => setForm({ ...form, bsrCode: e.target.value })} /></label>
              <label className="text-xs">Challan serial no.<input className={`${input} mt-1 w-full`} maxLength={10} value={form.challanSerial} onChange={(e) => setForm({ ...form, challanSerial: e.target.value })} /></label>
              <label className="col-span-2 text-xs">CIN / CRN<input className={`${input} mt-1 w-full`} value={form.cin} onChange={(e) => setForm({ ...form, cin: e.target.value })} /></label>
              <label className="text-xs">Interest<input type="number" min="0" className={`${input} mt-1 w-full`} value={form.interestAmount} onChange={(e) => setForm({ ...form, interestAmount: e.target.value })} /></label>
              <label className="text-xs">Late fee<input type="number" min="0" className={`${input} mt-1 w-full`} value={form.feeAmount} onChange={(e) => setForm({ ...form, feeAmount: e.target.value })} /></label>
            </div>
            {error && <p className="text-xs text-rose-600">{error}</p>}
            <div className="flex justify-end gap-2"><button className={ghost} onClick={() => setForm(null)}>Close</button><button className={button} disabled={saving} onClick={save}>{saving ? "Saving..." : "Save challan"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ quarterly return and certificates

const ReturnsPanel = ({ params, meta }) => {
  const [quarter, setQuarter] = useState(meta?.currentPeriod?.quarter || "Q3");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      setRows(await getTdsForm131Request({ ...params, quarter }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  useEffect(() => { load(); }, [params.entity, params.fy, quarter]);

  const download = async () => {
    try {
      const blob = await downloadTdsForm140({ ...params, quarter });
      const url = URL.createObjectURL(new Blob([blob], { type: "text/csv;charset=utf-8;" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `form140-${params.fy}-${quarter}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold">Quarterly TDS statement (Form 140, was 26Q)</h3>
            <p className="text-xs text-slate-500">One line per bill with TDS, in the order the return utility asks for. Your CA loads it into the RPU and files it. Due {meta?.returnDue?.[quarter] || ""}.</p>
          </div>
          <div className="flex items-center gap-2">
            <select className={input} value={quarter} onChange={(e) => setQuarter(e.target.value)}>{["Q1", "Q2", "Q3", "Q4"].map((q) => <option key={q} value={q}>{q}</option>)}</select>
            <button className={button} onClick={download}><Download className="h-4 w-4" /> Download lines (CSV)</button>
          </div>
        </div>
      </div>
      <div className={card}>
        <h3 className="mb-1 text-sm font-bold">Certificates to issue (Form 131, was 16A)</h3>
        <p className="mb-3 text-xs text-slate-500">After the statement is filed, download each payee's certificate from TRACES and send it to them. This list is what each one should show.</p>
        {error && <p className="mb-2 text-xs text-rose-600">{error}</p>}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
            <thead><tr><th className={th}>Payee</th><th className={th}>PAN</th><th className={th}>Section</th><th className={`${th} text-right`}>Paid / credited</th><th className={`${th} text-right`}>TDS</th><th className={th}>Deposited</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((row) => (
                <tr key={`${row.deducteePan}-${row.deducteeName}`}>
                  <td className={td}>{row.deducteeName}</td><td className={td}>{row.deducteePan}</td><td className={td}>{row.sections}</td>
                  <td className={`${td} text-right`}>{money(row.amountPaid)}</td><td className={`${td} text-right font-semibold`}>{money(row.tdsDeducted)}</td>
                  <td className={td}>{row.allDeposited ? <span className="flex items-center gap-1 text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> All</span> : <span className="text-rose-600">{money(row.tdsDeposited)} of {money(row.tdsDeducted)}</span>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td className={td} colSpan={6}>No TDS in {quarter} {params.fy}.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const TdsTab = ({ selectedEntity }) => {
  const [meta, setMeta] = useState(null);
  const [fy, setFy] = useState("");
  const [view, setView] = useState("payable");

  useEffect(() => {
    getTdsMetaRequest().then((data) => { setMeta(data); setFy((current) => current || data.currentPeriod.fy); }).catch(() => setFy("2026-27"));
  }, []);

  if (selectedEntity === "all") {
    return <div className={card}><p className="text-sm">TDS is filed per company. Pick The Office On Rent or Goldhawk above.</p></div>;
  }
  if (!fy) return <div className={card}><RefreshCw className="h-4 w-4 animate-spin" /></div>;
  const params = { entity: selectedEntity, fy };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {[["payable", "TDS we deducted"], ["receivable", "TDS customers deducted"], ["returns", "Returns & certificates"]].map(([key, label]) => (
          <button key={key} onClick={() => setView(key)} className={view === key ? button : ghost}><FileText className="h-3.5 w-3.5" /> {label}</button>
        ))}
        <select className={`${input} ml-auto`} value={fy} onChange={(e) => setFy(e.target.value)}>{fyOptions(meta?.currentPeriod?.fy).map((value) => <option key={value} value={value}>FY {value}</option>)}</select>
      </div>
      {view === "payable" && <PayablePanel params={params} />}
      {view === "receivable" && <ReceivablePanel params={params} />}
      {view === "returns" && <ReturnsPanel params={params} meta={meta} />}
    </div>
  );
};

export default TdsTab;
