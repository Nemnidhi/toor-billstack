// Year end (phase 5): Schedule III statements with the previous year, receivable / payable
// ageing, the MSME 45-day report (s.43B(h)), GSTR-9 tables and a Tally XML export.
const mongoose = require("mongoose");
const AppError = require("../utils/appError");
const Account = require("../models/Account");
const Business = require("../models/Business");
const JournalEntry = require("../models/JournalEntry");
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const Customer = require("../models/Customer");
const Expense = require("../models/Expense");
const Purchase = require("../models/Purchase");
const Payment = require("../models/Payment");
const PaymentAllocation = require("../models/PaymentAllocation");
const PaymentAllocationReversal = require("../models/PaymentAllocationReversal");
const Supplier = require("../models/Supplier");
const Deposit = require("../models/Deposit");
const FixedAsset = require("../models/FixedAsset");
const { fyBounds, assetRegister } = require("./fixed-asset.service");

const DAY = 86400000;
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const prevFy = (fy) => `${String(Number(fy.slice(0, 2)) - 1).padStart(2, "0")}-${String(Number(fy.slice(3)) - 1).padStart(2, "0")}`;
const fyDates = (fy) => {
  const y = 2000 + Number(fy.slice(0, 2));
  return { from: new Date(`${y}-04-01T00:00:00+05:30`), to: new Date(`${y + 1}-03-31T23:59:59.999+05:30`), fromText: `${y}-04-01`, toText: `${y + 1}-03-31` };
};
const idOf = (v) => String(v?._id || v || "");

// ------------------------------------------------------------------ balances

const balancesBetween = async ({ businessId, from, to }) => {
  const match = { businessId: oid(businessId), status: "POSTED", entryDate: { $lte: to } };
  if (from) match.entryDate.$gte = from;
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: "$lines" },
    { $group: { _id: "$lines.accountCode", dr: { $sum: "$lines.debitMinor" }, cr: { $sum: "$lines.creditMinor" }, name: { $first: "$lines.accountName" } } },
  ]);
  return new Map(rows.map((r) => [r._id, { code: r._id, name: r.name, dr: r.dr / 100, cr: r.cr / 100 }]));
};

// ------------------------------------------------------------------ Schedule III

// Where each account goes in Schedule III (Division I). Unknown accounts fall back by type.
const BS_HEADS = {
  SHARE_CAPITAL: { side: "EL", group: "Shareholders' funds", label: "Share capital / owners' capital" },
  RESERVES: { side: "EL", group: "Shareholders' funds", label: "Reserves and surplus" },
  LT_OTHER: { side: "EL", group: "Non-current liabilities", label: "Other long-term liabilities (security deposits received)" },
  ST_BORROWINGS: { side: "EL", group: "Current liabilities", label: "Short-term borrowings (bank overdraft)" },
  TRADE_PAYABLES_MSE: { side: "EL", group: "Current liabilities", label: "Trade payables: micro and small enterprises" },
  TRADE_PAYABLES: { side: "EL", group: "Current liabilities", label: "Trade payables: others" },
  OTHER_CL: { side: "EL", group: "Current liabilities", label: "Other current liabilities (advances, GST, TDS, salaries and payroll dues)" },
  PPE: { side: "A", group: "Non-current assets", label: "Property, plant and equipment (net block)" },
  LT_LOANS: { side: "A", group: "Non-current assets", label: "Long-term loans and advances (security deposits given)" },
  TRADE_RECEIVABLES: { side: "A", group: "Current assets", label: "Trade receivables" },
  CASH: { side: "A", group: "Current assets", label: "Cash and cash equivalents" },
  ST_LOANS: { side: "A", group: "Current assets", label: "Short-term loans and advances (supplier and staff advances, TDS, GST credit)" },
  OTHER_CA: { side: "A", group: "Current assets", label: "Other current assets" },
};
const PL_HEADS = {
  REVENUE: { label: "Revenue from operations", income: true },
  OTHER_INCOME: { label: "Other income", income: true },
  PURCHASES: { label: "Purchases of stock-in-trade" },
  EMPLOYEE: { label: "Employee benefits expense" },
  FINANCE: { label: "Finance costs (interest)" },
  DEPRECIATION: { label: "Depreciation and amortisation expense" },
  OTHER_EXP: { label: "Other expenses" },
};

