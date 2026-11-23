// Books D16 (21 Nov 2026): payroll. The CRM's finalised salary sheet (attendance, late marks,
// leave, named deductions, KPI incentive) is checked, kept, posted at month end, paid, and its
// PF / TDS dues paid; corrections replace a version only while nothing is paid.
// Needs a replica-set MongoDB:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_payroll_test?replicaSet=rs0&directConnection=true" node --test tests/books-payroll.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Expense = require("../src/models/Expense");
const JournalEntry = require("../src/models/JournalEntry");
const PayrollRun = require("../src/models/PayrollRun");
const payroll = require("../src/services/payroll.service");
const controls = require("../src/services/controls.service");

const MONGO_URI = process.env.TEST_MONGO_URI;

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const setup = async () => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `TOOR ${uid}`, slug: `toor-${uid}`, deploymentMode: "SELF_HOSTED",
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const user = await User.create({ businessId: business._id, name: `U ${uid}`, email: `u-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  return { business, user, credential: { businessId: business._id, createdBy: user._id } };
};

const net = async (businessId, code) => {
  const entries = await JournalEntry.find({ businessId, status: "POSTED" });
  let n = 0;
  for (const e of entries) for (const l of e.lines) if (l.accountCode === code) n += l.debitMinor - l.creditMinor;
  return n / 100;
};
const balanced = async (businessId) => {
  const entries = await JournalEntry.find({ businessId });
  for (const e of entries) assert.equal(e.lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0), 0, `${e.entryNumber} is not balanced`);
};

// Asha: 30,000, 1 absent day (1,000) and 4 late marks (one block, 500); KPI 92 -> 5% incentive 1,450;
// PF 1,800 and advance recovery 2,000. Ravi: 20,000, nothing off, PT 200 and a fine 300.
const sheet = (over = {}) => ({
  runId: "run-oct-v1", month: "2026-10", version: 1, finalisedBy: "Admin", finalisedAt: "2026-11-02T10:00:00Z",
  rows: [
    {
      userId: "u-asha", name: "Asha", email: "asha@example.com", department: "Sales", monthlySalary: 30000, perDayRate: 1000,
      attendance: { workingDays: 26, absent: 1, late: 4, lateCharged: 1 },
      attendanceLines: [{ key: "absent", label: "Absent", count: 1, amount: 1000 }, { key: "late", label: "Late check-in", count: 4, amount: 500 }],
      attendanceDeduction: 1500, earnedSalary: 28500,
      additions: [{ key: "kpi", label: "KPI incentive (score 92)", amount: 1450 }], gross: 29950,
      deductions: [{ key: "custom:pf", label: "PF", amount: 1800 }, { key: "custom:adv", label: "Advance recovery", amount: 2000 }],
      totalDeduction: 3800, net: 26150,
      kpi: { score: 92, grade: "Great", targetScore: 95, targets: [{ label: "Deals closed", goal: 4, achieved: 4, percent: 100 }] },
    },
    {
      userId: "u-ravi", name: "Ravi", department: "Operations", monthlySalary: 20000, perDayRate: 666.67,
      attendanceLines: [], attendanceDeduction: 0, earnedSalary: 20000, additions: [], gross: 20000,
      deductions: [{ key: "custom:pt", label: "Professional tax", amount: 200 }, { key: "custom:fine", label: "Late damage fine", amount: 300 }],
      totalDeduction: 500, net: 19500, kpi: { score: null },
    },
  ],
  ...over,
});

test("a sheet that does not add up is refused, naming the person", async () => {
  const { credential } = await setup();
  const bad = sheet();
  bad.rows[0].net = 26000;
  await assert.rejects(() => payroll.receiveRun({ credential, payload: bad }), /Asha: net pay is not gross less deductions/);
  const bad2 = sheet();
  bad2.rows[1].earnedSalary = 19000;
  await assert.rejects(() => payroll.receiveRun({ credential, payload: bad2 }), /Ravi: earned salary/);
  await assert.rejects(() => payroll.receiveRun({ credential, payload: sheet({ month: "2099-01" }) }), /has not started/);
  const twice = sheet();
  twice.rows[1].userId = "u-asha";
  await assert.rejects(() => payroll.receiveRun({ credential, payload: twice }), /on the sheet twice/);
});

test("received, mapped, posted at month end, paid and its dues paid", async () => {
  const { business, user, credential } = await setup();
  const first = await payroll.receiveRun({ credential, payload: sheet() });
  assert.equal(first.outcome, "created");
  const again = await payroll.receiveRun({ credential, payload: sheet() });
  assert.equal(again.outcome, "unchanged");
  const runId = first.run._id;

  let run = await payroll.getRun({ businessId: business._id, runId });
  const mapOf = Object.fromEntries(run.deductionMap.map((m) => [m.label, m.bookAs]));
  assert.deepEqual(mapOf, { "Advance recovery": "STAFF_ADVANCE", "Late damage fine": "SALARY_COST", PF: "PF", "Professional tax": "PT" });
  assert.equal(run.totals.net, 45650);
  assert.equal(await JournalEntry.countDocuments({ businessId: business._id }), 0, "nothing is posted on arrival");

  await payroll.giveAdvance({ businessId: business._id, userId: user._id, payload: { name: "Asha", externalUserId: "u-asha", amount: 5000, date: "2026-10-05" } });
  await payroll.postRun({ businessId: business._id, userId: user._id, runId });
  const entry = await JournalEntry.findOne({ businessId: business._id, sourceKey: `PAYROLL:${runId}:POSTED:1` });
  assert.equal(entry.entryDate.toISOString().slice(0, 10), "2026-10-31");
  assert.equal(await net(business._id, "5050"), 48500 - 300, "earned salaries less the fine");
  assert.equal(await net(business._id, "5055"), 1450);
  assert.equal(await net(business._id, "2320"), -45650);
  assert.equal(await net(business._id, "2330"), -1800);
  assert.equal(await net(business._id, "2350"), -200);
  assert.equal(await net(business._id, "1160"), 5000 - 2000);
  await assert.rejects(() => payroll.setDeductionMap({ businessId: business._id, runId, map: [] }), /Undo the posting/);

  // Asha paid first, then everyone left
  run = await payroll.getRun({ businessId: business._id, runId });
  const asha = run.rows.find((r) => r.name === "Asha");
  await assert.rejects(() => payroll.payRun({ businessId: business._id, userId: user._id, runId, payload: { date: "2026-11-01", rows: [{ rowId: asha._id, amount: 30000 }] } }), /only 26150 is left/);
  await payroll.payRun({ businessId: business._id, userId: user._id, runId, payload: { date: "2026-11-01", rows: [{ rowId: asha._id }], reference: "NEFT 1" } });
  const paid = await payroll.payRun({ businessId: business._id, userId: user._id, runId, payload: { date: "2026-11-02" } });
  assert.equal(paid.status, "PAID");
  assert.equal(await net(business._id, "2320"), 0);
  assert.equal(await net(business._id, "1020"), -5000 - 45650);
  await assert.rejects(() => payroll.payRun({ businessId: business._id, userId: user._id, runId, payload: {} }), /Nothing is left/);

  await payroll.payDues({ businessId: business._id, userId: user._id, runId, payload: { kind: "PF", date: "2026-11-15", reference: "ECR Oct" } });
  await assert.rejects(() => payroll.payDues({ businessId: business._id, userId: user._id, runId, payload: { kind: "PF", amount: 1 } }), /Only 0 is left/);
  assert.equal(await net(business._id, "2330"), 0);
  run = await payroll.getRun({ businessId: business._id, runId });
  assert.deepEqual(run.dues.map((d) => [d.kind, d.left]), [["PF", 0], ["PT", 200]]);

  const adv = await payroll.advanceBalances({ businessId: business._id });
  assert.deepEqual(adv.people.map((p) => [p.name, p.given, p.recovered, p.balance]), [["Asha", 5000, 2000, 3000]]);

  const { csv } = await payroll.registerCsv({ businessId: business._id, runId });
  assert.match(csv, /Asha,asha@example.com,Sales,30000,1,/);
  await balanced(business._id);
});

test("a correction replaces an unpaid version (reversing its posting) and is refused once paid", async () => {
  const { business, user, credential } = await setup();
  const v1 = await payroll.receiveRun({ credential, payload: sheet() });
  await payroll.postRun({ businessId: business._id, userId: user._id, runId: v1.run._id });

  // same run id, new figures, already posted: refused
  const changed = sheet();
  changed.rows[1].deductions = [{ label: "Professional tax", amount: 200 }];
  changed.rows[1].totalDeduction = 200;
  changed.rows[1].net = 19800;
  await assert.rejects(() => payroll.receiveRun({ credential, payload: changed }), /already in the books/);

  // v2 replaces v1: v1's posting is reversed on 31 Oct
  const v2 = await payroll.receiveRun({ credential, payload: { ...changed, runId: "run-oct-v2", version: 2 } });
  assert.equal(v2.outcome, "replaced");
  assert.equal((await PayrollRun.findById(v1.run._id)).status, "SUPERSEDED");
  assert.equal(await net(business._id, "2320"), 0);
  assert.equal(await net(business._id, "5050"), 0);
  await assert.rejects(() => payroll.receiveRun({ credential, payload: { ...sheet(), runId: "run-oct-old", version: 1 } }), /v2 is already here/);

  await payroll.postRun({ businessId: business._id, userId: user._id, runId: v2.run._id });
  // undo and post again: the second posting uses its own key
  await payroll.unpostRun({ businessId: business._id, userId: user._id, runId: v2.run._id });
  await payroll.postRun({ businessId: business._id, userId: user._id, runId: v2.run._id });
  assert.equal(await net(business._id, "2320"), -45950);
  await payroll.payRun({ businessId: business._id, userId: user._id, runId: v2.run._id, payload: { date: "2026-11-01" } });
  await assert.rejects(() => payroll.unpostRun({ businessId: business._id, userId: user._id, runId: v2.run._id }), /Only a posted month that is not paid|already paid/);
  await assert.rejects(() => payroll.receiveRun({ credential, payload: { ...sheet(), runId: "run-oct-v3", version: 3 } }), /already paid in BillStack/);
  const seen = await payroll.runStatusForCrm({ credential, externalRunId: "run-oct-v2" });
  assert.deepEqual([seen.status, seen.locked, seen.paid], ["PAID", true, 45950]);
  assert.equal((await payroll.runStatusForCrm({ credential, externalRunId: "run-oct-v1" })).status, "SUPERSEDED");
  await assert.rejects(() => payroll.runStatusForCrm({ credential: { businessId: new mongoose.Types.ObjectId() }, externalRunId: "run-oct-v2" }), /not received/);
  await balanced(business._id);
});

test("closed books stop a posting; a hand-entered salary expense in the same month is flagged", async () => {
  const { business, user, credential } = await setup();
  await Expense.create({ businessId: business._id, expenseNumber: "EXP-1", title: "October salaries", category: "Salary & Wages", expenseDate: new Date("2026-10-31T10:00:00+05:30"), amountBeforeTax: 45000, totalAmount: 45000, createdBy: user._id });
  const got = await payroll.receiveRun({ credential, payload: sheet() });
  const run = await payroll.getRun({ businessId: business._id, runId: got.run._id });
  assert.deepEqual(run.salaryExpensesSameMonth, { count: 1, total: 45000 });
  await controls.setPeriodLock({ businessId: business._id, userId: user._id, lockedUpTo: "2026-10-31" });
  await assert.rejects(() => payroll.postRun({ businessId: business._id, userId: user._id, runId: got.run._id }), /books are closed/);
  assert.equal((await PayrollRun.findById(got.run._id)).status, "RECEIVED", "a refused posting leaves the run as it was");
});

// Client answers 23 Nov 2026, D25: Goldhawk's people are paid by Goldhawk. The CRM sends each
// company's people with that company's key; a corrected sheet with nobody left for a company
// withdraws that company's month (reversed if posted, refused once paid).
test("D25: a corrected sheet with nobody for this company withdraws its month; refused once paid", async () => {
  const { business, user, credential } = await setup();
  const first = await payroll.receiveRun({ credential, payload: sheet({ runId: "run-oct-v1:GOLDHAWK" }) });
  await payroll.postRun({ businessId: business._id, userId: user._id, runId: first.run._id });
  assert.equal(await net(business._id, "2320"), -45650);

  await assert.rejects(() => payroll.receiveRun({ credential, payload: { withdraw: true, runId: "x", month: "2026-10", version: 1 } }), /v1 is already here/);
  const out = await payroll.receiveRun({ credential, payload: { withdraw: true, runId: "run-oct-v2:GOLDHAWK", month: "2026-10", version: 2 } });
  assert.equal(out.outcome, "withdrawn");
  const run = await PayrollRun.findById(first.run._id).lean();
  assert.equal(run.status, "SUPERSEDED");
  assert.ok(run.withdrawnAt);
  assert.equal(await net(business._id, "2320"), 0, "the posting is reversed");
  assert.equal(await net(business._id, "5050"), 0);
  await balanced(business._id);
  const again = await payroll.receiveRun({ credential, payload: { withdraw: true, runId: "run-oct-v2:GOLDHAWK", month: "2026-10", version: 2 } });
  assert.equal(again.outcome, "nothing_to_withdraw");

  // a later version brings people back; once paid, a withdrawal is refused
  const v3 = await payroll.receiveRun({ credential, payload: sheet({ runId: "run-oct-v3:GOLDHAWK", version: 3 }) });
  assert.equal(v3.outcome, "created");
  await payroll.postRun({ businessId: business._id, userId: user._id, runId: v3.run._id });
  await payroll.payRun({ businessId: business._id, userId: user._id, runId: v3.run._id, payload: { date: "2026-11-05", mode: "BANK" } });
  await assert.rejects(() => payroll.receiveRun({ credential, payload: { withdraw: true, runId: "run-oct-v4:GOLDHAWK", month: "2026-10", version: 4 } }), /already paid in BillStack/);
});
