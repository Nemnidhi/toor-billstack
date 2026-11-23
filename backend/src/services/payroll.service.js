// Payroll (books D16, 21 Nov 2026). The CRM works out each month's salary from its own
// attendance (absent, half day, leave, late marks), the paid-leave entitlement, named
// deductions (PF, advance recovery...) and the KPI incentive, and sends the finalised
// sheet here. BillStack keeps the sheet as it came and puts it in the books:
//
//   Post (month end)   Dr 5050 Salaries (earned)   Dr 5055 Incentives (additions)
//                      Cr 2320 Salaries Payable (net)
//                      Cr PF 2330 / ESI 2340 / PT 2350 / TDS s.192 2315 / other 2360,
//                         staff advance 1160, other income 4100 - per deduction, as the
//                         accountant maps it; "salary cost" deductions (fines) reduce 5050
//   Pay salaries       Dr 2320 / Cr bank or cash
//   Pay dues           Dr 2330 .. 2360 / Cr bank or cash (challan)
//   Staff advance      Dr 1160 / Cr bank or cash
//
// A correction is a new version from the CRM. It replaces the old one while nothing of it
// is paid here (a posted one is reversed on its own date); once paid, it is refused and the
// correction goes into the next month's sheet.
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AppError = require("../utils/appError");
const PayrollRun = require("../models/PayrollRun");
const StaffAdvance = require("../models/StaffAdvance");
const Expense = require("../models/Expense");
const accounting = require("./accounting.service");

const { BOOK_AS } = PayrollRun;
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const sum = (items, pick = (x) => x.amount) => round2((items || []).reduce((s, x) => s + Number(pick(x) || 0), 0));
const cashOrBank = (mode) => (mode === "CASH" ? "1010" : "1020");
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_AMOUNT = 100000000;

const BOOK_AS_CODE = { STAFF_ADVANCE: "1160", PF: "2330", ESI: "2340", PT: "2350", TDS_192: "2315", OTHER_PAYABLE: "2360", OTHER_INCOME: "4100" };
const BOOK_AS_LABEL = {
  SALARY_COST: "Reduces salary cost (fine, recovery)",
  STAFF_ADVANCE: "Staff advance recovered (1160)",
  PF: "PF payable (2330)",
  ESI: "ESI payable (2340)",
  PT: "Professional tax payable (2350)",
  TDS_192: "TDS on salary, s.192 (2315)",
  OTHER_PAYABLE: "Other payroll dues payable (2360)",
  OTHER_INCOME: "Other income (4100)",
};
const DUE_KINDS = ["PF", "ESI", "PT", "TDS_192", "OTHER_PAYABLE"];

// a first guess from the deduction's name; the accountant can change it before posting
const guessBookAs = (label) => {
  const s = String(label || "");
  if (/\b(e?pf|provident)\b/i.test(s)) return "PF";
  if (/\besic?\b/i.test(s)) return "ESI";
  if (/professional\s*tax|\bp\.?\s?t\.?\b/i.test(s)) return "PT";
  if (/\btds\b|income[\s-]*tax/i.test(s)) return "TDS_192";
  if (/advance|loan/i.test(s)) return "STAFF_ADVANCE";
  return "SALARY_COST";
};

const monthEnd = (month) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(`${month}-${String(last).padStart(2, "0")}T12:00:00+05:30`);
};
const monthLabel = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const istMonthNow = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);

const withTransaction = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    await session.endSession();
  }
};

// ------------------------------------------------------------------ incoming sheet

const text = (v, max = 120) => String(v ?? "").trim().slice(0, max);
const money = (v, label, who) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) throw new AppError(`${who}: ${label} is not a valid amount`, 422);
  return round2(n);
};
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 400 ? round2(n) : 0;
};
const lines = (items, who, what) => {
  if (items == null) return [];
  if (!Array.isArray(items) || items.length > 60) throw new AppError(`${who}: ${what} must be a list`, 422);
  return items.map((l) => {
    const label = text(l?.label, 80);
    if (!label) throw new AppError(`${who}: every ${what} line needs a name`, 422);
    return { key: text(l.key, 80), label, count: l.count == null ? null : count(l.count), rule: text(l.rule, 160), amount: money(l.amount, label, who) };
  });
};
const close = (a, b) => Math.abs(round2(a) - round2(b)) <= 0.011;

