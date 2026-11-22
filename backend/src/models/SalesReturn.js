const mongoose = require("mongoose");
const line = new mongoose.Schema({ invoiceLineIndex: { type: Number, min: 0, required: true }, productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true }, quantity: { type: Number, min: 0.01, required: true } }, { _id: false });
const schema = new mongoose.Schema({ businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true }, invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true, immutable: true }, customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, immutable: true }, returnNumber: { type: String, required: true, immutable: true }, sourceKey: { type: String, trim: true, default: "", immutable: true }, lineItems: { type: [line], required: true, immutable: true }, totalAmount: { type: Number, min: 0, default: 0, immutable: true }, status: { type: String, enum: ["ISSUED", "CANCELLED"], default: "ISSUED", immutable: true }, createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true } }, { timestamps: true });
schema.index({ businessId: 1, returnNumber: 1 }, { unique: true });
schema.index({ businessId: 1, sourceKey: 1 }, { unique: true, partialFilterExpression: { sourceKey: { $type: "string", $ne: "" } } });
schema.pre(["findOneAndUpdate", "updateOne", "updateMany", "findOneAndDelete", "deleteOne", "deleteMany"], () => { throw new Error("Sales returns are immutable."); });
// every change is kept in the edit log (books audit trail)
schema.plugin(require("../utils/edit-log.plugin"), { model: "SalesReturn", businessKey: "businessId" });

module.exports = mongoose.model("SalesReturn", schema);
