const mongoose = require("mongoose");

const invoiceLineItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
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
      required: true,
      min: 0,
    },
    rate: {
      type: Number,
      required: true,
      min: 0,
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0,
    },
    discountType: {
      type: String,
      enum: ["percent", "amount"],
      default: "percent",
    },
    discountValue: {
      type: Number,
      default: 0,
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
    taxableAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    itemTotal: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

const invoicePartySnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    address: { type: String, trim: true, default: "" },
    gstNumber: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    invoiceNumber: {
      type: String,
      required: true,
      trim: true,
    },
    sourceQuoteId: { type: mongoose.Schema.Types.ObjectId, ref: "Quote", default: null, immutable: true, index: true },
    sourceOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null, immutable: true, index: true },
    sourceRecurringProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "RecurringBillingProfile", default: null, immutable: true, index: true },
    recurringOccurrenceKey: { type: String, trim: true, default: "", immutable: true },
    gstSnapshot: { type: Object, default: null },
    gstBreakup: { cgst: { type: Number, default: 0 }, sgst: { type: Number, default: 0 }, utgst: { type: Number, default: 0 }, igst: { type: Number, default: 0 }, taxableValue: { type: Number, default: 0 }, hsnSacSummary: { type: Object, default: {} } },
    invoiceDate: {
      type: Date,
      required: true,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    customerDetails: {
      type: invoicePartySnapshotSchema,
      default: () => ({}),
    },
    sellerSnapshot: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    // Phase 2: CRM source reference for duplicate invoice prevention.
    // source + sourceType + sourceId + billingPurpose + billingPeriod form the idempotency key.
    // Enforced unique at DB level (partial: only when set). Immutable once written.
    crmSourceRef: {
      type: new mongoose.Schema({
        source: { type: String, trim: true, immutable: true },
        sourceType: { type: String, trim: true, immutable: true },
        sourceId: { type: String, trim: true, immutable: true },
        billingPurpose: { type: String, trim: true, immutable: true },
        billingPeriod: { type: String, trim: true, default: "", immutable: true },
      }, { _id: false }),
      default: null,
      immutable: true,
    },
    businessDetails: {
      type: invoicePartySnapshotSchema,
      default: () => ({}),
    },
    lineItems: {
      type: [invoiceLineItemSchema],
      default: [],
    },
    subtotal: { type: Number, required: true, min: 0 },
    totalTax: { type: Number, default: 0 },
    totalDiscount: { type: Number, default: 0 },
    shippingCharges: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0, min: 0 },
    paymentStatus: {
      type: String,
      enum: ["paid", "partial", "unpaid", "cancelled"],
      default: "unpaid",
    },
    notes: { type: String, trim: true, default: "" },
    termsAndConditions: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["draft", "issued", "cancelled"],
      default: "issued",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    isSampleData: { type: Boolean, default: false, index: true },
    sampleDataKey: { type: String, trim: true, default: "" },
  },
  {
    timestamps: true,
  }
);

invoiceSchema.index({ businessId: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ businessId: 1, sourceQuoteId: 1 }, { unique: true, partialFilterExpression: { sourceQuoteId: { $type: "objectId" } } });
invoiceSchema.index({ businessId: 1, sourceOrderId: 1 }, { unique: true, partialFilterExpression: { sourceOrderId: { $type: "objectId" } } });
invoiceSchema.index({ businessId: 1, recurringOccurrenceKey: 1 }, { unique: true, partialFilterExpression: { recurringOccurrenceKey: { $type: "string", $ne: "" } } });
invoiceSchema.index({ businessId: 1, customerId: 1, invoiceDate: -1 });
invoiceSchema.index({ businessId: 1, status: 1, invoiceDate: -1 });
invoiceSchema.index({ businessId: 1, isSampleData: 1 });

// Unique: one invoice per CRM source event per business
invoiceSchema.index(
  { businessId: 1, "crmSourceRef.source": 1, "crmSourceRef.sourceType": 1, "crmSourceRef.sourceId": 1, "crmSourceRef.billingPurpose": 1, "crmSourceRef.billingPeriod": 1 },
  { unique: true, partialFilterExpression: { "crmSourceRef.sourceId": { $type: "string", $gt: "" } } }
);

invoiceSchema.pre("save", async function () {
  const business = await require("./Business").findById(this.businessId).session(this.$session());
  if (this.isNew) {
    if (business) this.sellerSnapshot = require("../services/seller-snapshot.service").sellerSnapshot(business);
  }
  if (business?.billingEntityCode === "GOLDHAWK" && (this.totalTax !== 0 || this.lineItems.some(line => line.taxRate || line.tax || line.taxAmount) || this.gstSnapshot)) {
    throw new Error("Goldhawk invoices must not contain GST");
  }
});
module.exports = mongoose.model("Invoice", invoiceSchema);
