const mongoose = require("mongoose");

// A month's salary sheet, finalised in the CRM (attendance, late marks, leave, KPI) and
// sent here to go into the books. The sheet itself is never edited in BillStack: a
// correction is a new version from the CRM, which replaces this one while nothing is paid.
const lineSchema = new mongoose.Schema(
  {
    key: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, required: true },
    count: { type: Number, default: null },
    rule: { type: String, trim: true, default: "" },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const rowSchema = new mongoose.Schema(
  {
    externalUserId: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, default: "" },
    department: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
    monthlySalary: { type: Number, required: true, min: 0 },
    perDayRate: { type: Number, default: 0 },
    // days counted from CRM attendance
    attendance: {
      workingDays: { type: Number, default: null },
      absent: { type: Number, default: 0 },
      halfDay: { type: Number, default: 0 },
      unapprovedLeave: { type: Number, default: 0 },
      unpaidLeave: { type: Number, default: 0 },
      paidLeave: { type: Number, default: 0 },
      leaveBeyondEntitlement: { type: Number, default: 0 },
      late: { type: Number, default: 0 },
      lateCharged: { type: Number, default: 0 },
      workedOnOffDays: { type: Number, default: 0 },
    },
    attendanceLines: { type: [lineSchema], default: [] },
    attendanceDeduction: { type: Number, default: 0, min: 0 },
    earnedSalary: { type: Number, required: true, min: 0 },
    additions: { type: [lineSchema], default: [] }, // KPI incentive, bonus, arrears
    gross: { type: Number, required: true, min: 0 },
    deductions: { type: [lineSchema], default: [] }, // PF, ESI, PT, TDS, advance recovery, others
    totalDeduction: { type: Number, default: 0, min: 0 },
    net: { type: Number, required: true, min: 0 },
    kpi: {
      score: { type: Number, default: null },
      grade: { type: String, trim: true, default: "" },
      targetScore: { type: Number, default: null },
      targets: { type: [{ _id: false, label: String, goal: Number, achieved: Number, percent: Number }], default: [] },
    },
    paid: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const BOOK_AS = ["SALARY_COST", "STAFF_ADVANCE", "PF", "ESI", "PT", "TDS_192", "OTHER_PAYABLE", "OTHER_INCOME"];

const payrollRunSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    source: { type: String, default: "CRM", trim: true },
    externalRunId: { type: String, required: true, trim: true },
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    version: { type: Number, required: true, min: 1 },
    fingerprint: { type: String, required: true },
    finalisedBy: { type: String, trim: true, default: "" },
    finalisedAt: { type: Date, default: null },
    status: { type: String, enum: ["RECEIVED", "POSTED", "PAID", "SUPERSEDED"], default: "RECEIVED", index: true },
    rows: { type: [rowSchema], default: [] },
    totals: {
      employees: { type: Number, default: 0 },
      monthlySalary: { type: Number, default: 0 },
      attendanceDeduction: { type: Number, default: 0 },
      additions: { type: Number, default: 0 },
      gross: { type: Number, default: 0 },
      deductions: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
    },
    // how each named deduction goes into the books, chosen by the accountant
    deductionMap: { type: [{ _id: false, label: { type: String, required: true }, bookAs: { type: String, enum: BOOK_AS, default: "SALARY_COST" } }], default: [] },
    centre: { type: String, trim: true, default: "" },
    postCount: { type: Number, default: 0 },
    postedAt: { type: Date, default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    payments: {
      type: [{
        date: { type: Date, required: true },
        mode: { type: String, enum: ["BANK", "CASH"], default: "BANK" },
        reference: { type: String, trim: true, default: "" },
        amount: { type: Number, required: true, min: 0 },
        rows: { type: [{ _id: false, rowId: mongoose.Schema.Types.ObjectId, name: String, amount: Number }], default: [] },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        createdAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    dues: {
      type: [{
        kind: { type: String, enum: ["PF", "ESI", "PT", "TDS_192", "OTHER_PAYABLE"], required: true },
        date: { type: Date, required: true },
        mode: { type: String, enum: ["BANK", "CASH"], default: "BANK" },
        reference: { type: String, trim: true, default: "" },
        amount: { type: Number, required: true, min: 0 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        createdAt: { type: Date, default: Date.now },
      }],
      default: [],
    },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: "PayrollRun", default: null },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

payrollRunSchema.index({ businessId: 1, source: 1, externalRunId: 1 }, { unique: true });
payrollRunSchema.index({ businessId: 1, month: -1, version: -1 });
payrollRunSchema.plugin(require("../utils/edit-log.plugin"), { model: "PayrollRun", businessKey: "businessId" });

module.exports = mongoose.model("PayrollRun", payrollRunSchema);
module.exports.BOOK_AS = BOOK_AS;
