const mongoose = require("mongoose");

const roles = ["owner", "admin", "staff", "accountant", "auditor"];

const userSchema = new mongoose.Schema(
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
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      default: "",
    },
    authProvider: {
      type: String,
      enum: ["password", "google", "password_google"],
      default: "password",
    },
    googleSubject: {
      type: String,
      trim: true,
      default: "",
    },
    googleEmailVerified: {
      type: Boolean,
      default: false,
    },
    googleLinkedAt: {
      type: Date,
      default: null,
    },
    role: {
      type: String,
      enum: roles,
      default: "staff",
    },
    permissions: {
      canManageHR: {
        type: Boolean,
        default: false,
      },
      canViewHR: {
        type: Boolean,
        default: false,
      },
      // For the auditor role: areas this person may also change (constants/auditor-grants.js).
      grants: {
        type: [String],
        default: [],
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    passwordResetToken: {
      type: String,
      default: "",
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    // Two-step sign-in with an authenticator app. The secret is sealed with BILLSTACK_DATA_KEY and
    // never leaves the server after setup; recovery codes are kept only as hashes.
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretSealed: { type: String, default: "", select: false },
      pendingSecretSealed: { type: String, default: "", select: false },
      recoveryCodeHashes: { type: [String], default: [], select: false },
      lastStep: { type: Number, default: -1, select: false },
      failedAttempts: { type: Number, default: 0 },
      lockedUntil: { type: Date, default: null },
      enabledAt: { type: Date, default: null },
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

userSchema.index({ businessId: 1, email: 1 }, { unique: true });
userSchema.index({ googleSubject: 1 }, { unique: true, partialFilterExpression: { googleSubject: { $type: "string", $gt: "" } } });

module.exports = mongoose.model("User", userSchema);
