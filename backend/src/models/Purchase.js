const mongoose = require("mongoose");

const purchaseItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    purchasePrice: {
      type: Number,
      required: true,
      min: 0,
    },
    tax: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const purchaseSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    productsPurchased: {
      type: [purchaseItemSchema],
      default: [],
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    gstSnapshot: { type: Object, default: null },
    gstBreakup: { cgst: { type: Number, default: 0 }, sgst: { type: Number, default: 0 }, utgst: { type: Number, default: 0 }, igst: { type: Number, default: 0 }, taxableValue: { type: Number, default: 0 }, inputTaxCreditEligible: { type: Boolean, default: false } },
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    paymentStatus: {
      type: String,
      enum: ["paid", "partial", "unpaid"],
      default: "unpaid",
    },
    // The supplier's own bill number and date (for GSTR-2B / IMS matching).
    supplierInvoiceNumber: { type: String, trim: true, maxlength: 40, default: "" },
    supplierInvoiceDate: { type: Date, default: null },
    // Property / centre this belongs to (profit by location). Free text, blank = not assigned.
    centre: { type: String, trim: true, maxlength: 80, default: "" },
    // Report tags (see Business.reportingTags): business line (vertical) and category (horizontal).
    businessLine: { type: String, trim: true, maxlength: 60, default: "" },
    reportCategory: { type: String, trim: true, maxlength: 60, default: "" },
    purchaseDate: {
      type: Date,
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

purchaseSchema.add({ attachments: { type: [require("./documentAttachment.schema")], default: [] } });

purchaseSchema.index({ businessId: 1, supplierId: 1, purchaseDate: -1 });

// every change is kept in the edit log (books audit trail)
purchaseSchema.plugin(require("../utils/edit-log.plugin"), { model: "Purchase", businessKey: "businessId" });

module.exports = mongoose.model("Purchase", purchaseSchema);