// Check every figure adds up; BillStack books what it can verify, never a bare total.
const normaliseSheet = (payload = {}) => {
  const externalRunId = text(payload.runId, 80);
  if (!externalRunId) throw new AppError("The salary sheet has no run id", 422);
  const month = text(payload.month, 7);
  if (!MONTH.test(month)) throw new AppError("The salary sheet's month must be YYYY-MM", 422);
  if (month > istMonthNow()) throw new AppError(`${monthLabel(month)} has not started; finalise it after the month`, 422);
  const version = Number(payload.version);
  if (!Number.isInteger(version) || version < 1 || version > 1000) throw new AppError("The salary sheet's version must be a whole number", 422);
  if (!Array.isArray(payload.rows) || !payload.rows.length) throw new AppError("The salary sheet has nobody on it", 422);
  if (payload.rows.length > 1000) throw new AppError("The salary sheet has too many people", 422);

  const seen = new Set();
  const rows = payload.rows.map((r, i) => {
    const name = text(r?.name, 120);
    const who = name || `Row ${i + 1}`;
    const externalUserId = text(r?.userId, 80);
    if (!name || !externalUserId) throw new AppError(`${who}: name and user id are needed`, 422);
    if (seen.has(externalUserId)) throw new AppError(`${who} is on the sheet twice`, 422);
    seen.add(externalUserId);
    const monthlySalary = money(r.monthlySalary, "monthly salary", who);
    const attendanceLines = lines(r.attendanceLines, who, "attendance");
    const attendanceDeduction = money(r.attendanceDeduction, "attendance deduction", who);
    const earnedSalary = money(r.earnedSalary, "earned salary", who);
    const additions = lines(r.additions, who, "addition");
    const deductions = lines(r.deductions, who, "deduction");
    const gross = money(r.gross, "gross", who);
    const totalDeduction = money(r.totalDeduction, "total deduction", who);
    const net = money(r.net, "net pay", who);
    if (attendanceDeduction > monthlySalary + 0.011) throw new AppError(`${who}: attendance deduction is more than the salary`, 422);
    if (attendanceDeduction > sum(attendanceLines) + 0.011) throw new AppError(`${who}: attendance deduction is more than its lines`, 422);
    if (!close(earnedSalary, monthlySalary - attendanceDeduction)) throw new AppError(`${who}: earned salary is not salary less attendance deduction`, 422);
    if (!close(gross, earnedSalary + sum(additions))) throw new AppError(`${who}: gross is not earned salary plus additions`, 422);
    if (!close(totalDeduction, sum(deductions))) throw new AppError(`${who}: total deduction does not match its lines`, 422);
    if (!close(net, gross - totalDeduction)) throw new AppError(`${who}: net pay is not gross less deductions`, 422);
    const a = r.attendance || {};
    const kpi = r.kpi || {};
    const score = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : round2(Math.max(0, Math.min(200, Number(v)))));
    return {
      externalUserId, name,
      email: text(r.email, 120).toLowerCase(), department: text(r.department, 80), role: text(r.role, 40),
      monthlySalary, perDayRate: money(r.perDayRate ?? 0, "per day rate", who),
      attendance: {
        workingDays: a.workingDays == null ? null : count(a.workingDays),
        absent: count(a.absent), halfDay: count(a.halfDay), unapprovedLeave: count(a.unapprovedLeave),
        unpaidLeave: count(a.unpaidLeave), paidLeave: count(a.paidLeave), leaveBeyondEntitlement: count(a.leaveBeyondEntitlement),
        late: count(a.late), lateCharged: count(a.lateCharged), workedOnOffDays: count(a.workedOnOffDays),
      },
      attendanceLines, attendanceDeduction, earnedSalary, additions, gross, deductions, totalDeduction, net,
      kpi: {
        score: score(kpi.score), grade: text(kpi.grade, 40), targetScore: score(kpi.targetScore),
        targets: (Array.isArray(kpi.targets) ? kpi.targets.slice(0, 10) : []).map((t) => ({ label: text(t?.label, 60), goal: round2(t?.goal), achieved: round2(t?.achieved), percent: round2(t?.percent) })),
      },
    };
  });
  const totals = {
    employees: rows.length,
    monthlySalary: sum(rows, (r) => r.monthlySalary),
    attendanceDeduction: sum(rows, (r) => r.attendanceDeduction),
    additions: sum(rows, (r) => sum(r.additions)),
    gross: sum(rows, (r) => r.gross),
    deductions: sum(rows, (r) => r.totalDeduction),
    net: sum(rows, (r) => r.net),
  };
  const canonical = JSON.stringify({ month, version, rows });
  return {
    externalRunId, month, version, rows, totals,
    finalisedBy: text(payload.finalisedBy, 120),
    finalisedAt: payload.finalisedAt && !Number.isNaN(new Date(payload.finalisedAt).getTime()) ? new Date(payload.finalisedAt) : null,
    fingerprint: crypto.createHash("sha256").update(canonical).digest("hex"),
  };
};

