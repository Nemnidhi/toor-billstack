const mongoose = require("mongoose");

const integrationHandoffSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true, immutable: true, index: true },
    credentialId: { type: mongoose.Schema.Types.ObjectId, ref: "IntegrationCredential", required: true, immutable: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, immutable: true },
    tokenHash: { type: String, required: true, immutable: true, unique: true, select: false },
    purpose: { type: String, enum: ["INVOICE_CREATE"], default: "INVOICE_CREATE", immutable: true },
    returnUrl: { type: String, trim: true, default: "" },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Phase 2: entity routing + source idempotency + prefill context from CRM.
    // Immutable once created; CRM is the authority. Never invent or mutate.
    billingContext: {
      type: new mongoose.Schema({
        // RESIDENTIAL => Goldhawk (GST off); COMMERCIAL | COWORKING => TOOR (GST on)
        billingType: { type: String, enum: ["RESIDENTIAL", "COMMERCIAL", "COWORKING"], immutable: true },
        // Resolved billing entity code - drives entity auto-switch on consume
        billingEntityCode: { type: String, enum: ["", "GOLDHAWK"], default: "", immutable: true },
        // Stable source reference used for duplicate invoice prevention
        sourceRef: {
          type: new mongoose.Schema({
            source: { type: String, trim: true, immutable: true },       // "THE_OFFICE_ON_RENT_CRM"
            sourceType: { type: String, trim: true, immutable: true },   // "lead" | "coworking-booking" | "coworking-contract"
            sourceId: { type: String, trim: true, immutable: true },     // CRM entity _id (string)
            billingPurpose: { type: String, trim: true, immutable: true }, // "BROKERAGE" | "RENT" | "MONTHLY_COWORKING"
            billingPeriod: { type: String, trim: true, immutable: true }, // "2026-10" for recurring, "" otherwise
          }, { _id: false }),
          default: null,
          immutable: true,
        },
        // Optional prefill - user must review before issuing. Never auto-issue.
        prefill: {
          type: new mongoose.Schema({
            notes: { type: String, trim: true, maxlength: 500, default: "" },
            reference: { type: String, trim: true, maxlength: 200, default: "" },
            lineItems: {
              type: [{
                productName: { type: String, trim: true },
                quantity: { type: Number, default: 1 },
                rate: { type: Number, default: 0 },           // 0 = not reliably known; user must confirm
                rateReliable: { type: Boolean, default: false }, // true only when CRM has confirmed final value
              }],
              default: [],
            },
          }, { _id: false }),
          default: () => ({}),
        },
      }, { _id: false }),
      default: null,
      immutable: true,
    },
  },
  { timestamps: true }
);

integrationHandoffSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
integrationHandoffSchema.index({ businessId: 1, customerId: 1, purpose: 1 });

module.exports = mongoose.model("IntegrationHandoff", integrationHandoffSchema);
