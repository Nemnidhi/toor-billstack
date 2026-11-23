const mongoose = require("mongoose");

// A Razorpay payment link for an invoice's unpaid amount, made with the business's own Razorpay
// account. One open link per invoice: when the amount due changes the old link is cancelled and a new
// one made. When the customer pays, the payment is recorded against the invoice by the webhook.
const onlinePaymentLinkSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, index: true, immutable: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true, immutable: true },
    provider: { type: String, enum: ["RAZORPAY"], default: "RAZORPAY", immutable: true },
    providerLinkId: { type: String, trim: true, required: true, immutable: true },
    referenceId: { type: String, trim: true, required: true, immutable: true },
    url: { type: String, trim: true, default: "" },
    amountMinor: { type: Number, required: true, immutable: true },
    // OPEN: can be paid. PAID: paid and recorded. PAID_NOT_RECORDED: paid at Razorpay, but BillStack
    // could not record it (reason in recordError) - record again from the invoice. CANCELLED: replaced.
    status: { type: String, enum: ["OPEN", "PAID", "PAID_NOT_RECORDED", "CANCELLED", "EXPIRED"], default: "OPEN", index: true },
    providerPaymentId: { type: String, trim: true, default: "" },
    paidAmountMinor: { type: Number, default: 0 },
    feeMinor: { type: Number, default: 0 },
    taxMinor: { type: Number, default: 0 },
    paidAt: { type: Date, default: null },
    paymentMethod: { type: String, trim: true, default: "" },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null },
    recordError: { type: String, trim: true, default: "" },
    // Refunds made in Razorpay on this link's payment. NOT_RECORDED until the accountant reverses the
    // payment (full refund, one click) or records it another way (credit note) and marks it done.
    refunds: [{
      _id: false,
      refundId: { type: String, trim: true, required: true },
      amountMinor: { type: Number, required: true },
      refundedAt: { type: Date, default: null },
      status: { type: String, enum: ["NOT_RECORDED", "RECORDED"], default: "NOT_RECORDED" },
      recordedHow: { type: String, trim: true, default: "" },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      recordedAt: { type: Date, default: null },
    }],
    cancelledAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

onlinePaymentLinkSchema.index({ businessId: 1, providerLinkId: 1 }, { unique: true });
onlinePaymentLinkSchema.index({ businessId: 1, invoiceId: 1, status: 1 });
// At most one open link per invoice.
onlinePaymentLinkSchema.index({ businessId: 1, invoiceId: 1 }, { unique: true, partialFilterExpression: { status: "OPEN" }, name: "one_open_link_per_invoice" });

module.exports = mongoose.model("OnlinePaymentLink", onlinePaymentLinkSchema);