const deductionLabels = (rows) => [...new Set(rows.flatMap((r) => r.deductions.map((d) => d.label)))].sort();
const buildMap = (labels, ...previous) => labels.map((label) => {
  for (const map of previous) {
    const hit = (map || []).find((m) => m.label.toLowerCase() === label.toLowerCase());
    if (hit) return { label, bookAs: hit.bookAs };
  }
  return { label, bookAs: guessBookAs(label) };
});

const postKey = (run, n) => `PAYROLL:${run._id}:POSTED:${n}`;
const unpostKey = (run, n) => `PAYROLL:${run._id}:UNPOST:${n}`;

const reversePosting = async ({ run, userId, session, label }) => {
  await accounting.reverseRecordPostings({
    businessId: run.businessId, keyType: "PAYROLL", recordId: run._id, cancelKey: unpostKey(run, run.postCount),
    label, userId, entryDate: monthEnd(run.month), session,
  });
};

// A corrected sheet for the month with nobody left for this company (client answers D25:
// the CRM sends TOOR's and Goldhawk's people to their own books, each with its own key).
// The month's run here is taken back: reversed if posted, refused once anything is paid.
const withdrawRun = async ({ credential, payload }) => {
  const externalRunId = text(payload.runId, 80);
  const month = text(payload.month, 7);
  const version = Number(payload.version);
  if (!externalRunId) throw new AppError("The withdrawal has no run id", 422);
  if (!MONTH.test(month)) throw new AppError("The withdrawal's month must be YYYY-MM", 422);
  if (!Number.isInteger(version) || version < 1 || version > 1000) throw new AppError("The withdrawal's version must be a whole number", 422);
  const businessId = credential.businessId;
  return withTransaction(async (session) => {
    const active = await PayrollRun.findOne({ businessId, month, status: { $ne: "SUPERSEDED" } }).session(session);
    if (!active) return { outcome: "nothing_to_withdraw", run: { _id: null, month, version, status: "NONE" } };
    if (active.version >= version) throw new AppError(`${monthLabel(month)} v${active.version} is already here; this is v${version}`, 409);
    if (active.payments.length || active.dues.length) {
      throw new AppError(`Salaries for ${monthLabel(month)} (v${active.version}) are already paid in BillStack. Put the correction in next month's sheet.`, 409);
    }
    if (active.status === "POSTED") await reversePosting({ run: active, userId: credential.createdBy, session, label: `Salaries ${monthLabel(month)} v${active.version} withdrawn: nobody on v${version} is paid by this company` });
    active.status = "SUPERSEDED";
    active.withdrawnAt = new Date();
    active.withdrawnByExternalRunId = externalRunId;
    await active.save({ session });
    return { outcome: "withdrawn", run: active.toObject() };
  });
};

