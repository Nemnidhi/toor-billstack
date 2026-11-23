const mongoose = require("mongoose");

// A Razorpay settlement (money Razorpay sent to the company's bank). Posted to the books by itself
// (Dr Bank 1020 / Cr Razorpay - Settlements Due 1030) only when every payment and refund in it is
// already recorded in BillStack and the amounts add up; otherwise it waits here for the accountant,
// with the lines BillStack doesn't know (payments from other Razorpay pages, adjustments, ...).
const lineSchema = new mongoose.Schema(
  {
    type: { type: String, trim: true, default: "" },
    entityId: { type: String, trim: true, default: "" },
    paymentId: { type: String, trim: true, default: "" },
    creditMinor: { type: Number, default: 0 },
    debitMinor: { type: Number, default: 0 },
    feeMinor: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    inBillStack: { type: Boolean, default: false },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    description: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const onlinePaymentSettlementSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true },
    provider: { type: String, enum: ["RAZORPAY"], default: "RAZORPAY", immutable: true },
    settlementId: { type: String, trim: true, required: true, immutable: true },
    utr: { type: String, trim: true, default: "" },
    amountMinor: { type: Number, required: true },
    settledAt: { type: Date, default: null },
    // POSTED: in the books. NEEDS_REVIEW: waiting for the accountant (reason says why).
    // RECORDED_BY_HAND: the accountant booked it themselves; BillStack posts nothing.
    status: { type: String, enum: ["POSTED", "NEEDS_REVIEW", "RECORDED_BY_HAND"], default: "NEEDS_REVIEW", index: true },
    reason: { type: String, trim: true, default: "" },
    lines: { type: [lineSchema], default: [] },
    journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

onlinePaymentSettlementSchema.index({ businessId: 1, settlementId: 1 }, { unique: true });
onlinePaymentSettlementSchema.index({ businessId: 1, createdAt: -1 });

module.exports = mongoose.model("OnlinePaymentSettlement", onlinePaymentSettlementSchema);