const bsHeadOf = (code, type) => {
  if (code === "3010") return "SHARE_CAPITAL";
  if (type === "EQUITY") return "RESERVES";
  if (code === "2410") return "LT_OTHER";
  if (code === "2010") return "TRADE_PAYABLES";
  if (type === "LIABILITY") return "OTHER_CL";
  if (code === "1510" || code === "1590") return "PPE";
  if (code === "1210") return "LT_LOANS";
  if (code === "1100") return "TRADE_RECEIVABLES";
  if (/^10\d\d/.test(code)) return "CASH";
  if (code === "1150" || code === "1160" || code === "1410" || /^13\d\d/.test(code)) return "ST_LOANS";
  return "OTHER_CA";
};
const plHeadOf = (code, type) => {
  if (type === "INCOME") return ["4010", "4020", "4030", "4090"].includes(code) ? "REVENUE" : "OTHER_INCOME";
  if (code === "5100") return "PURCHASES";
  if (code === "5050" || code === "5055") return "EMPLOYEE";
  if (code === "5180") return "FINANCE";
  if (code === "5200") return "DEPRECIATION";
  return "OTHER_EXP";
};

// what is owed to micro / small suppliers on a day (bill balances as they stood then)
const payablesOn = async ({ businessId, cut }) => {
  const suppliers = new Map((await Supplier.find({ businessId }).select("supplierName msmeType msmeTrader msmeCreditDays").lean()).map((s) => [String(s._id), s]));
  const expenses = await Expense.find({ businessId, status: { $ne: "CANCELLED" }, expenseDate: { $lte: cut } }).lean();
  const purchases = await Purchase.find({ businessId, purchaseDate: { $lte: cut } }).lean();
  const allocs = await PaymentAllocation.find({ businessId, purchaseId: { $in: purchases.map((p) => p._id) } }).lean();
  const pays = new Map((await Payment.find({ _id: { $in: allocs.map((a) => a.paymentId) } }).select("paymentDate status").lean()).map((p) => [String(p._id), p]));
  const reversed = new Set((await PaymentAllocationReversal.find({ businessId, allocationId: { $in: allocs.map((a) => a._id) }, createdAt: { $lte: cut } }).select("allocationId").lean()).map((r) => String(r.allocationId)));
  const bills = [];
  for (const e of expenses) {
    const payable = round2(Number(e.totalAmount || 0) - Number(e.tdsAmount || 0));
    const paidBy = e.paidOn ? new Date(e.paidOn) : e.balanceAmount <= 0.004 ? new Date(e.updatedAt) : null;
    const open = paidBy && paidBy <= cut ? 0 : e.balanceAmount > 0.004 ? Number(e.balanceAmount) : payable;
    bills.push({ kind: "EXPENSE", id: e._id, number: e.supplierInvoiceNumber || e.expenseNumber, date: e.supplierInvoiceDate || e.expenseDate, supplier: suppliers.get(idOf(e.supplierId)) || null, partyName: suppliers.get(idOf(e.supplierId))?.supplierName || e.vendorName || "", amount: payable, open: round2(open), paidOn: paidBy });
  }
  for (const p of purchases) {
    const mine = allocs.filter((a) => String(a.purchaseId) === String(p._id) && !reversed.has(String(a._id)));
    let paid = 0;
    let lastPaid = null;
    for (const a of mine) {
      const pay = pays.get(String(a.paymentId));
      const when = pay?.paymentDate || a.createdAt;
      if (new Date(when) <= cut) { paid += a.allocatedAmount; if (!lastPaid || new Date(when) > lastPaid) lastPaid = new Date(when); }
    }
    const total = Number(p.totalAmount || 0);
    const open = round2(Math.max(0, total - paid));
    bills.push({ kind: "PURCHASE", id: p._id, number: p.supplierInvoiceNumber || p.purchaseNumber || String(p._id).slice(-6), date: p.supplierInvoiceDate || p.purchaseDate, supplier: suppliers.get(idOf(p.supplierId)) || null, partyName: suppliers.get(idOf(p.supplierId))?.supplierName || "", amount: total, open, paidOn: open <= 0.004 ? lastPaid : null });
  }
  return bills;
};
const isMse = (s) => Boolean(s && ["MICRO", "SMALL"].includes(s.msmeType));

