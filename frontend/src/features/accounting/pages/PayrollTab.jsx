import { useEffect, useMemo, useState } from "react";
import { Download, Printer, RefreshCw } from "lucide-react";
import {
  cancelStaffAdvanceRequest, downloadPayrollRegister, getPayrollRunRequest, getPayrollRunsRequest, getStaffAdvancesRequest,
  giveStaffAdvanceRequest, payPayrollDuesRequest, payPayrollRunRequest, postPayrollRunRequest, setPayrollDeductionMapRequest,
  unpostPayrollRunRequest,
} from "../api";
import { money } from "../../dashboard/reportPresentation";

// Payroll: the month's salary sheet comes finalised from the CRM (attendance, late marks,
// leave, KPI incentive, deductions). Here it is checked, posted at month end, paid, and
// its PF / ESI / PT / TDS dues paid. Staff advances are paid here and recovered in the sheet.

const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const th = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500";
const thr = "px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500";
const td = "px-3 py-2 align-top text-xs text-slate-700 dark:text-slate-300";
const tdr = "px-3 py-2 text-right align-top text-xs tabular-nums text-slate-700 dark:text-slate-300";
const input = "rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200";
const button = "flex items-center gap-1.5 rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50";
const ghost = "flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";
const errorText = (err) => err?.response?.data?.message || err?.message || "Something went wrong";
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const day = (v) => (v ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "-");
const sumOf = (items) => (items || []).reduce((s, x) => s + Number(x.amount || 0), 0);
const Err = ({ text }) => (text ? <p className="mt-2 text-xs font-semibold text-red-600">{text}</p> : null);
const STATUS = {
  RECEIVED: ["Received - not in the books", "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300"],
  POSTED: ["In the books - not fully paid", "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300"],
  PAID: ["Paid", "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"],
  SUPERSEDED: ["Replaced by a newer version", "bg-slate-100 text-slate-500 dark:bg-slate-800"],
};
const Badge = ({ status }) => <span className={`rounded-lg px-2 py-0.5 text-[11px] font-bold ${STATUS[status]?.[1] || ""}`}>{STATUS[status]?.[0] || status}</span>;
const save = (blob, name, type) => {
  const url = URL.createObjectURL(new Blob([blob], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rupees = (v) => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A plain payslip in a new window, for printing or saving as PDF.
const printPayslip = (run, row) => {
  const w = window.open("", "_blank", "width=720,height=900");
  if (!w) return;
  const lines = (items) => items.map((l) => `<tr><td>${esc(l.label)}${l.count ? ` (${esc(l.count)})` : ""}</td><td class="r">${rupees(l.amount)}</td></tr>`).join("");
  const a = row.attendance || {};
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(row.name)} ${esc(run.monthLabel)}</title>
<style>body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:32px}h1{font-size:18px;margin:0}h2{font-size:13px;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.06em;color:#555}
table{width:100%;border-collapse:collapse}td{padding:4px 0;border-bottom:1px solid #eee}.r{text-align:right;font-variant-numeric:tabular-nums}.t td{font-weight:700;border-top:2px solid #111}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}.muted{color:#666}</style></head><body>
<h1>Payslip - ${esc(run.monthLabel)}</h1><p class="muted">${esc(row.name)}${row.department ? ` · ${esc(row.department)}` : ""}${row.email ? ` · ${esc(row.email)}` : ""}</p>
<p class="muted">Working days ${esc(a.workingDays ?? "-")} · absent ${esc(a.absent)} · half days ${esc(a.halfDay)} · paid leave ${esc(a.paidLeave)} · unpaid / unapproved leave ${esc(Number(a.unpaidLeave || 0) + Number(a.unapprovedLeave || 0) + Number(a.leaveBeyondEntitlement || 0))} · late marks ${esc(a.late)}</p>
<div class="grid"><div><h2>Earnings</h2><table><tr><td>Monthly salary</td><td class="r">${rupees(row.monthlySalary)}</td></tr>
${row.attendanceLines.filter((l) => l.amount > 0).map((l) => `<tr><td>Less: ${esc(l.label)}${l.count ? ` (${esc(l.count)})` : ""}</td><td class="r">-${rupees(l.amount)}</td></tr>`).join("")}
<tr><td>Earned salary</td><td class="r">${rupees(row.earnedSalary)}</td></tr>${lines(row.additions)}<tr class="t"><td>Gross</td><td class="r">${rupees(row.gross)}</td></tr></table></div>
<div><h2>Deductions</h2><table>${lines(row.deductions) || `<tr><td class="muted">None</td><td></td></tr>`}<tr class="t"><td>Total deductions</td><td class="r">${rupees(row.totalDeduction)}</td></tr></table></div></div>
<h2>Net pay</h2><p style="font-size:20px;font-weight:700;margin:0">Rs ${rupees(row.net)}</p>
${row.kpi?.score != null ? `<p class="muted">KPI score ${esc(row.kpi.score)}${row.kpi.grade ? ` (${esc(row.kpi.grade)})` : ""}${row.kpi.targetScore != null ? ` · target score ${esc(row.kpi.targetScore)}` : ""}</p>` : ""}
<p class="muted" style="margin-top:28px">Worked out from attendance in the CRM (sheet v${esc(run.version)}). Computer-generated; no signature needed.</p>
<script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
};

// ------------------------------------------------------------------ one month

const RunDetail = ({ runId, params, bookAs, onChanged }) => {
  const [run, setRun] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [map, setMap] = useState({});
  const [picked, setPicked] = useState({});
  const [pay, setPay] = useState({ date: today(), mode: "BANK", reference: "" });
  const [due, setDue] = useState(null);

  const take = (data) => { setRun(data); setMap(Object.fromEntries((data.deductionMap || []).map((m) => [m.label, m.bookAs]))); setPicked({}); setError(""); };
  const load = async () => { try { take(await getPayrollRunRequest(runId, params)); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { setRun(null); load(); }, [runId, params.entity]);
  const act = async (fn) => {
    setBusy(true);
    try { take(await fn()); onChanged(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  if (!run) return <div className={`${card} overflow-x-auto`}><p className="text-xs text-slate-500">{error || "Loading…"}</p></div>;
  const open = run.status === "RECEIVED";
  const payable = ["POSTED", "PAID"].includes(run.status);
  const unpaidRows = run.rows.filter((r) => r.net - r.paid > 0.004);
  const pickedRows = Object.entries(picked).filter(([, on]) => on).map(([rowId]) => ({ rowId }));
  const mapChanged = (run.deductionMap || []).some((m) => map[m.label] !== m.bookAs);

  return (
    <div className="space-y-4">
      <div className={`${card} overflow-x-auto`}>
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-bold">{run.monthLabel} <span className="text-slate-500">v{run.version}</span></h3>
          <Badge status={run.status} />
          <span className="text-xs text-slate-500">Finalised in the CRM{run.finalisedBy ? ` by ${run.finalisedBy}` : ""}{run.finalisedAt ? ` on ${day(run.finalisedAt)}` : ""} · received {day(run.receivedAt)}</span>
          <button type="button" className={`${ghost} ml-auto`} onClick={async () => { try { save(await downloadPayrollRegister(run._id, params), `salary-register-${run.month}-v${run.version}.csv`, "text/csv"); } catch (err) { setError(errorText(err)); } }}><Download size={14} /> Salary register (CSV)</button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          {[["Salaries", run.totals.monthlySalary], ["Attendance cuts", run.totals.attendanceDeduction], ["Incentives and additions", run.totals.additions], ["Gross", run.totals.gross], ["Deductions", run.totals.deductions], ["Net pay", run.totals.net], ["Paid", run.paidTotal], ["Still to pay", run.unpaidTotal]].map(([label, v]) => (
            <div key={label}><p className="text-[11px] text-slate-500">{label}</p><p className="text-sm font-bold tabular-nums">{money(v || 0)}</p></div>
          ))}
        </div>
        {run.salaryExpensesSameMonth?.count ? (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {run.salaryExpensesSameMonth.count} salary expense{run.salaryExpensesSameMonth.count === 1 ? " is" : "s are"} already entered for this month ({money(run.salaryExpensesSameMonth.total)}). Cancel {run.salaryExpensesSameMonth.count === 1 ? "it" : "them"} if this sheet covers the same salaries, or they are counted twice.
          </p>
        ) : null}
        <Err text={error} />
      </div>

      <div className={`${card} overflow-x-auto`}>
        <p className="mb-2 text-xs font-bold">Salary sheet</p>
        <table className="min-w-full">
          <thead><tr>
            {payable ? <th className={th}><input type="checkbox" aria-label="Pick everyone unpaid" checked={unpaidRows.length > 0 && unpaidRows.every((r) => picked[r._id])} onChange={(e) => setPicked(Object.fromEntries(unpaidRows.map((r) => [r._id, e.target.checked])))} /></th> : null}
            <th className={th}>Employee</th><th className={thr}>Salary</th><th className={thr} title="Absent / half days / unpaid leave / late marks">Abs · ½ · leave · late</th><th className={thr}>Attendance cut</th><th className={thr}>Additions</th><th className={thr}>Deductions</th><th className={thr}>Net</th><th className={thr}>Paid</th><th className={thr} title="KPI score and target score from the CRM">KPI</th><th className={th} />
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {run.rows.map((r) => {
              const a = r.attendance || {};
              const leave = Number(a.unpaidLeave || 0) + Number(a.unapprovedLeave || 0) + Number(a.leaveBeyondEntitlement || 0);
              const left = r.net - r.paid;
              return (
                <tr key={r._id}>
                  {payable ? <td className={td}>{left > 0.004 ? <input type="checkbox" checked={Boolean(picked[r._id])} onChange={(e) => setPicked((p) => ({ ...p, [r._id]: e.target.checked }))} aria-label={`Pick ${r.name}`} /> : null}</td> : null}
                  <td className={td}><p className="font-semibold">{r.name}</p><p className="text-[11px] text-slate-500">{r.department}</p></td>
                  <td className={tdr}>{money(r.monthlySalary)}</td>
                  <td className={tdr}>{a.absent || 0} · {a.halfDay || 0} · {leave} · {a.late || 0}</td>
                  <td className={tdr}>{money(r.attendanceDeduction)}</td>
                  <td className={tdr} title={r.additions.map((x) => `${x.label}: ${x.amount}`).join("\n")}>{money(sumOf(r.additions))}</td>
                  <td className={tdr} title={r.deductions.map((x) => `${x.label}: ${x.amount}`).join("\n")}>{money(r.totalDeduction)}</td>
                  <td className={`${tdr} font-bold`}>{money(r.net)}</td>
                  <td className={tdr}>{money(r.paid)}</td>
                  <td className={tdr} title={r.kpi?.grade || ""}>{r.kpi?.score ?? "-"}{r.kpi?.targetScore != null ? ` · ${r.kpi.targetScore}` : ""}</td>
                  <td className={td}><button type="button" className={ghost} onClick={() => printPayslip(run, r)}><Printer size={13} /> Payslip</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 2xl:grid-cols-2">
        <div className={`${card} overflow-x-auto`}>
          <p className="text-xs font-bold">How the deductions are booked</p>
          {!run.deductionMap?.length ? <p className="mt-2 text-xs text-slate-500">No deductions this month.</p> : (
            <table className="mt-2 min-w-full"><tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {run.deductionMap.map((m) => (
                <tr key={m.label}><td className={td}>{m.label}</td><td className={td}>
                  <select className={input} value={map[m.label] || m.bookAs} disabled={!open} onChange={(e) => setMap((x) => ({ ...x, [m.label]: e.target.value }))}>
                    {bookAs.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                  </select>
                </td></tr>
              ))}
            </tbody></table>
          )}
          {open && mapChanged ? <button type="button" className={`${button} mt-3`} disabled={busy} onClick={() => act(() => setPayrollDeductionMapRequest(run._id, Object.entries(map).map(([label, v]) => ({ label, bookAs: v })), params))}>Save</button> : null}
          {!open && run.deductionMap?.length ? <p className="mt-2 text-[11px] text-slate-500">Take the month out of the books to change these.</p> : null}
        </div>

        <div className={`${card} overflow-x-auto`}>
          <p className="text-xs font-bold">{open ? "What posting will enter" : "In the books"}, dated the last day of {run.monthLabel}</p>
          <table className="mt-2 min-w-full">
            <thead><tr><th className={th}>Account</th><th className={thr}>Debit</th><th className={thr}>Credit</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {run.journalPreview.map((l) => <tr key={l.code}><td className={td}>{l.code} · {l.description}</td><td className={tdr}>{l.debit ? money(l.debit) : ""}</td><td className={tdr}>{l.credit ? money(l.credit) : ""}</td></tr>)}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap gap-2">
            {open ? <button type="button" className={button} disabled={busy || mapChanged} onClick={() => act(() => postPayrollRunRequest(run._id, params))}>Post to the books</button> : null}
            {run.status === "POSTED" && !run.payments.length && !run.duesPaid.length ? <button type="button" className={ghost} disabled={busy} onClick={() => window.confirm("Take this month out of the books? Its entry is reversed.") && act(() => unpostPayrollRunRequest(run._id, params))}>Take out of the books</button> : null}
          </div>
        </div>
      </div>

      {payable ? (
        <div className="grid gap-4 2xl:grid-cols-2">
          <div className={`${card} overflow-x-auto`}>
            <p className="text-xs font-bold">Pay salaries</p>
            {unpaidRows.length ? (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input type="date" className={input} value={pay.date} onChange={(e) => setPay((p) => ({ ...p, date: e.target.value }))} />
                  <select className={input} value={pay.mode} onChange={(e) => setPay((p) => ({ ...p, mode: e.target.value }))}><option value="BANK">Bank</option><option value="CASH">Cash</option></select>
                  <input className={input} placeholder="Reference (UTR, batch)" value={pay.reference} onChange={(e) => setPay((p) => ({ ...p, reference: e.target.value }))} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className={button} disabled={busy || !pickedRows.length} onClick={() => act(() => payPayrollRunRequest(run._id, { ...pay, rows: pickedRows }, params))}>Pay the {pickedRows.length || ""} picked</button>
                  <button type="button" className={ghost} disabled={busy} onClick={() => window.confirm(`Pay everyone still unpaid (${money(run.unpaidTotal)})?`) && act(() => payPayrollRunRequest(run._id, pay, params))}>Pay everyone unpaid ({money(run.unpaidTotal)})</button>
                </div>
              </>
            ) : <p className="mt-2 text-xs text-emerald-700">Everyone is paid.</p>}
            {run.payments.length ? (
              <ul className="mt-3 space-y-1 text-[11px] text-slate-500">{run.payments.map((p) => <li key={p._id}>{day(p.date)} · {money(p.amount)} · {p.mode === "CASH" ? "cash" : "bank"}{p.reference ? ` · ${p.reference}` : ""} · {p.rows.length === 1 ? p.rows[0].name : `${p.rows.length} people`}</li>)}</ul>
            ) : null}
          </div>

          <div className={`${card} overflow-x-auto`}>
            <p className="text-xs font-bold">Dues held back from salaries</p>
            {!run.dues.length ? <p className="mt-2 text-xs text-slate-500">None this month.</p> : (
              <table className="mt-2 min-w-full">
                <thead><tr><th className={th}>Due</th><th className={thr}>Deducted</th><th className={thr}>Paid</th><th className={thr}>Left</th><th className={th} /></tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {run.dues.map((d) => (
                    <tr key={d.kind}><td className={td}>{d.label}</td><td className={tdr}>{money(d.owed)}</td><td className={tdr}>{money(d.paid)}</td><td className={tdr}>{money(d.left)}</td>
                      <td className={td}>{d.left > 0.004 ? <button type="button" className={ghost} onClick={() => setDue({ kind: d.kind, label: d.label, amount: d.left, date: today(), mode: "BANK", reference: "" })}>Pay</button> : null}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {due ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-3 dark:bg-slate-800">
                <span className="text-xs font-semibold">{due.label}</span>
                <input className={`${input} w-28`} value={due.amount} onChange={(e) => setDue((x) => ({ ...x, amount: e.target.value }))} />
                <input type="date" className={input} value={due.date} onChange={(e) => setDue((x) => ({ ...x, date: e.target.value }))} />
                <input className={input} placeholder="Challan / ECR no." value={due.reference} onChange={(e) => setDue((x) => ({ ...x, reference: e.target.value }))} />
                <button type="button" className={button} disabled={busy} onClick={async () => { await act(() => payPayrollDuesRequest(run._id, due, params)); setDue(null); }}>Record payment</button>
                <button type="button" className={ghost} onClick={() => setDue(null)}>Close</button>
              </div>
            ) : null}
            <p className="mt-3 text-[11px] text-slate-500">TDS on salary (s.192) is filed in Form 24Q; PF and ESI by their own challans. Employer PF / ESI contributions are not added here yet.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// ------------------------------------------------------------------ advances

const AdvancesPanel = ({ params, people, refreshed }) => {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ name: "", externalUserId: "", amount: "", date: today(), mode: "BANK", reference: "" });
  const [error, setError] = useState("");
  const load = async () => { try { setData(await getStaffAdvancesRequest(params)); setError(""); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { load(); }, [params.entity, refreshed]);
  const pickPerson = (value) => {
    const p = people.find((x) => x.externalUserId === value);
    setForm((f) => ({ ...f, externalUserId: p?.externalUserId || "", name: p?.name || f.name }));
  };
  const give = async () => {
    try { await giveStaffAdvanceRequest(form, params); setForm((f) => ({ ...f, amount: "", reference: "" })); await load(); } catch (err) { setError(errorText(err)); }
  };
  return (
    <div className={`${card} overflow-x-auto`}>
      <p className="text-xs font-bold">Staff advances</p>
      <p className="mt-1 text-[11px] text-slate-500">Paid here; recovered through the CRM salary sheet as a deduction booked as "Staff advance recovered".</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select className={input} value={form.externalUserId} onChange={(e) => pickPerson(e.target.value)}>
          <option value="">Someone else…</option>
          {people.map((p) => <option key={p.externalUserId} value={p.externalUserId}>{p.name}</option>)}
        </select>
        {!form.externalUserId ? <input className={input} placeholder="Name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /> : null}
        <input className={`${input} w-28`} placeholder="Amount" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
        <input type="date" className={input} value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
        <select className={input} value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}><option value="BANK">Bank</option><option value="CASH">Cash</option></select>
        <input className={input} placeholder="Reference" value={form.reference} onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))} />
        <button type="button" className={button} onClick={give}>Pay advance</button>
      </div>
      <Err text={error} />
      {data?.people?.length ? (
        <table className="mt-3 min-w-full">
          <thead><tr><th className={th}>Person</th><th className={thr}>Given</th><th className={thr}>Recovered</th><th className={thr}>Still owed</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.people.map((p) => <tr key={`${p.externalUserId}-${p.name}`}><td className={td}>{p.name}</td><td className={tdr}>{money(p.given)}</td><td className={tdr}>{money(p.recovered)}</td><td className={`${tdr} font-bold`}>{money(p.balance)}</td></tr>)}
          </tbody>
        </table>
      ) : null}
      {data?.people?.some((p) => p.balance < 0) ? <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">A minus balance means more was recovered through salaries than was paid out here - an advance paid before BillStack kept them. Enter it with its old date, or as an opening balance on 1160 Staff Advances.</p> : null}
      {data?.advances?.length ? (
        <ul className="mt-3 space-y-1 text-[11px] text-slate-500">
          {data.advances.map((a) => <li key={a._id} className="flex items-center gap-2">{day(a.date)} · {a.name} · {money(a.amount)}{a.reference ? ` · ${a.reference}` : ""}
            <button type="button" className="text-red-600 hover:underline" onClick={async () => { if (!window.confirm(`Cancel the advance to ${a.name}? Its entry is reversed.`)) return; try { await cancelStaffAdvanceRequest(a._id, params); await load(); } catch (err) { setError(errorText(err)); } }}>cancel</button></li>)}
        </ul>
      ) : null}
    </div>
  );
};

// ------------------------------------------------------------------ tab

const PayrollTab = ({ selectedEntity }) => {
  const [list, setList] = useState(null);
  const [runId, setRunId] = useState("");
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const [refreshed, setRefreshed] = useState(0);
  const params = useMemo(() => ({ entity: selectedEntity }), [selectedEntity]);
  const load = async () => {
    try {
      const data = await getPayrollRunsRequest(params);
      setList(data);
      setError("");
      // keep the month picked if it is still in this company's list, else open the latest
      setRunId((current) => (data.runs.some((r) => r._id === current) ? current : data.runs[0]?._id || ""));
      setRefreshed((n) => n + 1);
      if (data.runs.length) {
        const latest = await getPayrollRunRequest(data.runs[0]._id, params);
        setPeople(latest.rows.map((r) => ({ externalUserId: r.externalUserId, name: r.name })));
      }
    } catch (err) { setError(errorText(err)); }
  };
  useEffect(() => { if (selectedEntity !== "all") load(); }, [selectedEntity]);

  if (selectedEntity === "all") return <div className={`${card} overflow-x-auto`}><p className="text-sm">Pick TOOR or Goldhawk above: payroll is kept per company.</p></div>;
  return (
    <div className="space-y-4">
      <div className={`${card} overflow-x-auto`}>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-bold">Payroll</p>
          <p className="text-xs text-slate-500">Each month is finalised in the CRM (Salary → Payroll) from attendance, late marks, leave and KPI, then sent here.</p>
          <button type="button" className={`${ghost} ml-auto`} onClick={load}><RefreshCw size={14} /> Refresh</button>
        </div>
        <Err text={error} />
        {list && !list.runs.length ? <p className="mt-3 text-xs text-slate-500">No salary sheet has come from the CRM yet.</p> : null}
        {list?.runs?.length ? (
          <table className="mt-3 min-w-full">
            <thead><tr><th className={th}>Month</th><th className={th}>Status</th><th className={thr}>People</th><th className={thr}>Gross</th><th className={thr}>Net</th><th className={thr}>Paid</th></tr></thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {list.runs.map((r) => (
                <tr key={r._id} className={`cursor-pointer ${r._id === runId ? "bg-brand-50/60 dark:bg-slate-800" : "hover:bg-slate-50 dark:hover:bg-slate-800/60"}`} onClick={() => setRunId(r._id)}>
                  <td className={td}><span className="font-semibold">{r.monthLabel}</span> <span className="text-slate-500">v{r.version}</span></td>
                  <td className={td}><Badge status={r.status} /></td>
                  <td className={tdr}>{r.employees}</td><td className={tdr}>{money(r.gross)}</td><td className={tdr}>{money(r.net)}</td><td className={tdr}>{money(r.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      {runId && list ? <RunDetail runId={runId} params={params} bookAs={list.bookAs} onChanged={load} /> : null}
      <AdvancesPanel params={params} people={people} refreshed={refreshed} />
    </div>
  );
};

export default PayrollTab;
