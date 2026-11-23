const mongoose = require("mongoose");

const invoiceHistorySchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      trim: true,
      default: "",
    },
    amount: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      trim: true,
      default: "draft",
    },
    issuedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
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
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    billingAddress: {
      type: String,
      trim: true,
      default: "",
    },
    shippingAddress: {
      type: String,
      trim: true,
      default: "",
    },
    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    stateCode: { type: String, trim: true, default: "" },
    placeOfSupplyCode: { type: String, trim: true, default: "" },
    // Income-tax identity: PAN of the party; TAN when the customer deducts TDS from what it pays us.
    pan: { type: String, trim: true, uppercase: true, default: "" },
    tan: { type: String, trim: true, uppercase: true, default: "" },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    // The customer agreed to get invoices, reminders and receipts on WhatsApp (Meta requires it).
    // Recorded with when and how it was given; un-ticking keeps the history of when it was withdrawn.
    whatsappConsent: {
      given: { type: Boolean, default: false },
      at: { type: Date, default: null },
      source: { type: String, trim: true, default: "", maxlength: 120 },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      withdrawnAt: { type: Date, default: null },
    },
    invoiceHistory: {
      type: [invoiceHistorySchema],
      default: [],
    },
    isSampleData: { type: Boolean, default: false, index: true },
    sampleDataKey: { type: String, trim: true, default: "" },
  },
  {
    timestamps: true,
  }
);

customerSchema.index({ businessId: 1, name: 1 });
customerSchema.index({ businessId: 1, email: 1 });
customerSchema.index({ businessId: 1, phone: 1 });
customerSchema.index({ businessId: 1, _id: 1 });
customerSchema.index({ businessId: 1, isSampleData: 1 });

// every change is kept in the edit log (books audit trail)
customerSchema.plugin(require("../utils/edit-log.plugin"), { model: "Customer", businessKey: "businessId" });

module.exports = mongoose.model("Customer", customerSchema);
