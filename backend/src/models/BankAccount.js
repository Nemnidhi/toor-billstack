const mongoose = require("mongoose");

const bankAccountSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    bankName: {
      type: String,
      required: true,
      trim: true,
    },
    accountNumber: {
      type: String,
      required: true,
      trim: true,
    },
    ifscCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    branchName: {
      type: String,
      trim: true,
      default: "",
    },
    accountType: {
      type: String,
      enum: ["CURRENT", "SAVINGS", "OVERDRAFT", "OTHER"],
      default: "CURRENT",
    },
    currency: {
      type: String,
      default: "INR",
    },
    chartAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    openingBalance: {
      type: Number,
      default: 0,
    },
    openingBalanceDate: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

bankAccountSchema.index({ businessId: 1, accountName: 1 });
bankAccountSchema.index({ businessId: 1, accountNumber: 1 });

module.exports = mongoose.model("BankAccount", bankAccountSchema);
