const mongoose = require("mongoose");

// The TDS lines of a Form 26AS / AIS download for one financial year (the latest import wins).
const row = new mongoose.Schema(
  {
    deductorName: { type: String, trim: true, default: "" },
    deductorTan: { type: String, trim: true, uppercase: true, default: "" },
    section: { type: String, trim: true, default: "" },
    transactionDate: { type: Date, default: null },
    amountPaid: { type: Number, default: 0 },
    taxDeducted: { type: Number, default: 0 },
    quarter: { type: String, default: "" },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    fy: { type: String, required: true },
    fileName: { type: String, trim: true, default: "" },
    rows: { type: [row], default: [] },
    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

schema.index({ businessId: 1, fy: 1, createdAt: -1 });

module.exports = mongoose.model("Tds26asImport", schema);