const receivablesOn = async ({ businessId, cut }) => {
  const invoices = await Invoice.find({ businessId, status: "issued", invoiceDate: { $lte: cut } }).select("invoiceNumber invoiceDate dueDate grandTotal customerId customerDetails").lean();
  const ids = invoices.map((i) => i._id);
  const allocs = await PaymentAllocation.find({ businessId, invoiceId: { $in: ids } }).lean();
  const pays = new Map((await Payment.find({ _id: { $in: allocs.map((a) => a.paymentId) } }).select("paymentDate").lean()).map((p) => [String(p._id), p]));
  const revs = await PaymentAllocationReversal.find({ businessId, allocationId: { $in: allocs.map((a) => a._id) }, createdAt: { $lte: cut } }).lean();
  const notes = await CreditNote.find({ businessId, invoiceId: { $in: ids }, status: "ISSUED", createdAt: { $lte: cut } }).select("invoiceId totalAmount").lean();
  const settled = new Map();
  const bump = (id, v) => settled.set(String(id), (settled.get(String(id)) || 0) + v);
  for (const a of allocs) if (new Date(pays.get(String(a.paymentId))?.paymentDate || a.createdAt) <= cut) bump(a.invoiceId, a.allocatedAmount);
  const allocById = new Map(allocs.map((a) => [String(a._id), a]));
  for (const r of revs) { const a = allocById.get(String(r.allocationId)); if (a) bump(a.invoiceId, -r.amount); }
  for (const n of notes) bump(n.invoiceId, n.totalAmount);
  return invoices.map((i) => ({ number: i.invoiceNumber, date: i.invoiceDate, dueDate: i.dueDate, partyName: i.customerDetails?.name || "", open: round2(Math.max(0, i.grandTotal - (settled.get(String(i._id)) || 0))) })).filter((r) => r.open > 0.004);
};

// Schedule III ageing buckets (from the due date for receivables, the bill date for payables)
const ageing = (rows, cut, dateKey, buckets) => {
  const out = buckets.map((b) => ({ ...b, amount: 0 }));
  for (const r of rows) {
    const days = Math.floor((cut - new Date(r[dateKey] || r.date)) / DAY);
    const b = out.find((x) => days < x.maxDays) || out[out.length - 1];
    b.amount = round2(b.amount + r.open);
  }
  return out;
};
const RECEIVABLE_BUCKETS = [{ label: "Not due / less than 6 months", maxDays: 183 }, { label: "6 months - 1 year", maxDays: 366 }, { label: "1-2 years", maxDays: 731 }, { label: "2-3 years", maxDays: 1096 }, { label: "More than 3 years", maxDays: Infinity }];
const PAYABLE_BUCKETS = [{ label: "Less than 1 year", maxDays: 366 }, { label: "1-2 years", maxDays: 731 }, { label: "2-3 years", maxDays: 1096 }, { label: "More than 3 years", maxDays: Infinity }];

const statementsFor = async ({ businessId, fy, accounts }) => {
  const d = fyDates(fy);
  const [cumulative, year] = await Promise.all([balancesBetween({ businessId, to: d.to }), balancesBetween({ businessId, from: d.from, to: d.to })]);
  const typeOf = (code) => accounts.get(code)?.type || (code.startsWith("1") ? "ASSET" : code.startsWith("2") ? "LIABILITY" : code.startsWith("3") ? "EQUITY" : code.startsWith("4") ? "INCOME" : "EXPENSE");

  const bs = Object.fromEntries(Object.keys(BS_HEADS).map((k) => [k, { amount: 0, accounts: [] }]));
  let surplus = 0;
  for (const row of cumulative.values()) {
    const type = typeOf(row.code);
    if (type === "INCOME") { surplus += row.cr - row.dr; continue; }
    if (type === "EXPENSE") { surplus -= row.dr - row.cr; continue; }
    let head = bsHeadOf(row.code, type);
    let value = ["ASSET"].includes(type) ? row.dr - row.cr : row.cr - row.dr;
    if (head === "CASH" && value < 0) { head = "ST_BORROWINGS"; value = -value; }
    if (Math.abs(value) < 0.005) continue;
    bs[head].amount = round2(bs[head].amount + value);
    bs[head].accounts.push({ code: row.code, name: accounts.get(row.code)?.name || row.name, amount: round2(value) });
  }
  bs.RESERVES.amount = round2(bs.RESERVES.amount + surplus);
  bs.RESERVES.accounts.push({ code: "", name: "Surplus in profit and loss (to date)", amount: round2(surplus) });

  // trade payables: micro and small enterprises shown apart (Schedule III, MSMED Act s.22)
  const bills = await payablesOn({ businessId, cut: d.to });
  const mseOpen = round2(bills.filter((b) => isMse(b.supplier)).reduce((s, b) => s + b.open, 0));
  const move = Math.min(mseOpen, Math.max(0, bs.TRADE_PAYABLES.amount));
  bs.TRADE_PAYABLES_MSE.amount = round2(move);
  bs.TRADE_PAYABLES.amount = round2(bs.TRADE_PAYABLES.amount - move);

  const pl = Object.fromEntries(Object.keys(PL_HEADS).map((k) => [k, { amount: 0, accounts: [] }]));
  for (const row of year.values()) {
    const type = typeOf(row.code);
    if (type !== "INCOME" && type !== "EXPENSE") continue;
    const head = plHeadOf(row.code, type);
    const value = type === "INCOME" ? row.cr - row.dr : row.dr - row.cr;
    if (Math.abs(value) < 0.005) continue;
    pl[head].amount = round2(pl[head].amount + value);
    pl[head].accounts.push({ code: row.code, name: accounts.get(row.code)?.name || row.name, amount: round2(value) });
  }
  const income = round2(pl.REVENUE.amount + pl.OTHER_INCOME.amount);
  const expenses = round2(["PURCHASES", "EMPLOYEE", "FINANCE", "DEPRECIATION", "OTHER_EXP"].reduce((s, k) => s + pl[k].amount, 0));
  const totalA = round2(Object.entries(bs).filter(([k]) => BS_HEADS[k].side === "A").reduce((s, [, v]) => s + v.amount, 0));
  const totalEL = round2(Object.entries(bs).filter(([k]) => BS_HEADS[k].side === "EL").reduce((s, [, v]) => s + v.amount, 0));
  const receivables = await receivablesOn({ businessId, cut: d.to });
  return {
    fy, asOn: d.toText, bs, pl, totals: { assets: totalA, equityAndLiabilities: totalEL, difference: round2(totalA - totalEL), income, expenses, profitBeforeTax: round2(income - expenses) },
    receivablesAgeing: ageing(receivables, d.to, "dueDate", RECEIVABLE_BUCKETS),
    payablesAgeing: { mse: ageing(bills.filter((b) => b.open > 0 && isMse(b.supplier)), d.to, "date", PAYABLE_BUCKETS), others: ageing(bills.filter((b) => b.open > 0 && !isMse(b.supplier)), d.to, "date", PAYABLE_BUCKETS) },
  };
};