const receiveRun = async ({ credential, payload }) => {
  if (payload?.withdraw === true) return withdrawRun({ credential, payload });
  const sheet = normaliseSheet(payload);
  const businessId = credential.businessId;
  return withTransaction(async (session) => {
    const same = await PayrollRun.findOne({ businessId, source: "CRM", externalRunId: sheet.externalRunId }).session(session);
    if (same) {
      if (same.fingerprint === sheet.fingerprint) return { outcome: "unchanged", run: same.toObject() };
      if (same.status !== "RECEIVED") throw new AppError(`${monthLabel(same.month)} v${same.version} is already in the books; send the change as a new version`, 409);
      if (same.month !== sheet.month) throw new AppError("A run cannot change its month", 409);
      Object.assign(same, { rows: sheet.rows, totals: sheet.totals, fingerprint: sheet.fingerprint, version: sheet.version, finalisedBy: sheet.finalisedBy, finalisedAt: sheet.finalisedAt, receivedAt: new Date() });
      same.deductionMap = buildMap(deductionLabels(sheet.rows), same.deductionMap);
      await same.save({ session });
      return { outcome: "updated", run: same.toObject() };
    }

    const active = await PayrollRun.findOne({ businessId, month: sheet.month, status: { $ne: "SUPERSEDED" } }).session(session);
    if (active) {
      if (active.version >= sheet.version) throw new AppError(`${monthLabel(sheet.month)} v${active.version} is already here; this is v${sheet.version}`, 409);
      if (active.payments.length || active.dues.length) {
        throw new AppError(`Salaries for ${monthLabel(sheet.month)} (v${active.version}) are already paid in BillStack. Put the correction in next month's sheet.`, 409);
      }
    }
    const latest = await PayrollRun.findOne({ businessId }).sort({ month: -1, version: -1 }).select("deductionMap").session(session).lean();
    const [run] = await PayrollRun.create([{
      businessId, source: "CRM", ...sheet,
      deductionMap: buildMap(deductionLabels(sheet.rows), active?.deductionMap, latest?.deductionMap),
    }], { session });
    if (active) {
      if (active.status === "POSTED") await reversePosting({ run: active, userId: credential.createdBy, session, label: `Salaries ${monthLabel(active.month)} v${active.version} replaced by v${run.version}` });
      active.status = "SUPERSEDED";
      active.supersededBy = run._id;
      await active.save({ session });
    }
    return { outcome: active ? "replaced" : "created", run: run.toObject() };
  });
};

// ------------------------------------------------------------------ books

const bookAsOf = (run, label) => (run.deductionMap || []).find((m) => m.label === label)?.bookAs || guessBookAs(label);

// The journal lines this run would post, as [code, debit, credit, description].
const journalRows = (run) => {
  const earned = sum(run.rows, (r) => r.earnedSalary);
  const additions = sum(run.rows, (r) => sum(r.additions));
  const byCode = new Map();
  let salaryCost = 0;
  for (const r of run.rows) {
    for (const d of r.deductions) {
      const as = bookAsOf(run, d.label);
      if (as === "SALARY_COST") salaryCost = round2(salaryCost + d.amount);
      else byCode.set(BOOK_AS_CODE[as], round2((byCode.get(BOOK_AS_CODE[as]) || 0) + d.amount));
    }
  }
  let salaryDr = round2(earned - salaryCost);
  let incentiveDr = additions;
  if (salaryDr < 0) { incentiveDr = round2(incentiveDr + salaryDr); salaryDr = 0; }
  const label = monthLabel(run.month);
  const rows = [
    ["5050", salaryDr, 0, `Salaries ${label}`],
    ["5055", incentiveDr, 0, `Incentives and additions ${label}`],
    ["2320", 0, sum(run.rows, (r) => r.net), `Net salaries payable ${label}`],
    ...[...byCode.entries()].map(([code, amt]) => [code, 0, amt, `Deducted from salaries ${label}`]),
  ];
  return rows.filter(([, dr, cr]) => dr > 0 || cr > 0);
};

