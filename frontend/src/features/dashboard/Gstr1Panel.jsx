import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Info, Loader2, XCircle } from "lucide-react";
import { gstr1ExcelRequest, gstr1Request } from "../auth/api";

const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const date = (value) => (value ? new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—");

// Last month by default: GSTR-1 is filed for the month that has just ended.
const previousMonth = () => {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const levelStyle = {
  error: { icon: XCircle, className: "text-rose-600" },
  warning: { icon: AlertTriangle, className: "text-amber-600" },
  info: { icon: Info, className: "text-sky-600" },
};

const Table = ({ headers, rows, empty }) => (
  <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--panel-border)" }}>
    <table className="w-full min-w-[560px] text-left text-sm">
      <thead style={{ background: "var(--theme-surface-muted)" }}><tr>{headers.map(([label, numeric]) => <th key={label} className={`px-3 py-2 ${numeric ? "text-right" : ""}`}>{label}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((cells, index) => <tr key={index} className="border-t" style={{ borderColor: "var(--panel-border)" }}>{cells.map((cell, i) => <td key={i} className={`px-3 py-2 ${headers[i][1] ? "text-right tabular-nums" : ""} whitespace-nowrap`}>{cell}</td>)}</tr>)
        : <tr><td colSpan={headers.length} className="px-3 py-4 text-center text-sm" style={{ color: "var(--text-muted)" }}>{empty}</td></tr>}</tbody>
    </table>
  </div>
);

const Gstr1Panel = () => {
  const [month, setMonth] = useState(previousMonth());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    gstr1Request(month)
      .then((result) => { if (active) setData(result); })
      .catch((err) => { if (active) { setData(null); setError(err.response?.data?.message || "Unable to prepare GSTR-1."); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month]);

  const download = async () => {
    setDownloading(true); setError("");
    try {
      const blob = await gstr1ExcelRequest(month);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = data?.fileName || `GSTR1_${month}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      let message = "Unable to download GSTR-1.";
      try { message = JSON.parse(await err.response?.data?.text?.())?.message || message; } catch { /* not JSON */ }
      setError(message);
    } finally {
      setDownloading(false);
    }
  };

  const errors = data?.issues?.filter((item) => item.level === "error") || [];
  const otherIssues = data?.issues?.filter((item) => item.level !== "error") || [];
  const b2cTaxable = (data?.b2cs || []).reduce((sum, row) => sum + Number(row.taxableValue || 0), 0) + (data?.b2cl || []).reduce((sum, row) => sum + Number(row.taxableValue || 0), 0);
  const b2bTaxable = (data?.b2b || []).reduce((sum, row) => sum + Number(row.taxableValue || 0), 0);

  return (
    <section className="panel space-y-5 p-5" aria-label="GSTR-1">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="icon-chip"><FileSpreadsheet size={18} /></span>
          <div>
            <h2 className="text-base font-bold">GSTR-1 (sales return)</h2>
            <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
              Every invoice issued in the month, with a tax summary by GSTR-1 table, the invoice register and the HSN/SAC summary. Download the Excel and send it to your CA.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="form-field"><span className="form-label">Tax period</span>
            <input type="month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(event) => event.target.value && setMonth(event.target.value)} className="field" />
          </label>
          <button type="button" onClick={download} disabled={downloading || loading || !data} className="btn-primary">
            {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Download GSTR-1 Excel
          </button>
        </div>
      </div>

      {error ? <p role="alert" className="alert alert-error">{error}</p> : null}
      {loading ? <p role="status" className="flex items-center gap-2 text-sm" style={{ color: "var(--text-muted)" }}><Loader2 size={16} className="animate-spin" /> Preparing GSTR-1…</p> : null}

      {data && !loading ? (
        <>
          <div className="stat-grid">
            {[
              ["B2B invoices", `${data.b2b.length ? new Set(data.b2b.map((r) => r.invoiceNumber)).size : 0}`, money(b2bTaxable) + " taxable"],
              ["B2C supplies", money(b2cTaxable), "Clients without GSTIN"],
              ["Total tax", money(data.totals.totalTax), `IGST ${money(data.totals.igst)} · CGST ${money(data.totals.cgst)} · SGST ${money(data.totals.sgst)}`],
              ["Documents", `${data.docs[0]?.total || 0}`, data.docs[0] ? `${data.docs[0].from} to ${data.docs[0].to} · ${data.docs[0].cancelled} cancelled` : "No invoices this month"],
            ].map(([label, value, detail]) => (
              <div key={label} className="panel stat-card"><p className="stat-label">{label}</p><p className="stat-value">{value}</p><p className="stat-detail">{detail}</p></div>
            ))}
          </div>

          <div className={`alert ${errors.length ? "alert-error" : "alert-success"}`}>
            {errors.length ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
            <div className="min-w-0">
              <p className="font-semibold">{errors.length ? `${errors.length} thing${errors.length === 1 ? "" : "s"} to fix before sending to your CA` : "Ready to send to your CA"}</p>
              {[...errors, ...otherIssues].length ? (
                <ul className="mt-2 space-y-1 text-xs font-normal">
                  {[...errors, ...otherIssues].map((item, index) => {
                    const { icon: Icon, className } = levelStyle[item.level] || levelStyle.info;
                    return <li key={index} className="flex gap-2"><Icon size={14} className={`mt-0.5 shrink-0 ${className}`} /><span>{item.invoiceNumber ? <strong>{item.invoiceNumber}: </strong> : null}{item.message}</span></li>;
                  })}
                </ul>
              ) : <p className="mt-1 text-xs font-normal">Every invoice has a valid GSTIN or place of supply, a SAC code and its tax split.</p>}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">B2B: clients with GSTIN ({data.b2b.length})</h3>
            <Table
              headers={[["GSTIN"], ["Client"], ["Invoice"], ["Date"], ["Invoice value", true], ["Place of supply"], ["Rate", true], ["Taxable", true]]}
              rows={data.b2b.map((r) => [r.gstin, r.name || "—", r.invoiceNumber, date(r.invoiceDate), money(r.invoiceValue), r.pos, `${r.rate}%`, money(r.taxableValue)])}
              empty="No invoices to GST-registered clients this month."
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">B2C: clients without GSTIN</h3>
              <Table
                headers={[["Type"], ["Place of supply"], ["Rate", true], ["Taxable", true]]}
                rows={[...data.b2cs.map((r) => ["B2C small", r.pos, `${r.rate}%`, money(r.taxableValue)]), ...data.b2cl.map((r) => [`B2C large · ${r.invoiceNumber}`, r.pos, `${r.rate}%`, money(r.taxableValue)])]}
                empty="No B2C supplies this month."
              />
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">HSN / SAC summary</h3>
              <Table
                headers={[["Section"], ["SAC"], ["Rate", true], ["Taxable", true], ["Tax", true]]}
                rows={[...data.hsnB2B.map((r) => ["B2B", r.hsn || "Missing", `${r.rate}%`, money(r.taxableValue), money(r.igst + r.cgst + r.sgst)]), ...data.hsnB2C.map((r) => ["B2C", r.hsn || "Missing", `${r.rate}%`, money(r.taxableValue), money(r.igst + r.cgst + r.sgst)])]}
                empty="No taxable supplies this month."
              />
            </div>
          </div>

          {data.cdnr.length || data.cdnur.length ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Credit notes</h3>
              <Table
                headers={[["Note"], ["Date"], ["Client GSTIN"], ["Rate", true], ["Taxable", true]]}
                rows={[...data.cdnr, ...data.cdnur].map((r) => [r.noteNumber, date(r.noteDate), r.gstin || "Unregistered", `${r.rate}%`, money(r.taxableValue)])}
                empty=""
              />
            </div>
          ) : null}
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Cancelled invoices are only counted in the documents table. Invoices are reported exactly as issued; to change one, cancel and re-issue it.</p>
        </>
      ) : null}
    </section>
  );
};

export default Gstr1Panel;
