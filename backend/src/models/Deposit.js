// Refundable deposits: taken from tenants / members (RECEIVED, a liability) or paid to
// landlords and others (GIVEN, an asset). Refunds, forfeits and adjustments are movements.
const mongoose = require("mongoose");

const movementSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["REFUND", "FORFEIT", "ADJUST_RENT", "WRITE_OFF", "SET_OFF"], required: true },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
    mode: { type: String, enum: ["BANK", "CASH", ""], default: "" },
    note: { type: String, trim: true, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // SET_OFF: the deposit paid the customer's invoices (a receipt with method DEPOSIT_SET_OFF).
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null },
    invoices: { type: [{ _id: false, invoiceId: mongoose.Schema.Types.ObjectId, invoiceNumber: String, amount: Number }], default: undefined },
    // An undone set-off stays on record but no longer counts against the deposit.
    undoneAt: { type: Date, default: null },
    undoneBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: true, timestamps: true }
);

const depositSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    depositNumber: { type: String, trim: true, required: true },
    direction: { type: String, enum: ["RECEIVED", "GIVEN"], required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    partyName: { type: String, trim: true, required: true },
    purpose: { type: String, enum: ["RENT", "SECURITY", "UTILITY", "OTHER"], default: "SECURITY" },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
    mode: { type: String, enum: ["BANK", "CASH"], default: "BANK" },
    reference: { type: String, trim: true, default: "" },
    agreementEnd: { type: Date, default: null },
    centre: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    movements: { type: [movementSchema], default: [] },
    status: { type: String, enum: ["OPEN", "CLOSED", "CANCELLED"], default: "OPEN", index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

depositSchema.virtual("balance").get(function () {
  return Math.round((this.amount - (this.movements || []).filter((m) => !m.undoneAt).reduce((s, m) => s + m.amount, 0)) * 100) / 100;
});
depositSchema.set("toJSON", { virtuals: true });
depositSchema.set("toObject", { virtuals: true });
depositSchema.index({ businessId: 1, depositNumber: 1 }, { unique: true });
depositSchema.index({ businessId: 1, direction: 1, date: -1 });

// every change is kept in the edit log (books audit trail)
depositSchema.plugin(require("../utils/edit-log.plugin"), { model: "Deposit", businessKey: "businessId" });

module.exports = mongoose.model("Deposit", depositSchema);