const post = async ({ run, key, date, rows, description, userId, session }) => {
  const accounts = await accounting.ensureDefaultAccounts({ businessId: run.businessId, session });
  const ls = rows.map(([code, dr, cr, desc]) => accounting.postingLine(accounts.get(code), accounting.paise(dr), accounting.paise(cr), desc || description, run.centre || ""));
  return accounting.postJournalEntry({ businessId: run.businessId, userId, entryDate: date, sourceType: "PAYROLL", sourceId: run._id, sourceKey: key, description, lines: ls, session });
};

const loadRun = async ({ businessId, runId, session }) => {
  if (!mongoose.isValidObjectId(runId)) throw new AppError("Payroll run not found", 404);
  const run = await PayrollRun.findOne({ _id: runId, businessId }).session(session || null);
  if (!run) throw new AppError("Payroll run not found", 404);
  return run;
};

const setDeductionMap = async ({ businessId, runId, map }) => withTransaction(async (session) => {
  const run = await loadRun({ businessId, runId, session });
  if (run.status !== "RECEIVED") throw new AppError("Undo the posting first to change how deductions are booked", 409);
  const wanted = new Map((Array.isArray(map) ? map : []).map((m) => [String(m?.label || ""), String(m?.bookAs || "")]));
  run.deductionMap = deductionLabels(run.rows).map((label) => {
    const as = wanted.get(label);
    if (as && !BOOK_AS.includes(as)) throw new AppError(`Choose how "${label}" is booked`, 400);
    return { label, bookAs: as || bookAsOf(run, label) };
  });
  await run.save({ session });
  return run.toObject();
});

const postRun = async ({ businessId, userId, runId }) => withTransaction(async (session) => {
  const run = await loadRun({ businessId, runId, session });
  if (run.status !== "RECEIVED") throw new AppError(run.status === "SUPERSEDED" ? "A newer version of this month replaced this one" : "This month is already in the books", 409);
  run.postCount += 1;
  run.status = "POSTED";
  run.postedAt = new Date();
  run.postedBy = userId;
  await run.save({ session });
  await post({ run, key: postKey(run, run.postCount), date: monthEnd(run.month), rows: journalRows(run), description: `Salaries ${monthLabel(run.month)} (CRM v${run.version}, ${run.rows.length} staff)`, userId, session });
  return run.toObject();
});

const unpostRun = async ({ businessId, userId, runId }) => withTransaction(async (session) => {
  const run = await loadRun({ businessId, runId, session });
  if (run.status !== "POSTED") throw new AppError("Only a posted month that is not paid can be taken out of the books", 409);
  if (run.payments.length || run.dues.length) throw new AppError("Salaries or dues are already paid for this month", 409);
  await reversePosting({ run, userId, session, label: `Salaries ${monthLabel(run.month)} v${run.version} taken out of the books` });
  run.status = "RECEIVED";
  run.postedAt = null;
  await run.save({ session });
  return run.toObject();
});

const parseDate = (value) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) throw new AppError("Enter a valid date", 400);
  return d;
};

