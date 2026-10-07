const mongoose = require("mongoose");

const line = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
      required: false,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    hsnSac: {
      type: String,
      trim: true,
      default: "",
    },
    gstClassification: {
      type: String,
      trim: true,
      uppercase: true,
      default: "TAXABLE",
    },
    isManual: {
      type: Boolean,
      default: false,
    },
    quantity: {
      type: Number,
      min: 0.01,
      required: true,
    },
    rate: {
      type: Number,
      min: 0,
      required: true,
    },
    taxRate: {
      type: Number,
      min: 0,
      default: 0,
    },
    discountType: {
      type: String,
      enum: ["percent", "amount"],
      default: "percent",
    },
    discountValue: {
      type: Number,
      min: 0,
      default: 0,
    },
    taxableAmount: {
      type: Number,
      default: 0,
    },
    taxAmount: {
      type: Number,
      default: 0,
    },
    tax: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    itemTotal: {
      type: Number,
      min: 0,
      required: true,
    },
  },
  { _id: false }
);

const schema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
      immutable: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    quoteNumber: {
      type: String,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CONVERTED"],
      default: "DRAFT",
    },
    lineItems: {
      type: [line],
      default: [],
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },
    totalTax: {
      type: Number,
      default: 0,
    },
    totalDiscount: {
      type: Number,
      default: 0,
    },
    shippingCharges: {
      type: Number,
      default: 0,
    },
    roundOff: {
      type: Number,
      default: 0,
    },
    grandTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    placeOfSupplyCode: {
      type: String,
      default: "",
    },
    gstSnapshot: {
      type: Object,
      default: null,
    },
    customerSnapshot: {
      type: Object,
      default: {},
    },
    businessSnapshot: {
      type: Object,
      default: {},
    },
    convertedInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
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

schema.index({ businessId: 1, quoteNumber: 1 }, { unique: true });
schema.index(
  { businessId: 1, convertedInvoiceId: 1 },
  {
    unique: true,
    partialFilterExpression: { convertedInvoiceId: { $type: "objectId" } },
  }
);

module.exports = mongoose.model("Quote", schema);