const scheduleIII = async ({ businessId, fy }) => {
  fyBounds(fy);
  const business = await Business.findById(businessId).select("name gstConfiguration").lean();
  if (!business) throw new AppError("Business not found", 404);
  const accounts = new Map((await Account.find({ businessId }).lean()).map((a) => [a.code, a]));
  const [current, previous, ppe] = await Promise.all([statementsFor({ businessId, fy, accounts }), statementsFor({ businessId, fy: prevFy(fy), accounts }), assetRegister({ businessId, fy })]);
  const notes = [];
  if (Math.abs(current.totals.difference) > 1) notes.push(`The balance sheet is off by ${current.totals.difference}: check the trial balance for unposted or one-sided entries.`);
  if (ppe.rows.length && !ppe.depreciationCharged) notes.push(`Depreciation for FY ${fy} is not charged yet; the net block and profit do not include it.`);
  notes.push("Tax expense (current and deferred) is not worked out here; the CA adds it.");
  return { businessName: business.name, fy, previousFy: prevFy(fy), heads: { bs: BS_HEADS, pl: PL_HEADS }, current, previous, ppeNote: ppe.classes, notes };
};

// ------------------------------------------------------------------ MSME 45-day (s.43B(h))

// Due date under MSMED Act s.15: the agreed credit days (in writing, at most 45), else 15 days.
const msmeDueDate = (bill) => new Date(new Date(bill.date).getTime() + (bill.supplier?.msmeCreditDays > 0 ? Math.min(45, bill.supplier.msmeCreditDays) : 15) * DAY);