// Pay the net salaries: every unpaid person, or the ones picked (full or part amounts).
const payRun = async ({ businessId, userId, runId, payload = {} }) => withTransaction(async (session) => {
  const run = await loadRun({ businessId, runId, session });
  if (!["POSTED", "PAID"].includes(run.status)) throw new AppError("Post the month to the books before paying it", 409);
  const date = parseDate(payload.date);
  if (date < new Date(`${run.month}-01T00:00:00+05:30`)) throw new AppError("The payment date is before the month", 400);
  const mode = payload.mode === "CASH" ? "CASH" : "BANK";
  const picked = Array.isArray(payload.rows) && payload.rows.length ? payload.rows : null;
  const paying = [];
  for (const row of run.rows) {
    const due = round2(row.net - row.paid);
    const ask = picked ? picked.find((p) => String(p?.rowId) === String(row._id)) : { amount: due };
    if (!ask) continue;
    const amount = ask.amount === undefined || ask.amount === null || ask.amount === "" ? due : round2(ask.amount);
    if (!(amount > 0)) continue;
    if (amount > due + 0.004) throw new AppError(`${row.name}: only ${due} is left to pay`, 400);
    row.paid = round2(row.paid + amount);
    paying.push({ rowId: row._id, name: row.name, amount });
  }
  if (!paying.length) throw new AppError("Nothing is left to pay for the people chosen", 400);
  const amount = sum(paying);
  run.payments.push({ date, mode, reference: text(payload.reference, 80), amount, rows: paying, createdBy: userId });
  const pay = run.payments[run.payments.length - 1];
  if (run.rows.every((r) => r.paid >= r.net - 0.004)) run.status = "PAID";
  await run.save({ session });
  const label = monthLabel(run.month);
  await post({ run, key: `PAYROLL:${run._id}:PAY:${pay._id}`, date, rows: [["2320", amount, 0], [cashOrBank(mode), 0, amount]], description: `Salaries ${label} paid to ${paying.length === 1 ? paying[0].name : `${paying.length} staff`}${pay.reference ? ` (${pay.reference})` : ""}`, userId, session });
  return run.toObject();
});

const duesOf = (run) => {
  const owed = Object.fromEntries(DUE_KINDS.map((k) => [k, 0]));
  for (const r of run.rows) for (const d of r.deductions) {
    const as = bookAsOf(run, d.label);
    if (owed[as] !== undefined) owed[as] = round2(owed[as] + d.amount);
  }
  return DUE_KINDS.map((kind) => {
    const paid = sum((run.dues || []).filter((x) => x.kind === kind));
    return { kind, label: BOOK_AS_LABEL[kind], owed: owed[kind], paid, left: round2(owed[kind] - paid) };
  }).filter((d) => d.owed > 0 || d.paid > 0);
};

const payDues = async ({ businessId, userId, runId, payload = {} }) => withTransaction(async (session) => {
  const run = await loadRun({ businessId, runId, session });
  if (!["POSTED", "PAID"].includes(run.status)) throw new AppError("Post the month to the books before paying its dues", 409);
  const kind = String(payload.kind || "");
  const due = duesOf(run).find((d) => d.kind === kind);
  if (!due) throw new AppError("Nothing of that kind was deducted this month", 400);
  const amount = round2(payload.amount === undefined || payload.amount === "" ? due.left : payload.amount);
  if (!(amount > 0)) throw new AppError("Enter the amount paid", 400);
  if (amount > due.left + 0.004) throw new AppError(`Only ${due.left} is left to pay`, 400);
  const date = parseDate(payload.date);
  const mode = payload.mode === "CASH" ? "CASH" : "BANK";
  run.dues.push({ kind, date, mode, reference: text(payload.reference, 80), amount, createdBy: userId });
  const paid = run.dues[run.dues.length - 1];
  await run.save({ session });
  await post({ run, key: `PAYROLL:${run._id}:DUE:${paid._id}`, date, rows: [[BOOK_AS_CODE[kind], amount, 0], [cashOrBank(mode), 0, amount]], description: `${BOOK_AS_LABEL[kind].replace(/ \(\d+\)$/, "")} for ${monthLabel(run.month)} paid${paid.reference ? ` (${paid.reference})` : ""}`, userId, session });
  return run.toObject();
});

// ------------------------------------------------------------------ views

const salaryExpensesIn = async ({ businessId, month }) => {
  const from = new Date(`${month}-01T00:00:00+05:30`);
  const to = new Date(monthEnd(month).getTime() + 12 * 3600000);
  const rows = await Expense.find({ businessId, category: "Salary & Wages", status: { $ne: "CANCELLED" }, expenseDate: { $gte: from, $lt: to } }).select("expenseNumber totalAmount").lean();
  return { count: rows.length, total: sum(rows, (r) => r.totalAmount) };
};

