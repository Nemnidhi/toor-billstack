const mongoose = require("mongoose");

const journalLineSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
    },
    accountCode: {
      type: String,
      required: true,
      trim: true,
    },
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    debitMinor: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    creditMinor: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false }
);

const journalEntrySchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
      immutable: true,
    },
    entryNumber: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    entryDate: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    sourceType: {
      type: String,
      enum: ["INVOICE", "PAYMENT", "PAYMENT_ALLOCATION", "EXPENSE", "MANUAL", "REVERSAL"],
      required: true,
      immutable: true,
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      immutable: true,
    },
    sourceKey: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ["POSTED", "REVERSED"],
      default: "POSTED",
    },
    reversalOfEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JournalEntry",
      default: null,
      immutable: true,
    },
    lines: {
      type: [journalLineSchema],
      required: true,
      validate: [
        {
          validator: (lines) => Array.isArray(lines) && lines.length >= 2,
          message: "A journal entry must contain at least two lines",
        },
        {
          validator: (lines) => {
            const debits = lines.reduce((sum, l) => sum + (l.debitMinor || 0), 0);
            const credits = lines.reduce((sum, l) => sum + (l.creditMinor || 0), 0);
            return debits === credits && debits > 0;
          },
          message: "Journal entry debits must balance credits and be greater than zero",
        },
      ],
      immutable: true,
    },
    totalDebitMinor: {
      type: Number,
      required: true,
      immutable: true,
    },
    totalCreditMinor: {
      type: Number,
      required: true,
      immutable: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
    },
  },
  { timestamps: true }
);

journalEntrySchema.index({ businessId: 1, sourceKey: 1 }, { unique: true });
journalEntrySchema.index({ businessId: 1, entryDate: -1, createdAt: -1 });
journalEntrySchema.index({ businessId: 1, "lines.accountId": 1, entryDate: 1 });

journalEntrySchema.pre(["findOneAndUpdate", "updateOne", "updateMany", "deleteOne", "deleteMany"], () => {
  throw new Error("Journal entries are immutable financial records. To void an entry, post a reversing entry.");
});

module.exports = mongoose.model("JournalEntry", journalEntrySchema);
