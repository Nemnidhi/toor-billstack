// Fixed asset register: one row per asset (or a group bought together). Companies Act
// depreciation (straight line over the useful life, fit-out over the lease) is posted each year;
// the Income-tax block (WDV) is worked out from the same rows for the tax audit.
const mongoose = require("mongoose");

const yearSchema = new mongoose.Schema(
  {
    fy: { type: String, required: true }, // "25-26"
    amount: { type: Number, required: true, min: 0 },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    sourceKey: { type: String, default: "" },
  },
  { _id: false }
);

const fixedAssetSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    assetNumber: { type: String, trim: true, required: true },
    name: { type: String, trim: true, required: true },
    assetClass: { type: String, required: true },
    centre: { type: String, trim: true, default: "" },
    location: { type: String, trim: true, default: "" },
    quantity: { type: Number, default: 1, min: 1 },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null },
    billNumber: { type: String, trim: true, default: "" },
    purchaseDate: { type: Date, required: true },
    putToUseDate: { type: Date, required: true },
    cost: { type: Number, required: true, min: 0.01 }, // without GST that was claimed as credit
    // how the cost reached the books: a bill already entered (moved from its expense head), paid now,
    // owed to the supplier, or an asset owned before the books started here (opening)
    source: { type: String, enum: ["BILL", "PAID", "PAYABLE", "OPENING"], required: true },
    expenseId: { type: mongoose.Schema.Types.ObjectId, ref: "Expense", default: null },
    purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null },
    paidMode: { type: String, enum: ["BANK", "CASH", ""], default: "" },
    // Companies Act (Schedule II)
    usefulLifeYears: { type: Number, required: true, min: 0.1 },
    residualPercent: { type: Number, default: 5, min: 0, max: 100 },
    leaseEndDate: { type: Date, default: null }, // fit-out in rented premises: written off by this day
    // Income-tax block (rate of the block, e.g. 10 furniture / 15 plant / 40 computers)
    itRate: { type: Number, required: true, min: 0, max: 100 },
    // assets owned before the books started here
    openingDate: { type: Date, default: null },
    openingAccumulated: { type: Number, default: 0, min: 0 },
    openingItWdv: { type: Number, default: null },
    depreciation: { type: [yearSchema], default: [] },
    disposal: {
      date: { type: Date, default: null },
      amount: { type: Number, default: 0, min: 0 },
      mode: { type: String, enum: ["BANK", "CASH", ""], default: "" },
      note: { type: String, trim: true, default: "" },
      gainOrLoss: { type: Number, default: 0 },
    },
    status: { type: String, enum: ["IN_USE", "DISPOSED", "CANCELLED"], default: "IN_USE", index: true },
    note: { type: String, trim: true, default: "" },
    attachments: { type: [require("./documentAttachment.schema")], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

fixedAssetSchema.index({ businessId: 1, assetNumber: 1 }, { unique: true });
fixedAssetSchema.index({ businessId: 1, expenseId: 1 }, { unique: true, partialFilterExpression: { expenseId: { $type: "objectId" } } });

// every change is kept in the edit log (books audit trail)
fixedAssetSchema.plugin(require("../utils/edit-log.plugin"), { model: "FixedAsset", businessKey: "businessId" });

module.exports = mongoose.model("FixedAsset", fixedAssetSchema);
