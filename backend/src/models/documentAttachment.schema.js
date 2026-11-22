// A document attached to a book record (purchase bill, expense receipt, landlord / supplier
// agreement). Files live in uploads/documents (never served publicly) and are read through the
// authenticated /api/accounting/documents routes.
const mongoose = require("mongoose");

module.exports = new mongoose.Schema(
  {
    fileName: { type: String, trim: true, required: true },
    storedName: { type: String, trim: true, required: true },
    mimeType: { type: String, trim: true, required: true },
    size: { type: Number, min: 0, required: true },
    kind: { type: String, enum: ["BILL", "AGREEMENT", "RECEIPT", "CERTIFICATE", "OTHER"], default: "OTHER" },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    note: { type: String, trim: true, default: "" },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);
