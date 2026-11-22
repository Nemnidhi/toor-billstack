const mongoose = require("mongoose");

// One GSTR-2B statement (the supplier bills the GST portal says were filed against our GSTIN)
// for a return period, as downloaded from the portal. The latest import for a period wins.
// imsAction is our decision on each bill in the Invoice Management System: the portal treats
// no action as accepted when GSTR-2B is generated; the action is taken on the portal itself.
const row = new mongoose.Schema({
  section: { type: String, enum: ["B2B", "CDNR", "B2BA", "CDNRA", "ISD", "IMPG"], default: "B2B" },
  supplierGstin: { type: String, trim: true, uppercase: true, default: "" },
  supplierName: { type: String, trim: true, default: "" },
  invoiceNumber: { type: String, trim: true, default: "" },
  invoiceDate: { type: Date, default: null },
  noteType: { type: String, default: "" }, // C / D for credit / debit notes
  invoiceValue: { type: Number, default: 0 },
  placeOfSupply: { type: String, default: "" },
  reverseCharge: { type: Boolean, default: false },
  taxableValue: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  cess: { type: Number, default: 0 },
  itcAvailable: { type: Boolean, default: true },
  itcReason: { type: String, default: "" },
  imsAction: { type: String, enum: ["PENDING", "ACCEPTED", "REJECTED"], default: "PENDING" },
  imsNote: { type: String, trim: true, default: "" },
});

const schema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ }, // YYYY-MM return period
    fileName: { type: String, trim: true, default: "" },
    format: { type: String, enum: ["JSON", "XLSX", "CSV"], default: "JSON" },
    rows: { type: [row], default: [] },
    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

schema.index({ businessId: 1, period: 1, createdAt: -1 });

module.exports = mongoose.model("Gstr2bImport", schema);
