import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { gstr3bRequest, import2bRequest, itcRegisterRequest, match2bRequest, setImsActionRequest } from "../auth/api";

const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const date = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");
const errorText = (err) => err?.response?.data?.message || err?.message || "Something went wrong";
const lastMonth = () => {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
};

const th = "px-3 py-2 text-left text-xs font-medium";
const td = "px-3 py-2 text-sm";
const num = "px-3 py-2 text-right text-sm tabular-nums";

const STATUS = {
  MATCHED: ["Matched", "text-emerald-600"],
  VALUE_MISMATCH: ["Tax differs", "text-amber-600"],
  NOT_IN_BOOKS: ["Not in our books", "text-rose-600"],
  NOT_IN_2B: ["Not in GSTR-2B", "text-rose-600"],
  IN_OTHER_MONTH: ["In another month's 2B", "text-sky-600"],
  NO_SUPPLIER_GSTIN: ["Supplier GSTIN missing", "text-amber-600"],
  NO_BILL_NUMBER: ["Bill number missing", "text-amber-600"],
  NO_IMPORT: ["No 2B imported", ""],
  RCM: ["Reverse charge", "text-sky-600"],
};
const Status = ({ value }) => {
  const [label, tone] = STATUS[value] || [value, ""];
  return <span className={`text-xs font-semibold ${tone}`}>{label}</span>;
};

const TaxRow = ({ row, label }) => (
  <tr className="border-t" style={{ borderColor: "var(--panel-border)" }}>
    <td className={td}>{label || row.label}</td>
    <td className={num}>{money(row.taxableValue)}</td>
    <td className={num}>{money(row.igst)}</td>
    <td className={num}>{money(row.cgst)}</td>
    <td className={num}>{money(row.sgst)}</td>
  </tr>
);
const TaxHead = ({ first = "Nature of supplies" }) => (
  <thead className="bg-slate-500/5"><tr><th className={th}>{first}</th><th className={`${th} text-right`}>Taxable value</th><th className={`${th} text-right`}>IGST</th><th className={`${th} text-right`}>CGST</th><th className={`${th} text-right`}>SGST/UTGST</th></tr></thead>
);
const Box = ({ title, children, note }) => (
  <section className="min-w-0 rounded-2xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--panel-bg)" }}>
    <h3 className="text-base font-semibold">{title}</h3>
    {note ? <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{note}</p> : null}
    <div className="mt-3 overflow-x-auto">{children}</div>
  </section>
);

