const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"],
      required: true,
    },
    normalBalance: {
      type: String,
      enum: ["DEBIT", "CREDIT"],
      required: true,
    },
    isSystem: {
      type: Boolean,
      default: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

accountSchema.index({ businessId: 1, code: 1 }, { unique: true });
accountSchema.index({ businessId: 1, type: 1 });

module.exports = mongoose.model("Account", accountSchema);
