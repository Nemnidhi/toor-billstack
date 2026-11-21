const mongoose = require("mongoose");
const {
  EXPENSE_CATEGORIES,
  EXPENSE_GST_TYPES,
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_PAYMENT_STATUSES,
  EXPENSE_STATUSES,
} = require("../constants/expenses");

const expenseAttachmentSchema = new mongoose.Schema(
  {
    originalName: { type: String, trim: true, default: "" },
    mimeType: { type: String, trim: true, default: "" },
    size: { type: Number, default: 0, min: 0 },
    url: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const expenseSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    expenseNumber: { type: String, required: true, trim: true },
    expenseDate: { type: Date, required: true, index: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: "Miscellaneous", index: true },
    customCategory: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    vendorName: { type: String, trim: true, default: "" },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Supplier", default: null, index: true },
    amountBeforeTax: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    balanceAmount: { type: Number, default: 0, min: 0 },
    gstEnabled: { type: Boolean, default: false },
    gstRate: { type: Number, default: 0, min: 0, max: 100 },
    gstType: { type: String, enum: EXPENSE_GST_TYPES, default: "NONE" },
    gstSnapshot: { type: Object, default: null },
    paymentStatus: { type: String, enum: EXPENSE_PAYMENT_STATUSES, default: "UNPAID", index: true },
    paymentMethod: { type: String, enum: EXPENSE_PAYMENT_METHODS, default: "" },
    referenceNumber: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    // TDS we deduct from this bill (rent to a landlord, professional fees, ...). The supplier is paid
    // totalAmount - tdsAmount; tdsAmount goes to TDS payable until a challan deposits it.
    tdsKind: { type: String, trim: true, uppercase: true, default: "" },
    tdsRate: { type: Number, min: 0, max: 100, default: 0 },
    tdsAmount: { type: Number, min: 0, default: 0 },
    tdsChallanId: { type: mongoose.Schema.Types.ObjectId, ref: "TdsChallan", default: null, index: true },
    // The supplier's own bill (for GSTR-2B / IMS matching) and whether its GST can be claimed.
    supplierInvoiceNumber: { type: String, trim: true, maxlength: 40, default: "" },
    supplierInvoiceDate: { type: Date, default: null },
    supplierGstin: { type: String, trim: true, uppercase: true, default: "" },
    placeOfSupplyCode: { type: String, trim: true, default: "" },
    // false = blocked credit (s.17(5): food, motor vehicles, personal use ...): the GST is a cost
    itcEligible: { type: Boolean, default: true },
    // Reverse charge: our own self-invoice number (FY series), raised on the day we receive the supply
    selfInvoiceNumber: { type: String, trim: true, default: "" },
    // Property / centre this belongs to (profit by location). Free text, blank = not assigned.
    centre: { type: String, trim: true, maxlength: 80, default: "" },
    receipt: { type: expenseAttachmentSchema, default: () => ({}) },
    attachments: { type: [require("./documentAttachment.schema")], default: [] },
    // when the bill was fully paid (for the MSME 45-day report)
    paidOn: { type: Date, default: null },
    status: { type: String, enum: EXPENSE_STATUSES, default: "ACTIVE", index: true },
    cancellationReason: { type: String, trim: true, default: "" },
    cancelledAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

expenseSchema.index({ businessId: 1, expenseNumber: 1 }, { unique: true });
expenseSchema.pre("save", function () {
  if (!this.isNew && !this.isModified("paidAmount") && !this.isModified("balanceAmount")) return;
  if (Number(this.balanceAmount || 0) <= 0.004 && Number(this.paidAmount || 0) > 0) {
    if (!this.paidOn) this.paidOn = this.isNew ? this.expenseDate : new Date();
  } else {
    this.paidOn = null;
  }
});

expenseSchema.index({ businessId: 1, expenseDate: -1 });
expenseSchema.index({ businessId: 1, category: 1, expenseDate: -1 });
expenseSchema.index({ businessId: 1, paymentStatus: 1, expenseDate: -1 });
expenseSchema.index({ businessId: 1, status: 1, expenseDate: -1 });

expenseSchema.index({ businessId: 1, selfInvoiceNumber: 1 }, { unique: true, partialFilterExpression: { selfInvoiceNumber: { $gt: "" } } });

// every change is kept in the edit log (books audit trail)
expenseSchema.plugin(require("../utils/edit-log.plugin"), { model: "Expense", businessKey: "businessId" });

module.exports = mongoose.model("Expense", expenseSchema);