const msmeReport = async ({ businessId, fy, bankRate = 5.5 }) => {
  const d = fyDates(fy);
  const all = await payablesOn({ businessId, cut: new Date() });
  const bills = all.filter((b) => isMse(b.supplier) && !b.supplier.msmeTrader);
  const interestOf = (amount, from, to) => {
    // MSMED Act s.16: compound interest with monthly rests at three times the RBI bank rate
    const days = Math.max(0, Math.floor((to - from) / DAY));
    const monthly = (3 * bankRate) / 100 / 12;
    return round2(amount * (Math.pow(1 + monthly, days / 30.4375) - 1));
  };
  const rows = [];
  for (const b of bills) {
    const due = msmeDueDate(b);
    const inYear = new Date(b.date) >= d.from && new Date(b.date) <= d.to;
    const paidOn = b.paidOn ? new Date(b.paidOn) : null;
    const base = { kind: b.kind, number: b.number, date: b.date, supplierName: b.partyName, msmeType: b.supplier.msmeType, creditDays: b.supplier.msmeCreditDays || 15, dueDate: due, amount: b.amount, paidOn };
    if (inYear) {
      if (paidOn && paidOn <= d.to) {
        if (paidOn > due) rows.push({ ...base, status: "PAID_LATE", daysLate: Math.floor((paidOn - due) / DAY), disallowed: 0, interest: interestOf(b.amount, due, paidOn) });
        continue;
      }
      // unpaid at the year end
      const unpaid = paidOn ? b.amount : b.open;
      if (due <= d.to || (paidOn && paidOn > due) || (!paidOn && new Date() > due)) rows.push({ ...base, status: "DISALLOWED", daysLate: Math.floor(((paidOn || new Date()) - due) / DAY), disallowed: unpaid, interest: interestOf(unpaid, due, paidOn || new Date()) });
      else rows.push({ ...base, status: paidOn ? "PAID_ON_TIME_NEXT_YEAR" : "PAY_BY_DUE_DATE", daysLate: 0, disallowed: 0, interest: 0, payBy: due });
    } else if (new Date(b.date) < d.from && paidOn && paidOn >= d.from && paidOn <= d.to && paidOn > due) {
      // disallowed last year, paid this year: allowed now
      rows.push({ ...base, status: "ALLOWED_THIS_YEAR", daysLate: Math.floor((paidOn - due) / DAY), disallowed: -b.amount, interest: interestOf(b.amount, due, paidOn) });
    }
  }
  const sum = (status, key) => round2(rows.filter((r) => !status || r.status === status).reduce((s, r) => s + (r[key] || 0), 0));
  const missing = await Supplier.countDocuments({ businessId, msmeType: "" });
  return {
    fy, bankRate,
    rows: rows.sort((a, b) => new Date(a.date) - new Date(b.date)),
    totals: { disallowed: sum("DISALLOWED", "disallowed"), allowedThisYear: -sum("ALLOWED_THIS_YEAR", "disallowed"), interest: sum(null, "interest"), payByDueDate: round2(rows.filter((r) => r.status === "PAY_BY_DUE_DATE").reduce((s, r) => s + r.amount, 0)) },
    notes: [
      "Only suppliers marked Micro or Small (Udyam) and not traders are covered by s.43B(h); medium enterprises are not.",
      missing ? `${missing} supplier(s) have no MSME status set; ask them for their Udyam certificate.` : "",
      "Interest under MSMED Act s.16 is not deductible (s.23) and must be shown in the MSME note to the accounts.",
      `Interest uses three times the RBI bank rate of ${bankRate}% (change it to the rate in force).`,
    ].filter(Boolean),
  };
};

// ------------------------------------------------------------------ GSTR-9

