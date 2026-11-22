const mongoose = require("mongoose");

// A TDS deposit to the government (challan ITNS 281 / the e-pay tax challan) covering the
// TDS deducted from bills in one month. The bills it covers point to it via Expense.tdsChallanId.
const schema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ }, // month the TDS was deducted, YYYY-MM
    challanDate: { type: Date, required: true },
    taxAmount: { type: Number, required: true, min: 0 },
    interestAmount: { type: Number, default: 0, min: 0 },
    feeAmount: { type: Number, default: 0, min: 0 },
    bsrCode: { type: String, trim: true, default: "" },
    challanSerial: { type: String, trim: true, default: "" },
    cin: { type: String, trim: true, default: "" },
    paymentMethod: { type: String, trim: true, uppercase: true, default: "BANK_TRANSFER" },
    expenseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Expense" }],
    status: { type: String, enum: ["POSTED", "CANCELLED"], default: "POSTED", index: true },
    notes: { type: String, trim: true, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

schema.index({ businessId: 1, challanDate: -1 });

// every change is kept in the edit log (books audit trail)
schema.plugin(require("../utils/edit-log.plugin"), { model: "TdsChallan", businessKey: "businessId" });

module.exports = mongoose.model("TdsChallan", schema);