const view = async (run) => {
  const r = run.toObject ? run.toObject() : run;
  return {
    ...r,
    monthLabel: monthLabel(r.month),
    paidTotal: sum(r.rows, (x) => x.paid),
    unpaidTotal: round2(sum(r.rows, (x) => x.net) - sum(r.rows, (x) => x.paid)),
    deductionMap: buildMap(deductionLabels(r.rows), r.deductionMap),
    journalPreview: journalRows(r).map(([code, debit, credit, description]) => ({ code, debit, credit, description })),
    dues: duesOf(r),
    duesPaid: r.dues || [],
    salaryExpensesSameMonth: await salaryExpensesIn({ businessId: r.businessId, month: r.month }),
  };
};

const listRuns = async ({ businessId, includeSuperseded = false }) => {
  const filter = { businessId };
  if (!includeSuperseded) filter.status = { $ne: "SUPERSEDED" };
  const runs = await PayrollRun.find(filter).sort({ month: -1, version: -1 }).limit(60).select("-rows.attendanceLines -rows.kpi.targets").lean();
  return {
    bookAs: BOOK_AS.map((key) => ({ key, label: BOOK_AS_LABEL[key] })),
    runs: runs.map((r) => ({
      _id: r._id, month: r.month, monthLabel: monthLabel(r.month), version: r.version, status: r.status,
      employees: r.totals.employees, gross: r.totals.gross, deductions: r.totals.deductions, net: r.totals.net,
      paid: sum(r.rows, (x) => x.paid), finalisedBy: r.finalisedBy, finalisedAt: r.finalisedAt, receivedAt: r.receivedAt, postedAt: r.postedAt,
    })),
  };
};

const getRun = async ({ businessId, runId }) => view(await loadRun({ businessId, runId }));