const gstr9 = async ({ businessId, fy }) => {
  const { buildGstr1 } = require("./gstr1.service");
  const gstIn = require("./gst-input.service");
  const d = fyDates(fy);
  const business = await Business.findById(businessId).lean();
  if (!business?.gstConfiguration?.enabled) throw new AppError("GST is not switched on for this company", 400);
  const out = await buildGstr1({ businessId, from: d.fromText, to: d.toText });
  const z = () => ({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });
  const add = (a, r, sign = 1) => ({ taxableValue: round2(a.taxableValue + sign * Number(r.taxableValue || 0)), igst: round2(a.igst + sign * Number(r.igst || 0)), cgst: round2(a.cgst + sign * Number(r.cgst || 0)), sgst: round2(a.sgst + sign * Number(r.sgst || 0)) });
  const total = (rows, sign = 1) => rows.reduce((a, r) => add(a, r, sign), z());

  const bills = await gstIn.bookBills({ businessId, from: d.from, to: d.to });
  const rcm = bills.filter((b) => b.reverseCharge);
  const t4 = {
    A: { label: "4A Supplies made to unregistered persons (B2C)", ...add(total(out.b2cl), total(out.b2cs)) },
    B: { label: "4B Supplies made to registered persons (B2B)", ...total(out.b2b) },
    C: { label: "4C Zero rated supply (export) on payment of tax", ...z() },
    D: { label: "4D Supply to SEZs on payment of tax", ...z() },
    E: { label: "4E Deemed exports", ...z() },
    F: { label: "4F Advances on which tax was paid but invoice not issued", ...z() },
    G: { label: "4G Inward supplies on which tax is paid on reverse charge", ...total(rcm) },
  };
  t4.H = { label: "4H Sub-total (A to G)", ...["A", "B", "C", "D", "E", "F", "G"].reduce((a, k) => add(a, t4[k]), z()) };
  t4.I = { label: "4I Credit notes issued (B2B and large B2C)", ...total([...out.cdnr, ...out.cdnur]) };
  t4.J = { label: "4J Debit notes issued", ...z() };
  t4.N = { label: "4N Supplies and advances on which tax is to be paid (H - I + J)", ...add(t4.H, t4.I, -1) };

  const ex = Object.values(out.exemp || {});
  const exSum = (key) => round2(ex.reduce((s, r) => s + Number(r[key] || 0), 0));
  const t5 = {
    D: { label: "5D Exempted", taxableValue: exSum("exempt") },
    E: { label: "5E Nil rated", taxableValue: exSum("nil") },
    F: { label: "5F Non-GST supply", taxableValue: exSum("nonGst") },
  };
  t5.N = { label: "5N Total turnover (4N + 5D to 5F)", taxableValue: round2(t4.N.taxableValue + t5.D.taxableValue + t5.E.taxableValue + t5.F.taxableValue) };

  // ITC: what the monthly GSTR-3B returns claimed (built the same way), and the books split by kind
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const m = new Date(Date.UTC(2000 + Number(fy.slice(0, 2)), 3 + i, 1));
    months.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  let claimed = z();
  const liability = { igst: 0, cgst: 0, sgst: 0 };
  const cash = { igst: 0, cgst: 0, sgst: 0 };
  const fromCredit = { igst: 0, cgst: 0, sgst: 0 };
  for (const month of months) {
    const r = await gstIn.gstr3b({ businessId, month });
    claimed = add(claimed, r.table4.a3);
    claimed = add(claimed, r.table4.a5);
    for (const h of ["igst", "cgst", "sgst"]) {
      liability[h] = round2(liability[h] + Number(r.payment.liability[h] || 0) + Number(r.payment.reverseChargeCash[h] || 0));
      cash[h] = round2(cash[h] + Number(r.payment.cash[h] || 0));
      fromCredit[h] = round2(fromCredit[h] + Number(r.payment.liability[h] || 0) - Number(r.payment.cashFromCredit[h] || 0));
    }
  }
  const eligible = bills.filter((b) => b.itcEligible && !b.reverseCharge);
  const assetBills = new Set((await FixedAsset.find({ businessId, status: { $ne: "CANCELLED" }, expenseId: { $ne: null } }).select("expenseId").lean()).map((a) => String(a.expenseId)));
  const capital = eligible.filter((b) => assetBills.has(String(b.sourceId)));
  const inputs = eligible.filter((b) => b.sourceType === "PURCHASE" && !assetBills.has(String(b.sourceId)));
  const services = eligible.filter((b) => b.sourceType === "EXPENSE" && !assetBills.has(String(b.sourceId)));
  const rcmEligible = rcm.filter((b) => b.itcEligible);
  const t6 = {
    A: { label: "6A Total ITC availed through GSTR-3B (4A)", ...claimed },
    B_inputs: { label: "6B Inward supplies (other than imports and reverse charge): inputs", ...total(inputs) },
    B_capital: { label: "6B ... capital goods", ...total(capital) },
    B_services: { label: "6B ... input services", ...total(services) },
    C: { label: "6C Reverse charge from unregistered persons", ...total(rcmEligible.filter((b) => !b.supplierGstin)) },
    D: { label: "6D Reverse charge from registered persons", ...total(rcmEligible.filter((b) => b.supplierGstin)) },
  };
  t6.I = { label: "6I Sub-total (B to H)", ...["B_inputs", "B_capital", "B_services", "C", "D"].reduce((a, k) => add(a, t6[k]), z()) };
  t6.J = { label: "6J Difference (A - I)", ...add(t6.A, t6.I, -1) };

  const t9 = ["igst", "cgst", "sgst"].map((h) => ({ head: h.toUpperCase(), payable: liability[h], paidInCash: cash[h], paidThroughItc: fromCredit[h] }));

  // HSN: outward from GSTR-1 (B2B and B2C together), inward from purchase lines with an HSN
  const hsnOut = new Map();
  for (const r of [...(out.hsnB2B || []), ...(out.hsnB2C || [])]) {
    const k = `${r.hsn}|${r.rate}`;
    const cur = hsnOut.get(k) || { hsn: r.hsn, description: r.description || "", uqc: r.uqc || "NA", rate: r.rate, quantity: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };
    for (const f of ["quantity", "taxableValue", "igst", "cgst", "sgst"]) cur[f] = round2(cur[f] + Number(r[f] || 0));
    hsnOut.set(k, cur);
  }
  const purchases = await Purchase.find({ businessId, purchaseDate: { $gte: d.from, $lte: d.to }, gstSnapshot: { $ne: null } }).lean();
  const hsnIn = new Map();
  let inwardWithoutHsn = 0;
  for (const p of purchases) {
    (p.gstSnapshot?.lines || []).forEach((l, i) => {
      const hsn = String(l.hsnSac || l.hsn || p.productsPurchased?.[i]?.hsnSac || p.productsPurchased?.[i]?.hsn || "").trim();
      if (!hsn) { inwardWithoutHsn += Number(l.taxableValue || 0); return; }
      const k = `${hsn}|${l.rate}`;
      const cur = hsnIn.get(k) || { hsn, rate: Number(l.rate || 0), quantity: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };
      cur.quantity = round2(cur.quantity + Number(p.productsPurchased?.[i]?.quantity || 0));
      for (const f of ["taxableValue", "igst", "cgst", "sgst"]) cur[f] = round2(cur[f] + Number(l[f] || 0));
      hsnIn.set(k, cur);
    });
  }
  const expensesWithGst = bills.filter((b) => b.sourceType === "EXPENSE").reduce((s, b) => s + Number(b.taxableValue || 0), 0);
  const turnover = t5.N.taxableValue;
  return {
    fy, gstin: out.gstin, businessName: business.name,
    table4: t4, table5: t5, table6: t6, table9: t9,
    table17: [...hsnOut.values()].sort((a, b) => a.hsn.localeCompare(b.hsn)),
    table18: [...hsnIn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn)),
    notes: [
      turnover <= 20000000 ? "Turnover is up to Rs 2 crore: GSTR-9 is optional for the year (CA to confirm)." : "",
      "Table 4: small B2C credit notes are already netted in 4A (as in GSTR-1); 4I has the B2B and large B2C credit notes.",
      "Table 6A is rebuilt from the monthly GSTR-3B working here; if a filed return differs, use the filed figure.",
      expensesWithGst > 0 ? `Table 18: expense bills carry no HSN / SAC (Rs ${round2(expensesWithGst + inwardWithoutHsn)} of inward supplies); HSN for inward supplies is optional below Rs 5 crore turnover.` : "",
      "Tables 7 (ITC reversed), 8 (ITC as per GSTR-2B vs 3B), 10-14 (next-year amendments) and 15-16 are filled by the CA from the portal.",
    ].filter(Boolean),
  };
};