const Gstr3bView = ({ month }) => {
  const [filingDate, setFilingDate] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    gstr3bRequest({ month, ...(filingDate ? { filingDate } : {}) }).then((d) => live && setData(d)).catch((e) => live && setError(errorText(e))).finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [month, filingDate]);
  if (loading && !data) return <p className="text-sm"><Loader2 size={14} className="mr-1 inline animate-spin" />Building GSTR-3B…</p>;
  if (error) return <p role="alert" className="text-sm text-rose-600">{error}</p>;
  if (!data) return null;
  const t31 = data.table31;
  const t4 = data.table4;
  const p = data.payment;
  return (
    <div className="space-y-4">
      {data.notes?.length ? (
        <div className="rounded-2xl border border-amber-300/60 bg-amber-500/10 p-3 text-sm">
          {data.notes.map((note) => <p key={note} className="flex gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />{note}</p>)}
        </div>
      ) : null}
      <Box title="3.1 Outward supplies and inward supplies liable to reverse charge" note={`Due ${date(data.dueDate)} (monthly filers). From your invoices, credit notes and reverse-charge bills.`}>
        <table className="w-full text-left"><TaxHead />
          <tbody>{["a", "b", "c", "d", "e"].map((k) => <TaxRow key={k} row={t31[k]} />)}</tbody>
        </table>
      </Box>
      <Box title="4 Eligible ITC" note={t4.a5.source === "GSTR-2B" ? "4A(5) is from GSTR-2B (bills accepted or pending on IMS; rejected ones left out)." : "4A(5) is from your books: import GSTR-2B to claim only what your suppliers filed."}>
        <table className="w-full text-left"><TaxHead first="Details" />
          <tbody>
            <TaxRow row={t4.a3} />
            <TaxRow row={t4.a5} />
            <TaxRow row={t4.booksItc} label="(for reference) ITC in your books" />
            <TaxRow row={t4.b2} />
            <TaxRow row={t4.net} />
            <TaxRow row={t4.d} />
          </tbody>
        </table>
        {t4.b2.bills?.length ? (
          <div className="mt-3 text-xs">
            <p className="font-semibold">Unpaid more than 180 days (rule 37):</p>
            {t4.b2.bills.map((b) => <p key={b.number}>{b.number} · {b.supplierName} · {date(b.date)} · unpaid {money(b.balanceAmount)} · GST on unpaid part about {money(b.share)}</p>)}
          </div>
        ) : null}
      </Box>
      <Box title="Payment of tax" note="Credit is used as the law orders it: IGST first, then CGST and SGST; CGST and SGST never against each other. Reverse-charge tax is paid in cash.">
        <table className="w-full text-left">
          <thead className="bg-slate-500/5"><tr><th className={th}></th><th className={`${th} text-right`}>IGST</th><th className={`${th} text-right`}>CGST</th><th className={`${th} text-right`}>SGST</th></tr></thead>
          <tbody>
            {[["Tax on outward supplies", p.liability], ["Paid from credit: IGST", p.creditUsed.igst], ["Paid from credit: CGST", { igst: p.creditUsed.cgst.igst, cgst: p.creditUsed.cgst.cgst, sgst: 0 }], ["Paid from credit: SGST", { igst: p.creditUsed.sgst.igst, cgst: 0, sgst: p.creditUsed.sgst.sgst }], ["Reverse charge (cash)", p.reverseChargeCash], ["Cash to pay", p.cash], ["Credit carried forward", p.creditLeft]].map(([label, row]) => (
              <tr key={label} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                <td className={`${td} ${label === "Cash to pay" ? "font-semibold" : ""}`}>{label}</td>
                <td className={num}>{money(row.igst)}</td><td className={num}>{money(row.cgst)}</td><td className={num}>{money(row.sgst)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm font-semibold">Total cash: {money(p.cashTotal)}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="text-xs font-medium">Filing on (for interest)<input type="date" value={filingDate} onChange={(e) => setFilingDate(e.target.value)} className="field mt-1 py-2" /></label>
          {data.interest ? <p>{data.interest.daysLate ? `${data.interest.daysLate} day(s) late: interest about ${money(data.interest.amount)} (18% a year on cash tax), late fee about ${money(data.interest.lateFee)}.` : "On time: no interest."}</p> : null}
        </div>
      </Box>
      {data.rcmBills?.length ? (
        <Box title="Reverse-charge bills this month" note="Print the self-invoice and payment voucher from Expenses.">
          <table className="w-full text-left"><thead className="bg-slate-500/5"><tr><th className={th}>Bill</th><th className={th}>Self-invoice</th><th className={th}>Supplier</th><th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>GST</th></tr></thead>
            <tbody>{data.rcmBills.map((b) => <tr key={b.number} className="border-t" style={{ borderColor: "var(--panel-border)" }}><td className={td}>{b.number}</td><td className={td}>{b.selfInvoiceNumber}</td><td className={td}>{b.supplierName}</td><td className={num}>{money(b.taxableValue)}</td><td className={num}>{money(b.tax)}</td></tr>)}</tbody>
          </table>
        </Box>
      ) : null}
    </div>
  );
};

const ItcView = ({ month }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { setError(""); itcRegisterRequest({ month }).then(setData).catch((e) => setError(errorText(e))); }, [month]);
  if (error) return <p role="alert" className="text-sm text-rose-600">{error}</p>;
  if (!data) return <p className="text-sm"><Loader2 size={14} className="mr-1 inline animate-spin" />Loading…</p>;
  return (
    <Box title="Input credit register" note="Expense and purchase bills with GST booked this month. Add the supplier's bill number on each bill so it can be matched to GSTR-2B.">
      <table className="w-full text-left">
        <thead className="bg-slate-500/5"><tr><th className={th}>Date</th><th className={th}>Our no.</th><th className={th}>Supplier</th><th className={th}>GSTIN</th><th className={th}>Their bill</th><th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>GST</th><th className={th}>Claim</th><th className={th}>GSTR-2B</th></tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={String(r.sourceId)} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
              <td className={td}>{date(r.date)}</td><td className={td}>{r.number}</td><td className={td}>{r.supplierName}</td><td className={td}>{r.supplierGstin || (r.reverseCharge ? "Unregistered" : "—")}</td><td className={td}>{r.supplierInvoiceNumber || "—"}</td>
              <td className={num}>{money(r.taxableValue)}</td><td className={num}>{money(r.totalTax)}</td>
              <td className={td}>{r.itcEligible ? (r.reverseCharge ? "Yes (RCM)" : "Yes") : <span className="text-rose-600">Blocked</span>}</td>
              <td className={td}><Status value={r.in2b} /></td>
            </tr>
          ))}
          {!data.rows.length ? <tr><td className={td} colSpan={9}>No bills with GST this month.</td></tr> : null}
        </tbody>
      </table>
      <p className="mt-3 text-sm">Eligible: {money(data.totals.eligible.igst + data.totals.eligible.cgst + data.totals.eligible.sgst)} · Reverse charge: {money(data.totals.reverseCharge.igst + data.totals.reverseCharge.cgst + data.totals.reverseCharge.sgst)} · Blocked: {money(data.totals.blocked.igst + data.totals.blocked.cgst + data.totals.blocked.sgst)}</p>
    </Box>
  );
};

const TwoBView = ({ month }) => {
  const [data, setData] = useState(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const load = () => { setError(""); match2bRequest({ month }).then(setData).catch((e) => setError(errorText(e))); };
  useEffect(() => { setData(undefined); setNotice(""); load(); }, [month]);

  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return setError("This file is larger than 8 MB.");
    const reader = new FileReader();
    const isJson = /\.json$/i.test(file.name);
    const isCsv = /\.csv$/i.test(file.name);
    reader.onload = async () => {
      setBusy(true); setError("");
      try {
        const payload = isJson ? { jsonText: reader.result, fileName: file.name } : isCsv ? { csvText: reader.result, fileName: file.name } : { fileBase64: String(reader.result).split(",")[1], fileName: file.name };
        const result = await import2bRequest(payload, { month });
        setNotice(`Imported ${result.rows} bill(s) with ${money(result.totalTax)} GST.`);
        load();
      } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
    };
    if (isJson || isCsv) reader.readAsText(file); else reader.readAsDataURL(file);
  };

  const act = async (row, action) => {
    try { await setImsActionRequest(row._id, { action }, { month }); load(); } catch (err) { setError(errorText(err)); }
  };

  return (
    <div className="space-y-4">
      <Box title={`GSTR-2B for ${month}`} note="Download GSTR-2B (JSON or Excel) from the GST portal: Returns → GSTR-2B. Each bill is matched to yours by supplier GSTIN and bill number. Record your IMS decision here, and take the same action on the portal's IMS before GSTR-2B is generated.">
        <div className="flex flex-wrap items-center gap-3">
          <label className={`btn-primary cursor-pointer ${busy ? "opacity-60" : ""}`}><UploadCloud size={16} /> {busy ? "Importing…" : "Import GSTR-2B"}<input type="file" accept=".json,.xlsx,.xls,.csv" className="hidden" disabled={busy} onChange={onFile} /></label>
          {notice ? <span className="text-sm text-emerald-600">{notice}</span> : null}
          {error ? <span role="alert" className="text-sm text-rose-600">{error}</span> : null}
        </div>
        {data === null ? <p className="mt-3 text-sm">No GSTR-2B imported for this month yet.</p> : null}
        {data ? <p className="mt-3 text-sm">In 2B: {money(data.totals.in2b.igst + data.totals.in2b.cgst + data.totals.in2b.sgst)} · Claimable (accepted + pending): {money(data.totals.claimable.igst + data.totals.claimable.cgst + data.totals.claimable.sgst)} · Rejected: {money(data.totals.rejected.igst + data.totals.rejected.cgst + data.totals.rejected.sgst)} · {data.totals.problems ? `${data.totals.problems} to look at` : <span className="text-emerald-600"><CheckCircle2 size={14} className="inline" /> all matched</span>}</p> : null}
      </Box>
      {data ? (
        <>
          <Box title="Bills in GSTR-2B">
            <table className="w-full text-left">
              <thead className="bg-slate-500/5"><tr><th className={th}>Supplier</th><th className={th}>Bill</th><th className={th}>Date</th><th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>GST</th><th className={th}>Match</th><th className={th}>IMS</th></tr></thead>
              <tbody>
                {data.statement.map((r) => (
                  <tr key={r._id} className="border-t" style={{ borderColor: "var(--panel-border)" }}>
                    <td className={td}>{r.supplierName}<span className="block text-xs" style={{ color: "var(--text-muted)" }}>{r.supplierGstin}</span></td>
                    <td className={td}>{r.invoiceNumber}{r.section !== "B2B" ? ` (${r.section})` : ""}{r.reverseCharge ? " · RCM" : ""}{!r.itcAvailable ? " · ITC not available" : ""}</td>
                    <td className={td}>{date(r.invoiceDate)}</td>
                    <td className={num}>{money(r.taxableValue)}</td><td className={num}>{money(r.igst + r.cgst + r.sgst)}</td>
                    <td className={td}><Status value={r.status} />{r.bill ? <span className="block text-xs" style={{ color: "var(--text-muted)" }}>{r.bill.number}</span> : null}</td>
                    <td className={td}>
                      <select value={r.imsAction} onChange={(e) => act(r, e.target.value)} className="field py-1 text-xs">
                        <option value="PENDING">Pending</option><option value="ACCEPTED">Accept</option><option value="REJECTED">Reject</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
          <Box title="Our bills this month">
            <table className="w-full text-left">
              <thead className="bg-slate-500/5"><tr><th className={th}>Our no.</th><th className={th}>Supplier</th><th className={th}>Their bill</th><th className={`${th} text-right`}>GST</th><th className={th}>In GSTR-2B</th></tr></thead>
              <tbody>
                {data.books.map((b) => <tr key={String(b.sourceId)} className="border-t" style={{ borderColor: "var(--panel-border)" }}><td className={td}>{b.number}</td><td className={td}>{b.supplierName}</td><td className={td}>{b.supplierInvoiceNumber || "—"}</td><td className={num}>{money(b.totalTax)}</td><td className={td}><Status value={b.status} />{b.otherMonth ? ` (${b.otherMonth})` : ""}</td></tr>)}
                {!data.books.length ? <tr><td className={td} colSpan={5}>No bills with GST booked this month.</td></tr> : null}
              </tbody>
            </table>
          </Box>
        </>
      ) : null}
    </div>
  );
};

const GstInputPanel = () => {
  const [month, setMonth] = useState(lastMonth());
  const [view, setView] = useState("3b");
  return (
    <div className="space-y-4">
      <section className="panel flex flex-wrap items-end gap-3 p-4">
        <label className="text-xs font-medium">Return month<input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="field mt-1 py-2" /></label>
        <nav className="segmented">{[["3b", "GSTR-3B"], ["2b", "GSTR-2B / IMS"], ["itc", "Input credit"]].map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)} className={`segmented-item ${view === key ? "is-active" : ""}`}>{label}</button>)}</nav>
        <p className="w-full text-xs" style={{ color: "var(--text-muted)" }}>Prepared from the books for your CA to check and file on the GST portal. Nothing is filed from here.</p>
      </section>
      {view === "3b" ? <Gstr3bView month={month} /> : null}
      {view === "2b" ? <TwoBView month={month} /> : null}
      {view === "itc" ? <ItcView month={month} /> : null}
    </div>
  );
};

export default GstInputPanel;
