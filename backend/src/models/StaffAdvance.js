const mongoose = require("mongoose");

// Money paid to a staff member ahead of salary (Dr 1160 Staff Advances / Cr bank or cash).
// It comes back through the CRM salary sheet as a deduction booked as "Staff advance".
const staffAdvanceSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    externalUserId: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
    mode: { type: String, enum: ["BANK", "CASH"], default: "BANK" },
    reference: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["ACTIVE", "CANCELLED"], default: "ACTIVE" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

staffAdvanceSchema.index({ businessId: 1, date: -1 });
staffAdvanceSchema.plugin(require("../utils/edit-log.plugin"), { model: "StaffAdvance", businessKey: "businessId" });

module.exports = mongoose.model("StaffAdvance", staffAdvanceSchema);
