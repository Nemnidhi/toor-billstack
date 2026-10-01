const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true },
  direction: { type: String, enum: ["RECEIVED", "PAID"], required: true, immutable: true },
  amount: { type: Number, required: true, min: 0.01, immutable: true },
  currency: { type: String, trim: true, uppercase: true, default: "INR", immutable: true },
  paymentDate: { type: Date, required: true, default: Date.now, immutable: true },
  paymentMethod: { type: String, trim: true, uppercase: true, default: "OTHER", immutable: true },
  referenceNumber: { type: String, trim: true, default: "", immutable: true },
  idempotencyKey: { type: String, trim: true, default: "", immutable: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true, immutable: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true, immutable: true },
  notes: { type: String, trim: true, default: "", immutable: true },
  status: { type: String, enum: ["POSTED", "REVERSED"], default: "POSTED", immutable: true },
  reversalOfPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null, immutable: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
}, { timestamps: true });
schema.index({ businessId: 1, paymentDate: -1, createdAt: -1 });
schema.index({ businessId: 1, reversalOfPaymentId: 1 }, { unique: true, partialFilterExpression: { reversalOfPaymentId: { $type: "objectId" } } });
schema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string", $ne: "" } } });
schema.pre(["findOneAndUpdate", "updateOne", "updateMany"], () => { throw new Error("Payments are immutable; create a reversal instead."); });
module.exports = mongoose.model("Payment", schema);
