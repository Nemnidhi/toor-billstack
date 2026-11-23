const mongoose = require("mongoose");

const recurringItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 },
    rate: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0 },
    discountType: { type: String, enum: ["percent", "amount"], default: "percent" },
    discountValue: { type: Number, default: 0, min: 0 },
    itemTotal: { type: Number, required: true, min: 0 },
    snapshot: { type: Object, default: {} },
  },
  { _id: false }
);

const recurringBillingProfileSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    lineItems: { type: [recurringItemSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    totalTax: { type: Number, default: 0, min: 0 },
    totalDiscount: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    frequency: { type: String, enum: ["WEEKLY", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"], required: true, index: true },
    interval: { type: Number, default: 1, min: 1 },
    startDate: { type: Date, required: true },
    nextBillingDate: { type: Date, required: true, index: true },
    // Property / centre this belongs to (profit by location). Free text, blank = not assigned.
    centre: { type: String, trim: true, maxlength: 80, default: "" },
    // Report tags (see Business.reportingTags): business line (vertical) and category (horizontal).
    businessLine: { type: String, trim: true, maxlength: 60, default: "" },
    reportCategory: { type: String, trim: true, maxlength: 60, default: "" },
    endDate: { type: Date, default: null },
    status: { type: String, enum: ["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"], default: "DRAFT", index: true },
    autoGenerateInvoice: { type: Boolean, default: true },
    paymentTermsDays: { type: Number, default: 0, min: 0 },
    renewalDate: { type: Date, default: null },
    renewalReminderDays: { type: Number, default: 30, min: 0 },
    autoRenew: { type: Boolean, default: false },
    lastGeneratedAt: { type: Date, default: null },
    generatedInvoices: [{ invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice" }, occurrenceKey: { type: String, trim: true }, generatedAt: { type: Date, default: Date.now } }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

recurringBillingProfileSchema.add({ placeOfSupplyCode: { type: String, default: "" } });
recurringBillingProfileSchema.index({ businessId: 1, status: 1, nextBillingDate: 1 });
recurringBillingProfileSchema.index({ businessId: 1, customerId: 1 });
recurringBillingProfileSchema.index({ businessId: 1, "generatedInvoices.occurrenceKey": 1 });

module.exports = mongoose.model("RecurringBillingProfile", recurringBillingProfileSchema);
