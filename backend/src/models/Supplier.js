const mongoose = require("mongoose");

const supplierSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    supplierName: {
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
    address: {
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
    // Income-tax identity: PAN of the party; TAN when the customer deducts TDS from what it pays us.
    pan: { type: String, trim: true, uppercase: true, default: "" },
    // MSME (Udyam) status for the 45-day payment rule (Income-tax s.43B(h), MSMED Act s.15-16)
    msmeType: { type: String, enum: ["", "MICRO", "SMALL", "MEDIUM"], default: "" },
    udyamNumber: { type: String, trim: true, uppercase: true, default: "" },
    msmeTrader: { type: Boolean, default: false }, // traders (wholesale / retail) are outside s.43B(h)
    msmeCreditDays: { type: Number, min: 0, max: 45, default: 0 }, // agreed in writing; 0 = no agreement (15 days)
    // TDS we deduct when paying this supplier / landlord (see constants/tds.js); rate overrides the usual rate
    // (lower-deduction certificate). Blank kind = no TDS by default.
    tdsKind: { type: String, trim: true, uppercase: true, default: "" },
    tdsRate: { type: Number, min: 0, max: 100, default: null },
    productsSupplied: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    paymentStatus: {
      type: String,
      enum: ["paid", "partial", "unpaid"],
      default: "unpaid",
    },
  },
  {
    timestamps: true,
  }
);

// agreements (rent / leave-and-licence with validity dates), certificates, other documents
supplierSchema.add({ attachments: { type: [require("./documentAttachment.schema")], default: [] } });

supplierSchema.index({ businessId: 1, supplierName: 1 });
supplierSchema.index({ businessId: 1, email: 1 });

// every change is kept in the edit log (books audit trail)
supplierSchema.plugin(require("../utils/edit-log.plugin"), { model: "Supplier", businessKey: "businessId" });

module.exports = mongoose.model("Supplier", supplierSchema);
