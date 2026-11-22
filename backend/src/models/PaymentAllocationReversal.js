const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true },
  allocationId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentAllocation", required: true, index: true, immutable: true },
  amount: { type: Number, required: true, min: 0.01, immutable: true },
  reason: { type: String, required: true, trim: true, immutable: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
}, { timestamps: true });
schema.index({ businessId: 1, allocationId: 1 }, { unique: true });
schema.pre(["findOneAndUpdate", "updateOne", "updateMany", "findOneAndDelete", "deleteOne", "deleteMany"], () => { throw new Error("Allocation reversals are append-only."); });
// every change is kept in the edit log (books audit trail)
schema.plugin(require("../utils/edit-log.plugin"), { model: "PaymentAllocationReversal", businessKey: "businessId" });

module.exports = mongoose.model("PaymentAllocationReversal", schema);
