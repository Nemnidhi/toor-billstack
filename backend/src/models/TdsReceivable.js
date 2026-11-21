const mongoose = require("mongoose");

// One row per customer receipt from which the customer deducted TDS. Tracks the
// certificate (Form 131, formerly 16A) and whether Form 26AS / AIS shows the credit.
const schema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true, immutable: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true, immutable: true },
    tdsKind: { type: String, trim: true, default: "" },
    amount: { type: Number, required: true, min: 0.01, immutable: true },
    grossAmount: { type: Number, required: true, min: 0.01, immutable: true },
    deductedOn: { type: Date, required: true, immutable: true },
    fy: { type: String, required: true, index: true },
    quarter: { type: String, required: true },
    deductorTan: { type: String, trim: true, uppercase: true, default: "" },
    status: { type: String, enum: ["OPEN", "REVERSED"], default: "OPEN", index: true },
    certificateNumber: { type: String, trim: true, default: "" },
    certificateReceivedAt: { type: Date, default: null },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

schema.index({ businessId: 1, paymentId: 1 }, { unique: true });
schema.index({ businessId: 1, fy: 1, quarter: 1 });

// every change is kept in the edit log (books audit trail)
schema.plugin(require("../utils/edit-log.plugin"), { model: "TdsReceivable", businessKey: "businessId" });

module.exports = mongoose.model("TdsReceivable", schema);
