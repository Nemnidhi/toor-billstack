const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", required: true, index: true, immutable: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null, index: true, immutable: true },
  purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null, index: true, immutable: true },
  allocatedAmount: { type: Number, required: true, min: 0.01, immutable: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
}, { timestamps: true });
schema.index({ paymentId: 1, invoiceId: 1 }, { unique: true, partialFilterExpression: { invoiceId: { $type: "objectId" } } });
schema.index({ paymentId: 1, purchaseId: 1 }, { unique: true, partialFilterExpression: { purchaseId: { $type: "objectId" } } });
schema.pre(["findOneAndUpdate", "updateOne", "updateMany"], () => { throw new Error("Payment allocations are immutable."); });
// every change is kept in the edit log (books audit trail)
schema.plugin(require("../utils/edit-log.plugin"), { model: "PaymentAllocation", businessKey: "businessId" });

module.exports = mongoose.model("PaymentAllocation", schema);
