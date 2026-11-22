import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import {
  cancelAssetRequest, cancelDepositRequest, createAssetRequest, createDepositRequest, disposeAssetRequest, downloadTallyXml,
  getAssetClassesRequest, getAssetRegisterRequest, getAssetsRequest, getDepositsRequest, getGstr9Request, getItBlocksRequest,
  getMsmeReportRequest, getScheduleIIIRequest, moveDepositRequest, runDepreciationRequest,
} from "../api";
import { listExpensesRequest } from "../../auth/api";
import { money } from "../../dashboard/reportPresentation";

const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const th = "px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500";
const thr = "px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500";
const td = "px-3 py-2 align-top text-xs text-slate-700 dark:text-slate-300";
const tdr = "px-3 py-2 text-right align-top text-xs tabular-nums text-slate-700 dark:text-slate-300";
const input = "rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200";
const button = "flex items-center gap-1.5 rounded-xl bg-brand-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50";
const ghost = "flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";
const errorText = (err) => err?.response?.data?.message || err?.message || "Something went wrong";
const day = (v) => (v ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "-");
const fyChoices = () => {
  const now = new Date();
  const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return [0, 1, 2, 3].map((i) => { const y = start - i; return `${String(y).slice(2)}-${String((y + 1) % 100).padStart(2, "0")}`; });
};
const Notes = ({ notes }) => (notes?.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-300">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null);
const Err = ({ text }) => (text ? <p className="mt-2 text-xs font-semibold text-red-600">{text}</p> : null);
const save = (blob, name, type) => {
  const url = URL.createObjectURL(new Blob([blob], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

// ------------------------------------------------------------------ deposits

const DepositsPanel = ({ params }) => {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ direction: "RECEIVED", partyName: "", amount: "", date: "", mode: "BANK", purpose: "SECURITY", agreementEnd: "", reference: "" });
  const [move, setMove] = useState(null);
  const [error, setError] = useState("");
  const load = async () => { try { setData(await getDepositsRequest(params)); setError(""); } catch (err) { setError(errorText(err)); } };
  useEffect(() => { load(); }, [params.entity]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const create = async () => {
    try { await createDepositRequest(form, params); setForm((f) => ({ ...f, partyName: "", amount: "", reference: "" })); await load(); } catch (err) { setError(errorText(err)); }
  };
  const doMove = async () => {
    try { await moveDepositRequest(move.id, move, params); setMove(null); await load(); } catch (err) { setError(errorText(err)); }
  };
  const cancel = async (row) => {
    if (!window.confirm(`Cancel ${row.depositNumber}? Its entry is reversed.`)) return;
    try { await cancelDepositRequest(row._id, params); await load(); } catch (err) { setError(errorText(err)); }
  };
  const kinds = (dir) => (dir === "RECEIVED" ? [["REFUND", "Refund"], ["FORFEIT", "Forfeit (keep)"]] : [["REFUND", "Refund received"], ["ADJUST_RENT", "Adjusted against rent"], ["WRITE_OFF", "Write off"]]);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className={card}><p className="text-xs text-slate-500">Deposits held (owed to tenants)</p><p className="mt-1 text-xl font-bold">{money(data?.totals?.received || 0)}</p></div>
        <div className={card}><p className="text-xs text-slate-500">Deposits given (to landlords, others)</p><p className="mt-1 text-xl font-bold">{money(data?.totals?.given || 0)}</p></div>
      </div>
      <div className={card}>
        <h3 className="text-sm font-bold">New deposit</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <select className={input} value={form.direction} onChange={set("direction")} aria-label="Direction"><option value="RECEIVED">Received from a tenant</option><option value="GIVEN">Given to a landlord / other</option></select>
          <input className={input} placeholder="From / to" value={form.partyName} onChange={set("partyName")} />
          <input className={input} type="number" placeholder="Amount" value={form.amount} onChange={set("amount")} />
          <input className={input} type="date" value={form.date} onChange={set("date")} aria-label="Date" />
          <select className={input} value={form.mode} onChange={set("mode")} aria-label="Paid by"><option value="BANK">Bank</option><option value="CASH">Cash</option></select>
          <select className={input} value={form.purpose} onChange={set("purpose")} aria-label="Purpose"><option value="SECURITY">Security</option><option value="RENT">Rent</option><option value="UTILITY">Utility</option><option value="OTHER">Other</option></select>
          <label className="flex items-center gap-1 text-xs text-slate-500">Agreement ends <input className={input} type="date" value={form.agreementEnd} onChange={set("agreementEnd")} /></label>
          <input className={input} placeholder="Reference" value={form.reference} onChange={set("reference")} />
          <button type="button" className={button} disabled={!form.partyName || !form.amount} onClick={create}>Save</button>
        </div>
        <Err text={error} />
      </div>
      <div className={`${card} overflow-x-auto`}>
        <table className="min-w-full divide-y divide-slate-100 dark:divide-slate-800">
          <thead><tr><th className={th}>No.</th><th className={th}>Date</th><th className={th}>Party</th><th className={th}>Type</th><th className={thr}>Amount</th><th className={thr}>Balance</th><th className={th}>Ends</th><th className={th} /></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(data?.rows || []).map((r) => (
              <tr key={r._id}>
                <td className={td}>{r.depositNumber}</td><td className={td}>{day(r.date)}</td><td className={td}>{r.partyName}</td>
                <td className={td}>{r.direction === "RECEIVED" ? "Received" : "Given"} · {r.purpose.toLowerCase()}</td>
                <td className={tdr}>{money(r.amount)}</td><td className={tdr}>{money(r.balance)}</td><td className={td}>{day(r.agreementEnd)}</td>
                <td className={td}>
                  {r.balance > 0 ? (
                    move?.id === r._id ? (
                      <div className="flex flex-wrap gap-1">
                        <select className={input} value={move.kind} onChange={(e) => setMove({ ...move, kind: e.target.value })}>{kinds(r.direction).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                        <input className={`${input} w-24`} type="number" value={move.amount} onChange={(e) => setMove({ ...move, amount: e.target.value })} />
                        <input className={input} type="date" value={move.date} onChange={(e) => setMove({ ...move, date: e.target.value })} />
                        <button type="button" className={button} onClick={doMove}>OK</button>
                        <button type="button" className={ghost} onClick={() => setMove(null)}>Close</button>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <button type="button" className={ghost} onClick={() => setMove({ id: r._id, kind: "REFUND", amount: r.balance, date: new Date().toISOString().slice(0, 10) })}>Refund / adjust</button>
                        {!r.movements?.length ? <button type="button" className={ghost} onClick={() => cancel(r)}>Cancel</button> : null}
                      </div>
                    )
                  ) : <span className="text-slate-400">closed</span>}
                </td>
              </tr>
            ))}
            {data && !data.rows.length ? <tr><td className={td} colSpan={8}>No deposits yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ fixed assets

const AssetsPanel = ({ params, fy }) => {
  const [meta, setMeta] = useState(null);
  const [list, setList] = useState([]);
  const [register, setRegister] = useState(null);
  const [blocks, setBlocks] = useState(null);
  const [form, setForm] = useState({ name: "", assetClass: "FURNITURE", source: "PAID", cost: "", purchaseDate: "", putToUseDate: "", leaseEndDate: "", openingDate: "", openingAccumulated: "", openingItWdv: "", expenseId: "", centre: "" });
  const [sell, setSell] = useState(null);
  const [bills, setBills] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    try {
      const [l, r, b] = await Promise.all([getAssetsRequest(params), getAssetRegisterRequest({ ...params, fy }), getItBlocksRequest({ ...params, fy })]);
      setList(l); setRegister(r); setBlocks(b); setError("");
    } catch (err) { setError(errorText(err)); }
  };
  useEffect(() => { getAssetClassesRequest().then(setMeta).catch(() => {}); }, []);
  useEffect(() => {
    if (form.source !== "BILL" || bills.length) return;
    listExpensesRequest({ status: "ACTIVE", limit: 100 }).then((d) => setBills(d?.items || [])).catch(() => setBills([]));
  }, [form.source]);
  useEffect(() => { load(); }, [params.entity, fy]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const create = async () => {
    try { await createAssetRequest(form, params); setForm((f) => ({ ...f, name: "", cost: "", expenseId: "" })); setMessage("Asset added."); await load(); } catch (err) { setError(errorText(err)); }
  };
  const run = async () => {
    if (!window.confirm(`Charge depreciation for FY ${fy}? It is posted on 31 March.`)) return;
    try { const r = await runDepreciationRequest({ fy }, params); setMessage(r.posted ? `Depreciation of ${money(r.total)} posted for ${r.assets.length} asset(s).` : "Nothing left to charge for this year."); await load(); } catch (err) { setError(errorText(err)); }
  };
  const doSell = async () => {
    try { await disposeAssetRequest(sell.id, sell, params); setSell(null); await load(); } catch (err) { setError(errorText(err)); }
  };
  const cancel = async (a) => {
    if (!window.confirm(`Cancel ${a.assetNumber}? Its entry is reversed.`)) return;
    try { await cancelAssetRequest(a._id, params); await load(); } catch (err) { setError(errorText(err)); }
  };
  const classes = meta?.classes || {};
  return (
    <div className="space-y-4">
      <div className={card}>
        <h3 className="text-sm font-bold">Add an asset</h3>
        <p className="mt-1 text-xs text-slate-500">Furniture, fit-out, computers and equipment that last more than a year. If the bill is already entered as an expense, choose "On a bill already entered" and pick it: the amount moves from the expense head to the asset (the bill must belong to the company chosen above).</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input className={input} placeholder="Name" value={form.name} onChange={set("name")} />
          <select className={input} value={form.assetClass} onChange={set("assetClass")} aria-label="Kind">{Object.entries(classes).map(([k, c]) => <option key={k} value={k}>{c.label} ({c.life} yrs)</option>)}</select>
          <select className={input} value={form.source} onChange={set("source")} aria-label="Paid how"><option value="PAID">Paid now (bank)</option><option value="PAYABLE">Owed to the supplier</option><option value="BILL">On a bill already entered</option><option value="OPENING">Owned before (opening)</option></select>
          {form.source === "BILL" ? (
            <select className={`${input} max-w-xs`} value={form.expenseId} onChange={set("expenseId")} aria-label="Bill">
              <option value="">Pick the bill (latest 100)</option>
              {bills.map((b) => <option key={b._id} value={b._id}>{b.expenseNumber} · {new Date(b.expenseDate).toLocaleDateString("en-IN")} · {b.vendorName || b.supplierId?.supplierName || b.category} · {money(b.amountBeforeTax)}</option>)}
            </select>
          ) : null}
          <input className={input} type="number" placeholder={form.source === "BILL" ? "Cost (blank = bill)" : "Cost"} value={form.cost} onChange={set("cost")} />
          <label className="flex items-center gap-1 text-xs text-slate-500">Bought <input className={input} type="date" value={form.purchaseDate} onChange={set("purchaseDate")} /></label>
          <label className="flex items-center gap-1 text-xs text-slate-500">In use from <input className={input} type="date" value={form.putToUseDate} onChange={set("putToUseDate")} /></label>
          {form.assetClass === "FIT_OUT" ? <label className="flex items-center gap-1 text-xs text-slate-500">Lease ends <input className={input} type="date" value={form.leaseEndDate} onChange={set("leaseEndDate")} /></label> : null}
          {form.source === "OPENING" ? (
            <>
              <label className="flex items-center gap-1 text-xs text-slate-500">Books start <input className={input} type="date" value={form.openingDate} onChange={set("openingDate")} /></label>
              <input className={input} type="number" placeholder="Depreciation to date" value={form.openingAccumulated} onChange={set("openingAccumulated")} />
              <input className={input} type="number" placeholder="Tax WDV at start" value={form.openingItWdv} onChange={set("openingItWdv")} />
            </>
          ) : null}
          <input className={input} placeholder="Centre" value={form.centre} onChange={set("centre")} />
          <button type="button" className={button} disabled={!form.name} onClick={create}>Add</button>
        </div>
        {message ? <p className="mt-2 text-xs font-semibold text-emerald-700">{message}</p> : null}
        <Err text={error} />
      </div>

      <div className={`${card} overflow-x-auto`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">Register, FY {fy} (Companies Act)</h3>
          <button type="button" className={button} onClick={run}>Charge depreciation for FY {fy}</button>
        </div>
        {register && !register.depreciationCharged && register.rows.length ? <p className="mt-1 text-xs text-amber-700">Depreciation shown is a preview until it is charged.</p> : null}
        <table className="mt-3 min-w-full divide-y divide-slate-100 dark:divide-slate-800">
          <thead><tr><th className={th}>Asset</th><th className={thr}>Opening</th><th className={thr}>Added</th><th className={thr}>Sold</th><th className={thr}>Depreciation</th><th className={thr}>Net block</th><th className={th} /></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(register?.rows || []).map((r) => {
              const asset = list.find((a) => a.assetNumber === r.assetNumber);
              return (
                <tr key={r.assetNumber}>
                  <td className={td}><b>{r.assetNumber}</b> {r.name}<div className="text-[10px] text-slate-400">{r.classLabel} · in use {day(r.putToUseDate)}{r.note ? ` · ${r.note}` : ""}</div></td>
                  <td className={tdr}>{money(r.grossOpening)}</td><td className={tdr}>{money(r.additions)}</td><td className={tdr}>{money(r.deletions)}</td>
                  <td className={tdr}>{money(r.yearDep)}{r.charged ? "" : " *"}</td><td className={tdr}>{money(r.netClosing)}</td>
                  <td className={td}>
                    {asset?.status === "IN_USE" ? (
                      sell?.id === asset._id ? (
                        <div className="flex flex-wrap gap-1">
                          <input className={input} type="date" value={sell.date} onChange={(e) => setSell({ ...sell, date: e.target.value })} />
                          <input className={`${input} w-24`} type="number" placeholder="Sold for" value={sell.amount} onChange={(e) => setSell({ ...sell, amount: e.target.value })} />
                          <button type="button" className={button} onClick={doSell}>OK</button>
                          <button type="button" className={ghost} onClick={() => setSell(null)}>Close</button>
                        </div>
                      ) : (
                        <div className="flex gap-1">
                          <button type="button" className={ghost} onClick={() => setSell({ id: asset._id, date: new Date().toISOString().slice(0, 10), amount: 0 })}>Sell / discard</button>
                          {!asset.depreciation?.length ? <button type="button" className={ghost} onClick={() => cancel(asset)}>Cancel</button> : null}
                        </div>
                      )
                    ) : <span className="text-slate-400">{asset?.status?.toLowerCase()}</span>}
                  </td>
                </tr>
              );
            })}
            {register ? <tr className="font-bold"><td className={td}>Total</td><td className={tdr}>{money(register.totals.grossOpening)}</td><td className={tdr}>{money(register.totals.additions)}</td><td className={tdr}>{money(register.totals.deletions)}</td><td className={tdr}>{money(register.totals.yearDep)}</td><td className={tdr}>{money(register.totals.netClosing)}</td><td /></tr> : null}
          </tbody>
        </table>
      </div>

      <div className={`${card} overflow-x-auto`}>
        <h3 className="text-sm font-bold">Income-tax depreciation by block, FY {fy} (s.32, WDV)</h3>
        <p className="mt-1 text-xs text-slate-500">Assets put to use for less than 180 days in the year get half the rate. For the tax audit (Form 3CD clause 18); not posted in the books.</p>
        <table className="mt-3 min-w-full divide-y divide-slate-100 dark:divide-slate-800">
          <thead><tr><th className={th}>Block</th><th className={thr}>Opening WDV</th><th className={thr}>Added (180+ days)</th><th className={thr}>Added (under 180)</th><th className={thr}>Sold</th><th className={thr}>Depreciation</th><th className={thr}>Closing WDV</th></tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {(blocks?.blocks || []).map((b) => (
              <tr key={b.rate}><td className={td}>{b.name}</td><td className={tdr}>{money(b.opening)}</td><td className={tdr}>{money(b.addFull)}</td><td className={tdr}>{money(b.addHalf)}</td><td className={tdr}>{money(b.sales)}</td><td className={tdr}>{money(b.depreciation)}</td><td className={tdr}>{money(b.closing)}</td></tr>
            ))}
          </tbody>
        </table>
        <Notes notes={blocks?.notes} />
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ Schedule III

const Lines = ({ title, keys, heads, cur, prev }) => (
  <>
    <tr><td className={`${td} pt-4 font-bold uppercase text-slate-500`} colSpan={3}>{title}</td></tr>
    {keys.filter((k) => cur[k]?.amount || prev[k]?.amount).map((k) => (
      <tr key={k}><td className={td}>{heads[k].label}</td><td className={tdr}>{money(cur[k].amount)}</td><td className={tdr}>{money(prev[k]?.amount || 0)}</td></tr>
    ))}
  </>
);

const ScheduleIIIPanel = ({ params, fy }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { setData(null); getScheduleIIIRequest({ ...params, fy }).then((d) => { setData(d); setError(""); }).catch((err) => setError(errorText(err))); }, [params.entity, fy]);
  if (error) return <div className={card}><Err text={error} /></div>;
  if (!data) return <div className={card}><p className="text-xs text-slate-500">Loading...</p></div>;
  const { current: c, previous: p, heads } = data;
  const bsKeys = (side, group) => Object.keys(heads.bs).filter((k) => heads.bs[k].side === side && heads.bs[k].group === group);
  return (
    <div className="space-y-4">
      <div className={`${card} overflow-x-auto`}>
        <h3 className="text-sm font-bold">Balance sheet as at 31 March 20{fy.slice(3)} (Schedule III)</h3>
        <table className="mt-2 min-w-full">
          <thead><tr><th className={th}>Particulars</th><th className={thr}>FY {fy}</th><th className={thr}>FY {data.previousFy}</th></tr></thead>
          <tbody>
            <tr><td className={`${td} pt-3 font-bold`} colSpan={3}>EQUITY AND LIABILITIES</td></tr>
            {["Shareholders' funds", "Non-current liabilities", "Current liabilities"].map((g) => <Lines key={g} title={g} keys={bsKeys("EL", g)} heads={heads.bs} cur={c.bs} prev={p.bs} />)}
            <tr className="font-bold"><td className={td}>Total</td><td className={tdr}>{money(c.totals.equityAndLiabilities)}</td><td className={tdr}>{money(p.totals.equityAndLiabilities)}</td></tr>
            <tr><td className={`${td} pt-5 font-bold`} colSpan={3}>ASSETS</td></tr>
            {["Non-current assets", "Current assets"].map((g) => <Lines key={g} title={g} keys={bsKeys("A", g)} heads={heads.bs} cur={c.bs} prev={p.bs} />)}
            <tr className="font-bold"><td className={td}>Total</td><td className={tdr}>{money(c.totals.assets)}</td><td className={tdr}>{money(p.totals.assets)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className={`${card} overflow-x-auto`}>
        <h3 className="text-sm font-bold">Statement of profit and loss, FY {fy}</h3>
        <table className="mt-2 min-w-full">
          <thead><tr><th className={th}>Particulars</th><th className={thr}>FY {fy}</th><th className={thr}>FY {data.previousFy}</th></tr></thead>
          <tbody>
            <Lines title="Income" keys={["REVENUE", "OTHER_INCOME"]} heads={heads.pl} cur={c.pl} prev={p.pl} />
            <tr className="font-bold"><td className={td}>Total income</td><td className={tdr}>{money(c.totals.income)}</td><td className={tdr}>{money(p.totals.income)}</td></tr>
            <Lines title="Expenses" keys={["PURCHASES", "EMPLOYEE", "FINANCE", "DEPRECIATION", "OTHER_EXP"]} heads={heads.pl} cur={c.pl} prev={p.pl} />
            <tr className="font-bold"><td className={td}>Total expenses</td><td className={tdr}>{money(c.totals.expenses)}</td><td className={tdr}>{money(p.totals.expenses)}</td></tr>
            <tr className="font-bold"><td className={td}>Profit before tax</td><td className={tdr}>{money(c.totals.profitBeforeTax)}</td><td className={tdr}>{money(p.totals.profitBeforeTax)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={card}>
          <h3 className="text-sm font-bold">Trade receivables ageing (from the due date)</h3>
          <table className="mt-2 min-w-full"><tbody>{c.receivablesAgeing.map((b) => <tr key={b.label}><td className={td}>{b.label}</td><td className={tdr}>{money(b.amount)}</td></tr>)}</tbody></table>
        </div>
        <div className={card}>
          <h3 className="text-sm font-bold">Trade payables ageing (from the bill date)</h3>
          <table className="mt-2 min-w-full">
            <thead><tr><th className={th} /><th className={thr}>MSME</th><th className={thr}>Others</th></tr></thead>
            <tbody>{c.payablesAgeing.mse.map((b, i) => <tr key={b.label}><td className={td}>{b.label}</td><td className={tdr}>{money(b.amount)}</td><td className={tdr}>{money(c.payablesAgeing.others[i].amount)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
      <div className={card}><Notes notes={data.notes} /></div>
    </div>
  );
};

// ------------------------------------------------------------------ MSME

const STATUS_TEXT = { DISALLOWED: "Disallowed this year", PAID_LATE: "Paid late (interest)", PAY_BY_DUE_DATE: "Pay by the due date", PAID_ON_TIME_NEXT_YEAR: "Paid on time after year end", ALLOWED_THIS_YEAR: "Allowed now (disallowed last year)" };
const MsmePanel = ({ params, fy }) => {
  const [rate, setRate] = useState("5.5");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = () => getMsmeReportRequest({ ...params, fy, bankRate: rate }).then((d) => { setData(d); setError(""); }).catch((err) => setError(errorText(err)));
  useEffect(() => { load(); }, [params.entity, fy]);
  return (
    <div className={`${card} overflow-x-auto`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold">MSME 45-day report, FY {fy} (s.43B(h))</h3>
        <label className="flex items-center gap-1 text-xs text-slate-500">RBI bank rate % <input className={`${input} w-20`} value={rate} onChange={(e) => setRate(e.target.value)} /><button type="button" className={ghost} onClick={load}><RefreshCw className="h-3.5 w-3.5" /></button></label>
      </div>
      <p className="mt-1 text-xs text-slate-500">Bills of micro and small suppliers not paid within the agreed days (at most 45; 15 without a written agreement) are allowed as an expense only when paid. Mark suppliers' MSME status in Suppliers.</p>
      {data ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div><p className="text-xs text-slate-500">Disallowed this year</p><p className="text-lg font-bold">{money(data.totals.disallowed)}</p></div>
          <div><p className="text-xs text-slate-500">MSMED interest</p><p className="text-lg font-bold">{money(data.totals.interest)}</p></div>
          <div><p className="text-xs text-slate-500">Pay by the due date to keep the deduction</p><p className="text-lg font-bold">{money(data.totals.payByDueDate)}</p></div>
        </div>
      ) : null}
      <table className="mt-3 min-w-full divide-y divide-slate-100 dark:divide-slate-800">
        <thead><tr><th className={th}>Bill</th><th className={th}>Supplier</th><th className={th}>Due</th><th className={th}>Paid</th><th className={thr}>Amount</th><th className={th}>Status</th><th className={thr}>Interest</th></tr></thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {(data?.rows || []).map((r) => (
            <tr key={`${r.kind}${r.number}`}><td className={td}>{r.number}<div className="text-[10px] text-slate-400">{day(r.date)}</div></td><td className={td}>{r.supplierName}<div className="text-[10px] text-slate-400">{r.msmeType.toLowerCase()} · {r.creditDays} days</div></td><td className={td}>{day(r.dueDate)}</td><td className={td}>{day(r.paidOn)}</td><td className={tdr}>{money(r.amount)}</td><td className={td}>{STATUS_TEXT[r.status]}{r.daysLate ? ` (${r.daysLate} days late)` : ""}</td><td className={tdr}>{money(r.interest)}</td></tr>
          ))}
          {data && !data.rows.length ? <tr><td className={td} colSpan={7}>Nothing to report for micro / small suppliers.</td></tr> : null}
        </tbody>
      </table>
      <Notes notes={data?.notes} /><Err text={error} />
    </div>
  );
};

// ------------------------------------------------------------------ GSTR-9

const TaxRows = ({ rows }) => (
  <table className="mt-2 min-w-full divide-y divide-slate-100 dark:divide-slate-800">
    <thead><tr><th className={th}>Table</th><th className={thr}>Taxable value</th><th className={thr}>IGST</th><th className={thr}>CGST</th><th className={thr}>SGST</th></tr></thead>
    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{Object.entries(rows).map(([k, r]) => <tr key={k}><td className={td}>{r.label}</td><td className={tdr}>{money(r.taxableValue || 0)}</td><td className={tdr}>{r.igst === undefined ? "" : money(r.igst)}</td><td className={tdr}>{r.cgst === undefined ? "" : money(r.cgst)}</td><td className={tdr}>{r.sgst === undefined ? "" : money(r.sgst)}</td></tr>)}</tbody>
  </table>
);
const Hsn = ({ rows }) => (
  <table className="mt-2 min-w-full divide-y divide-slate-100 dark:divide-slate-800">
    <thead><tr><th className={th}>HSN / SAC</th><th className={thr}>Rate</th><th className={thr}>Qty</th><th className={thr}>Taxable value</th><th className={thr}>Tax</th></tr></thead>
    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{rows.map((r) => <tr key={`${r.hsn}${r.rate}`}><td className={td}>{r.hsn}</td><td className={tdr}>{r.rate}%</td><td className={tdr}>{r.quantity}</td><td className={tdr}>{money(r.taxableValue)}</td><td className={tdr}>{money(r.igst + r.cgst + r.sgst)}</td></tr>)}{!rows.length ? <tr><td className={td} colSpan={5}>None.</td></tr> : null}</tbody>
  </table>
);
const Gstr9Panel = ({ params, fy }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { setData(null); getGstr9Request({ ...params, fy }).then((d) => { setData(d); setError(""); }).catch((err) => setError(errorText(err))); }, [params.entity, fy]);
  if (error) return <div className={card}><Err text={error} /></div>;
  if (!data) return <div className={card}><p className="text-xs text-slate-500">Working out the year's returns...</p></div>;
  return (
    <div className="space-y-4">
      <div className={`${card} overflow-x-auto`}><h3 className="text-sm font-bold">GSTR-9, FY {fy} · {data.gstin}</h3><p className="mt-2 text-xs font-bold">Table 4: outward supplies on which tax is payable</p><TaxRows rows={data.table4} /><p className="mt-4 text-xs font-bold">Table 5: supplies on which tax is not payable</p><TaxRows rows={data.table5} /></div>
      <div className={`${card} overflow-x-auto`}><p className="text-xs font-bold">Table 6: input tax credit availed</p><TaxRows rows={data.table6} /></div>
      <div className={`${card} overflow-x-auto`}>
        <p className="text-xs font-bold">Table 9: tax paid</p>
        <table className="mt-2 min-w-full"><thead><tr><th className={th}>Tax</th><th className={thr}>Payable</th><th className={thr}>Paid in cash</th><th className={thr}>Paid through ITC</th></tr></thead><tbody>{data.table9.map((r) => <tr key={r.head}><td className={td}>{r.head}</td><td className={tdr}>{money(r.payable)}</td><td className={tdr}>{money(r.paidInCash)}</td><td className={tdr}>{money(r.paidThroughItc)}</td></tr>)}</tbody></table>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`${card} overflow-x-auto`}><p className="text-xs font-bold">Table 17: HSN summary of outward supplies</p><Hsn rows={data.table17} /></div>
        <div className={`${card} overflow-x-auto`}><p className="text-xs font-bold">Table 18: HSN summary of inward supplies</p><Hsn rows={data.table18} /></div>
      </div>
      <div className={card}><Notes notes={data.notes} /></div>
    </div>
  );
};

// ------------------------------------------------------------------ Tally

const TallyPanel = ({ params, fy }) => {
  const y = 2000 + Number(fy.slice(0, 2));
  const [from, setFrom] = useState(`${y}-04-01`);
  const [to, setTo] = useState(`${y + 1}-03-31`);
  const [error, setError] = useState("");
  useEffect(() => { setFrom(`${y}-04-01`); setTo(`${y + 1}-03-31`); }, [fy]);
  const get = async (part) => {
    try { save(await downloadTallyXml({ ...params, fy, from, to, part }), `tally-${part}-${params.entity}-${from}-to-${to}.xml`, "application/xml"); setError(""); } catch (err) { setError(errorText(err)); }
  };
  return (
    <div className={card}>
      <h3 className="text-sm font-bold">Export to Tally</h3>
      <p className="mt-1 text-xs text-slate-500">Two XML files for TallyPrime / Tally.ERP 9 (Gateway of Tally &gt; Import &gt; Masters, then Vouchers). Import the ledgers first. Customers and suppliers come in as party ledgers under Sundry Debtors / Creditors; every journal entry becomes one voucher (sales, receipt, purchase, payment, credit note or journal) with the same number. Create the company in Tally with the same name first.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input className={input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
        <input className={input} type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        <button type="button" className={ghost} onClick={() => get("masters")}><Download className="h-3.5 w-3.5" /> 1. Ledgers (masters)</button>
        <button type="button" className={button} onClick={() => get("vouchers")}><Download className="h-3.5 w-3.5" /> 2. Vouchers</button>
      </div>
      <Err text={error} />
    </div>
  );
};

// ------------------------------------------------------------------ tab

const VIEWS = [["deposits", "Deposits"], ["assets", "Fixed assets"], ["schedule3", "Schedule III"], ["msme", "MSME 45-day"], ["gstr9", "GSTR-9"], ["tally", "Tally export"]];

const YearEndTab = ({ selectedEntity }) => {
  const choices = fyChoices();
  const [fy, setFy] = useState(choices[1]);
  const [view, setView] = useState("deposits");
  if (selectedEntity === "all") return <div className={card}><p className="text-sm">Pick TOOR or Goldhawk above: year-end work is kept per company.</p></div>;
  const params = { entity: selectedEntity };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map(([k, l]) => <button key={k} type="button" className={view === k ? button : ghost} onClick={() => setView(k)}>{l}</button>)}
        {view !== "deposits" ? <select className={`${input} ml-auto`} value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Financial year">{choices.map((c) => <option key={c} value={c}>FY 20{c}</option>)}</select> : null}
      </div>
      {view === "deposits" ? <DepositsPanel params={params} /> : null}
      {view === "assets" ? <AssetsPanel params={params} fy={fy} /> : null}
      {view === "schedule3" ? <ScheduleIIIPanel params={params} fy={fy} /> : null}
      {view === "msme" ? <MsmePanel params={params} fy={fy} /> : null}
      {view === "gstr9" ? <Gstr9Panel params={params} fy={fy} /> : null}
      {view === "tally" ? <TallyPanel params={params} fy={fy} /> : null}
    </div>
  );
};

export default YearEndTab;
