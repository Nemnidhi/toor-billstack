const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    itemType: {
      type: String,
      enum: ["product", "service"],
      default: "product",
    },
    sku: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    barcode: {
      type: String,
      trim: true,
      default: "",
    },
    category: {
      type: String,
      trim: true,
      default: "",
    },
    unitType: {
      type: String,
      trim: true,
      default: "unit",
    },
    purchasePrice: {
      type: Number,
      default: 0,
    },
    sellingPrice: {
      type: Number,
      default: 0,
    },
    taxRate: {
      type: Number,
      default: 0,
    },
    hsnSac: { type: String, trim: true, default: "" },
    gstClassification: { type: String, trim: true, default: "" },
    discount: {
      type: Number,
      default: 0,
    },
    currentStock: {
      type: Number,
      default: 0,
    },
    openingStock: {
      type: Number,
      default: 0,
    },
    minimumStockLevel: {
      type: Number,
      default: 0,
    },
    trackInventory: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    isLowStock: {
      type: Boolean,
      default: false,
    },
    isOutOfStock: {
      type: Boolean,
      default: false,
    },
    isSampleData: { type: Boolean, default: false, index: true },
    sampleDataKey: { type: String, trim: true, default: "" },
  },
  {
    timestamps: true,
  }
);

productSchema.index({ businessId: 1, name: 1 });
productSchema.index(
  { businessId: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sku: { $type: "string", $gt: "" },
    },
  }
);
productSchema.index({ businessId: 1, category: 1 });
productSchema.index({ businessId: 1, isSampleData: 1 });

module.exports = mongoose.model("Product", productSchema);