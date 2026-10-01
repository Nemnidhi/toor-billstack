const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
  role: { type: String, enum: ["admin", "accountant", "staff"], required: true },
}, { timestamps: true });
schema.index({ userId: 1, businessId: 1 }, { unique: true });
module.exports = mongoose.model("BusinessMembership", schema);