// ------------------------------------------------------------------ Tally XML

const TALLY_GROUP = (code, type) => {
  if (code === "1010") return "Cash-in-Hand";
  if (/^10\d\d/.test(code)) return "Bank Accounts";
  if (code === "1100") return "Sundry Debtors";
  if (code === "2010") return "Sundry Creditors";
  if (/^1[34]\d\d/.test(code) || /^22\d\d/.test(code) || code === "2310") return "Duties & Taxes";
  if (code === "1510" || code === "1590") return "Fixed Assets";
  if (code === "1150" || code === "1210") return "Loans & Advances (Asset)";
  if (code === "3010") return "Capital Account";
  if (code === "5100") return "Purchase Accounts";
  if (type === "INCOME") return ["4010", "4020", "4030", "4090"].includes(code) ? "Sales Accounts" : "Indirect Incomes";
  if (type === "EXPENSE") return "Indirect Expenses";
  if (type === "LIABILITY") return "Current Liabilities";
  if (type === "EQUITY") return "Capital Account";
  return "Current Assets";
};
const VOUCHER_TYPE = { INVOICE: "Sales", PAYMENT: "Receipt", PURCHASE: "Purchase", EXPENSE: "Purchase", TDS_CHALLAN: "Payment", CREDIT_NOTE: "Credit Note", SALES_RETURN: "Credit Note" };
const xml = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const tallyDate = (d) => new Date(new Date(d).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, "");

