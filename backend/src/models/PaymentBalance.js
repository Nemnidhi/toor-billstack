const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true, unique: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
  totalMinor: { type: Number, required: true, min: 1 },
  allocatedMinor: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true });

schema.index({ businessId: 1, paymentId: 1 });

module.exports = mongoose.model("PaymentBalance", schema);
