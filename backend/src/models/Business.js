const mongoose = require("mongoose");

const bankDetailsSchema = new mongoose.Schema(
  {
    accountName: {
      type: String,
      trim: true,
      default: "",
    },
    bankName: {
      type: String,
      trim: true,
      default: "",
    },
    accountNumber: {
      type: String,
      trim: true,
      default: "",
    },
    ifscCode: {
      type: String,
      trim: true,
      default: "",
    },
    upiId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { _id: false }
);

const defaultTaxSettingsSchema = new mongoose.Schema(
  {
    taxName: {
      type: String,
      trim: true,
      default: "GST",
    },
    taxRate: {
      type: Number,
      default: 18,
    },
    taxMode: {
      type: String,
      enum: ["exclusive", "inclusive"],
      default: "exclusive",
    },
  },
  { _id: false }
);

const invoiceNumberingSchema = new mongoose.Schema(
  {
    prefix: {
      type: String,
      trim: true,
      default: "INV",
    },
    format: {
      type: String,
      trim: true,
      default: "INV-{YYYY}-{0001}",
    },
    nextSequence: {
      type: Number,
      default: 1,
    },
  },
  { _id: false }
);

const invoiceUsageSchema = new mongoose.Schema(
  {
    monthKey: {
      type: String,
      default: "",
    },
    count: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

const inventorySettingsSchema = new mongoose.Schema(
  {
    allowNegativeStock: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const businessProfileSchema = new mongoose.Schema(
  {
    industryCode: { type: String, trim: true, default: "" },
    playerType: { type: String, trim: true, default: "" },
    playerTypeCode: { type: String, trim: true, default: "" },
    operationalFamily: { type: String, trim: true, default: "" },
    businessModel: {
      type: String,
      enum: ["PRODUCT", "SERVICE", "TRADING", "MANUFACTURING", "PROJECT_BASED", "RECURRING", "MIXED", ""],
      default: "",
    },
    businessSize: { type: String, trim: true, default: "" },
    numberOfUsers: { type: Number, default: 1 },
    numberOfLocations: { type: Number, default: 1 },
    gstRegistered: { type: Boolean, default: false },
    selectedNeeds: { type: [String], default: [] },
    recommendedModules: { type: [String], default: [] },
    optionalModules: { type: [String], default: [] },
    futureCapabilities: { type: [String], default: [] },
    futureWorkflowPacks: { type: [String], default: [] },
    recommendedPlanCode: { type: String, trim: true, default: "" },
    preset: { type: String, trim: true, default: "" },
    onboardingStatus: {
      type: String,
      enum: ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"],
      default: "NOT_STARTED",
    },
  },
  { _id: false }
);

const businessSchema = new mongoose.Schema(
  {
    billingParentId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", default: null, immutable: true },
    billingEntityCode: { type: String, enum: ["", "TOOR", "GOLDHAWK"], default: "", immutable: true },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    industry: {
      type: String,
      trim: true,
      default: "",
    },
    billingEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: String,
      trim: true,
      default: "",
    },
    logoUrl: {
      type: String,
      default: "",
    },
    signatureUrl: {
      type: String,
      default: "",
    },
    gstTaxId: {
      type: String,
      trim: true,
      default: "",
    },
    gstConfiguration: { gstin: { type: String, default: "" }, stateCode: { type: String, default: "" }, state: { type: String, default: "" }, enabled: { type: Boolean, default: false } },
    bankDetails: {
      type: bankDetailsSchema,
      default: () => ({}),
    },
    invoiceTerms: {
      type: String,
      trim: true,
      default: "",
    },
    defaultTaxSettings: {
      type: defaultTaxSettingsSchema,
      default: () => ({}),
    },
    invoiceNumbering: {
      type: invoiceNumberingSchema,
      default: () => ({}),
    },
    quoteNumbering: {
      type: invoiceNumberingSchema,
      default: () => ({ prefix: "QUO", format: "QUO-{YYYY}-{0001}", nextSequence: 1 }),
    },
    expenseNumbering: {
      type: invoiceNumberingSchema,
      default: () => ({ prefix: "EXP", format: "EXP-{YYYY}-{0001}", nextSequence: 1 }),
    },
    orderNumbering: {
      type: invoiceNumberingSchema,
      default: () => ({ prefix: "ORD", format: "ORD-{YYYY}-{0001}", nextSequence: 1 }),
    },
    projectNumbering: {
      type: invoiceNumberingSchema,
      default: () => ({ prefix: "PRJ", format: "PRJ-{YYYY}-{0001}", nextSequence: 1 }),
    },
    productionJobNumbering: {
      type: invoiceNumberingSchema,
      default: () => ({ prefix: "JOB", format: "JOB-{YYYY}-{0001}", nextSequence: 1 }),
    },
    dispatchNumbering: {
      type: invoiceNumberingSchema,
      default: () => ({ prefix: "DSP", format: "DSP-{YYYY}-{0001}", nextSequence: 1 }),
    },
    planCode: {
      type: String,
      enum: ["free", "starter", "growth", "basic", "pro", "enterprise"],
      default: "free",
    },
    subscriptionExpiresAt: {
      type: Date,
      default: null,
    },
    isDisabled: {
      type: Boolean,
      default: false,
    },
    invoiceUsage: {
      type: invoiceUsageSchema,
      default: () => ({}),
    },
    inventorySettings: {
      type: inventorySettingsSchema,
      default: () => ({}),
    },
    deploymentMode: {
      type: String,
      enum: ["SAAS", "SELF_HOSTED"],
      default: "SAAS",
    },
    businessProfile: {
      type: businessProfileSchema,
      default: () => ({}),
    },
    onboardingCompleted: {
      type: Boolean,
      default: false,
    },
    ownerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

businessSchema.index({ billingParentId: 1, billingEntityCode: 1 }, { unique: true, partialFilterExpression: { billingParentId: { $type: "objectId" } } });
businessSchema.pre("save", async function () {
  if (this.billingEntityCode === "GOLDHAWK") {
    this.gstConfiguration = { enabled: false, gstin: "", stateCode: "", state: "" };
    this.gstTaxId = "";
    this.businessProfile.gstRegistered = false;
    this.defaultTaxSettings = { taxName: "", taxRate: 0, taxMode: "exclusive" };
  }
  const sellerFields = ["name", "address", "email", "billingEmail", "phone", "logoUrl", "signatureUrl", "gstTaxId", "gstConfiguration", "bankDetails", "invoiceTerms"];
  if (!this.isNew && sellerFields.some(f => this.isModified(f))) {
    const previous = await this.constructor.findById(this._id).session(this.$session());
    if (previous) await require("../services/seller-snapshot.service").freezeLegacySellers(previous, this.$session());
  }
});
module.exports = mongoose.model("Business", businessSchema);