// What the CRM may know about its own run: is it in the books, is anything paid.
const runStatusForCrm = async ({ credential, externalRunId }) => {
  const run = await PayrollRun.findOne({ businessId: credential.businessId, source: "CRM", externalRunId: text(externalRunId, 80) }).select("month version status rows.paid dues.amount").lean();
  if (!run) throw new AppError("BillStack has not received this run", 404);
  const paid = sum(run.rows, (r) => r.paid);
  const duesPaid = sum(run.dues);
  return { month: run.month, version: run.version, status: run.status, paid, duesPaid, locked: paid > 0 || duesPaid > 0 };
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const registerCsv = async ({ businessId, runId }) => {
  const run = await loadRun({ businessId, runId });
  const labels = deductionLabels(run.rows);
  const additionLabels = [...new Set(run.rows.flatMap((r) => r.additions.map((a) => a.label)))].sort();
  const head = ["Employee", "Email", "Department", "Monthly salary", "Absent", "Half day", "Unapproved leave", "Unpaid leave", "Paid leave", "Leave beyond entitlement", "Late marks", "Late charged", "Attendance deduction", "Earned salary", ...additionLabels, "Gross", ...labels, "Total deduction", "Net pay", "Paid", "KPI score", "KPI grade", "Target score"];
  const out = [head];
  for (const r of run.rows) {
    const pick = (items, label) => sum(items.filter((x) => x.label === label));
    out.push([r.name, r.email, r.department, r.monthlySalary, r.attendance.absent, r.attendance.halfDay, r.attendance.unapprovedLeave, r.attendance.unpaidLeave, r.attendance.paidLeave, r.attendance.leaveBeyondEntitlement, r.attendance.late, r.attendance.lateCharged, r.attendanceDeduction, r.earnedSalary, ...additionLabels.map((l) => pick(r.additions, l)), r.gross, ...labels.map((l) => pick(r.deductions, l)), r.totalDeduction, r.net, r.paid, r.kpi?.score ?? "", r.kpi?.grade || "", r.kpi?.targetScore ?? ""]);
  }
  return { fileName: `salary-register-${run.month}-v${run.version}.csv`, csv: `﻿${out.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n` };
};

// ------------------------------------------------------------------ staff advances

const giveAdvance = async ({ businessId, userId, payload = {} }) => {
  const name = text(payload.name, 120);
  if (!name) throw new AppError("Who was the advance paid to?", 400);
  const amount = round2(payload.amount);
  if (!(amount > 0) || amount > MAX_AMOUNT) throw new AppError("Enter the advance amount", 400);
  const date = parseDate(payload.date);
  const mode = payload.mode === "CASH" ? "CASH" : "BANK";
  return withTransaction(async (session) => {
    const [adv] = await StaffAdvance.create([{ businessId, externalUserId: text(payload.externalUserId, 80), name, amount, date, mode, reference: text(payload.reference, 80), note: text(payload.note, 300), createdBy: userId }], { session });
    const accounts = await accounting.ensureDefaultAccounts({ businessId, session });
    const description = `Salary advance paid to ${name}`;
    await accounting.postJournalEntry({
      businessId, userId, entryDate: date, sourceType: "PAYROLL", sourceId: adv._id, sourceKey: `PAYROLL_ADVANCE:${adv._id}:POSTED`, description, session,
      lines: [accounting.postingLine(accounts.get("1160"), accounting.paise(amount), 0, description, ""), accounting.postingLine(accounts.get(cashOrBank(mode)), 0, accounting.paise(amount), description, "")],
    });
    return adv.toObject();
  });
};

const cancelAdvance = async ({ businessId, userId, advanceId }) => withTransaction(async (session) => {
  if (!mongoose.isValidObjectId(advanceId)) throw new AppError("Advance not found", 404);
  const adv = await StaffAdvance.findOne({ _id: advanceId, businessId }).session(session);
  if (!adv) throw new AppError("Advance not found", 404);
  if (adv.status === "CANCELLED") return adv.toObject();
  adv.status = "CANCELLED";
  await adv.save({ session });
  await accounting.reverseRecordPostings({ businessId, keyType: "PAYROLL_ADVANCE", recordId: adv._id, cancelKey: `PAYROLL_ADVANCE:${adv._id}:CANCEL`, label: `Salary advance to ${adv.name} cancelled`, userId, entryDate: adv.date, session });
  return adv.toObject();
});

// Each person's advances against what the posted salary sheets recovered.
const advanceBalances = async ({ businessId }) => {
  const advances = await StaffAdvance.find({ businessId, status: "ACTIVE" }).sort({ date: -1 }).lean();
  const runs = await PayrollRun.find({ businessId, status: { $in: ["POSTED", "PAID"] } }).select("month deductionMap rows.externalUserId rows.name rows.deductions").lean();
  const people = new Map();
  const keyOf = (id, name) => (id ? `id:${id}` : `name:${String(name).toLowerCase()}`);
  const person = (id, name) => {
    const k = keyOf(id, name);
    if (!people.has(k)) people.set(k, { externalUserId: id || "", name, given: 0, recovered: 0 });
    return people.get(k);
  };
  for (const a of advances) {
    const p = person(a.externalUserId, a.name);
    p.given = round2(p.given + a.amount);
  }
  for (const run of runs) for (const r of run.rows) {
    const got = sum(r.deductions.filter((d) => bookAsOf(run, d.label) === "STAFF_ADVANCE"));
    if (!got) continue;
    const p = people.get(keyOf(r.externalUserId, r.name)) || people.get(keyOf("", r.name)) || person(r.externalUserId, r.name);
    p.recovered = round2(p.recovered + got);
  }
  const rows = [...people.values()].map((p) => ({ ...p, balance: round2(p.given - p.recovered) })).sort((a, b) => b.balance - a.balance);
  return { advances, people: rows, totals: { given: sum(rows, (p) => p.given), recovered: sum(rows, (p) => p.recovered), balance: sum(rows, (p) => p.balance) } };
};

module.exports = {
  BOOK_AS_LABEL,
  advanceBalances,
  cancelAdvance,
  getRun,
  giveAdvance,
  guessBookAs,
  journalRows,
  listRuns,
  normaliseSheet,
  payDues,
  payRun,
  postRun,
  receiveRun,
  registerCsv,
  runStatusForCrm,
  setDeductionMap,
  unpostRun,
};
