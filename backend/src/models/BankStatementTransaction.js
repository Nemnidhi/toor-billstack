const mongoose = require("mongoose");

const bankStatementTransactionSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    bankAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BankAccount",
      required: true,
      index: true,
    },
    transactionDate: {
      type: Date,
      required: true,
      index: true,
    },
    valueDate: {
      type: Date,
      default: null,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    reference: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    direction: {
      type: String,
      enum: ["INFLOW", "OUTFLOW"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    amountMinor: {
      type: Number,
      required: true,
      min: 1,
    },
    runningBalance: {
      type: Number,
      default: null,
    },
    importBatchId: {
      type: String,
      default: "",
      index: true,
    },
    importFingerprint: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["UNMATCHED", "SUGGESTED_MATCH", "MATCHED", "IGNORED"],
      default: "UNMATCHED",
      index: true,
    },
    reconciledJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalEntry",
      default: null,
      index: true,
    },
    reconciledLineId: {
      type: String,
      default: "",
    },
    reconciledAt: {
      type: Date,
      default: null,
    },
    reconciledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    suggestedMatches: {
      type: [
        {
          journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
          entryNumber: String,
          entryDate: Date,
          description: String,
          reference: String,
          amount: Number,
          amountMinor: Number,
          confidence: String, // "EXACT", "HIGH", "MEDIUM"
          matchReason: String,
        },
      ],
      default: [],
    },
    notes: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

bankStatementTransactionSchema.index(
  { businessId: 1, bankAccountId: 1, importFingerprint: 1 },
  { unique: true }
);

bankStatementTransactionSchema.index({ businessId: 1, status: 1 });
bankStatementTransactionSchema.index({ businessId: 1, bankAccountId: 1, transactionDate: 1 });

module.exports = mongoose.model("BankStatementTransaction", bankStatementTransactionSchema);