const tallyXml = async ({ businessId, from, to }) => {
  const business = await Business.findById(businessId).select("name").lean();
  if (!business) throw new AppError("Business not found", 404);
  const start = new Date(`${from}T00:00:00+05:30`);
  const end = new Date(`${to}T23:59:59.999+05:30`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw new AppError("Choose a from / to date", 400);
  const accounts = new Map((await Account.find({ businessId }).lean()).map((a) => [a.code, a]));
  const entries = await JournalEntry.find({ businessId, status: "POSTED", entryDate: { $gte: start, $lte: end } }).sort({ entryDate: 1, createdAt: 1 }).lean();

  // party ledgers for receivable / payable lines, from the record behind each entry
  const ids = (type) => entries.filter((e) => e.sourceType === type && e.sourceId).map((e) => e.sourceId);
  const [invoices, payments, notes, expenses, purchases, deposits] = await Promise.all([
    Invoice.find({ _id: { $in: ids("INVOICE") } }).select("customerId customerDetails invoiceNumber").lean(),
    Payment.find({ _id: { $in: [...ids("PAYMENT"), ...ids("PAYMENT_ALLOCATION")] } }).select("customerId supplierId referenceNumber").lean(),
    CreditNote.find({ _id: { $in: [...ids("CREDIT_NOTE"), ...ids("SALES_RETURN")] } }).select("customerId creditNoteNumber").lean(),
    Expense.find({ _id: { $in: ids("EXPENSE") } }).select("supplierId vendorName expenseNumber supplierInvoiceNumber").lean(),
    Purchase.find({ _id: { $in: ids("PURCHASE") } }).select("supplierId supplierInvoiceNumber").lean(),
    Deposit.find({ _id: { $in: ids("DEPOSIT") } }).select("partyName depositNumber").lean(),
  ]);
  const customerIds = [...invoices.map((i) => i.customerId), ...payments.map((p) => p.customerId), ...notes.map((n) => n.customerId)].filter(Boolean);
  const supplierIds = [...payments.map((p) => p.supplierId), ...expenses.map((e) => e.supplierId), ...purchases.map((p) => p.supplierId)].filter(Boolean);
  const customers = new Map((await Customer.find({ _id: { $in: customerIds } }).select("name").lean()).map((c) => [String(c._id), c.name]));
  const suppliers = new Map((await Supplier.find({ _id: { $in: supplierIds } }).select("supplierName").lean()).map((s) => [String(s._id), s.supplierName]));
  const party = new Map();
  for (const i of invoices) party.set(String(i._id), { debtor: customers.get(idOf(i.customerId)) || i.customerDetails?.name, ref: i.invoiceNumber });
  for (const p of payments) party.set(String(p._id), { debtor: customers.get(idOf(p.customerId)), creditor: suppliers.get(idOf(p.supplierId)), ref: p.referenceNumber });
  for (const n of notes) party.set(String(n._id), { debtor: customers.get(idOf(n.customerId)), ref: n.creditNoteNumber });
  for (const e of expenses) party.set(String(e._id), { creditor: suppliers.get(idOf(e.supplierId)) || e.vendorName, ref: e.supplierInvoiceNumber || e.expenseNumber });
  for (const p of purchases) party.set(String(p._id), { creditor: suppliers.get(idOf(p.supplierId)), ref: p.supplierInvoiceNumber });
  for (const dpt of deposits) party.set(String(dpt._id), { ref: dpt.depositNumber });

  const ledgers = new Map(); // name -> group
  const ledgerFor = (line, entry) => {
    const p = party.get(idOf(entry.sourceId)) || {};
    if ((line.accountCode === "1100" || line.accountCode === "2100") && p.debtor) { ledgers.set(p.debtor, "Sundry Debtors"); return p.debtor; }
    if ((line.accountCode === "2010" || line.accountCode === "1150") && p.creditor) { ledgers.set(p.creditor, "Sundry Creditors"); return p.creditor; }
    const acc = accounts.get(line.accountCode);
    const name = acc?.name || line.accountName;
    ledgers.set(name, TALLY_GROUP(line.accountCode, acc?.type));
    return name;
  };

  const vouchers = entries.map((e) => {
    const lines = e.lines.map((l) => {
      const name = ledgerFor(l, e);
      const debit = l.debitMinor > 0;
      const amount = (debit ? -l.debitMinor : l.creditMinor) / 100;
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(name)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${amount.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    });
    const type = VOUCHER_TYPE[e.sourceType] || "Journal";
    const ref = party.get(idOf(e.sourceId))?.ref || "";
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create"><DATE>${tallyDate(e.entryDate)}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(e.entryNumber)}</VOUCHERNUMBER><REFERENCE>${xml(ref)}</REFERENCE><NARRATION>${xml(e.description)}</NARRATION>${lines.join("")}</VOUCHER></TALLYMESSAGE>`;
  });
  const masters = [...ledgers.entries()].sort().map(([name, parent]) => `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(name)}" ACTION="Create"><NAME.LIST><NAME>${xml(name)}</NAME></NAME.LIST><PARENT>${xml(parent)}</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER></TALLYMESSAGE>`);
  const envelope = (report, body) => `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(business.name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  return {
    mastersXml: `<?xml version="1.0" encoding="UTF-8"?>\n${envelope("All Masters", masters.join("\n"))}\n`,
    vouchersXml: `<?xml version="1.0" encoding="UTF-8"?>\n${envelope("Vouchers", vouchers.join("\n"))}\n`,
    counts: { ledgers: ledgers.size, vouchers: vouchers.length },
  };
};

module.exports = { balancesBetween, gstr9, msmeDueDate, msmeReport, scheduleIII, tallyXml };
