require("../config/load-env")();

const mongoose = require("mongoose");
const Business = require("../models/Business");
const BusinessMembership = require("../models/BusinessMembership");
const BusinessSubscription = require("../models/BusinessSubscription");
const User = require("../models/User");
const { hashPassword } = require("../services/auth.service");
const { ensureDefaultAccounts } = require("../services/accounting.service");
const { redactMongoUri, requireOwnerPassword } = require("./lib/script-guard");

async function initWorkspace() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) throw new Error("MONGO_URI is not set.");
  console.log("Connecting to database:", redactMongoUri(mongoUri));
  await mongoose.connect(mongoUri);

  const ownerEmail = (process.env.OWNER_EMAIL || "admin@theofficeonrent.com").trim().toLowerCase();
  // Re-running setup must never reset an existing owner's password. A password is
  // needed only when the owner account is created for the first time, and then it
  // must be supplied (no built-in default) - or set RESET_OWNER_PASSWORD=true to
  // replace it on purpose.
  const existingOwner = await User.findOne({ email: ownerEmail }).select("_id").lean();
  const resetOwnerPassword = process.env.RESET_OWNER_PASSWORD === "true";
  const ownerPassword = !existingOwner || resetOwnerPassword ? requireOwnerPassword() : null;
  const ownerName = process.env.OWNER_NAME || "Akhil Singh Thakur";

  console.log("\n--- INITIALIZING BILLSTACK ENTERPRISE WORKSPACE ---");

  // 1. Primary Entity: THE OFFICE ON RENT (TOOR)
  let toor = await Business.findOne({ $or: [{ billingEntityCode: "TOOR" }, { slug: "the-office-on-rent" }, { slug: "toor" }] });
  if (!toor) {
    toor = await Business.create({
      name: "THE OFFICE ON RENT",
      legalName: "THE OFFICE ON RENT",
      slug: "the-office-on-rent",
      billingEntityCode: "TOOR",
      industry: "Real Estate & Coworking",
      email: ownerEmail,
      billingEmail: ownerEmail,
      phone: "+91 9876543210",
      deploymentMode: "SELF_HOSTED",
      onboardingCompleted: true,
      planCode: "enterprise",
      gstTaxId: "23AAGCB1234F1Z0",
      isGstRegistered: true,
      defaultTaxSettings: {
        taxName: "GST",
        taxRate: 18,
        taxMode: "exclusive",
      },
    });
    console.log("✓ Created Root Entity: THE OFFICE ON RENT (TOOR)");
  } else {
    toor.name = "THE OFFICE ON RENT";
    toor.legalName = "THE OFFICE ON RENT";
    toor.deploymentMode = "SELF_HOSTED";
    toor.onboardingCompleted = true;
    await toor.save();
    console.log("✓ Updated Existing Entity: THE OFFICE ON RENT (TOOR)");
  }

  // 2. Child Entity: Goldhawk Infrabulls Pvt. Ltd. (GOLDHAWK)
  let goldhawk = await Business.findOne({ $or: [{ billingEntityCode: "GOLDHAWK" }, { slug: "goldhawk-infrabulls" }] });
  if (!goldhawk) {
    goldhawk = await Business.create({
      name: "Goldhawk Infrabulls Pvt. Ltd.",
      legalName: "Goldhawk Infrabulls Pvt. Ltd.",
      slug: "goldhawk-infrabulls",
      billingEntityCode: "GOLDHAWK",
      billingParentId: toor._id,
      industry: "Real Estate Brokerage",
      email: ownerEmail,
      billingEmail: ownerEmail,
      phone: "+91 9876543210",
      deploymentMode: "SELF_HOSTED",
      onboardingCompleted: true,
      planCode: "enterprise",
      isGstRegistered: false,
      defaultTaxSettings: {
        taxName: "NON_GST",
        taxRate: 0,
        taxMode: "exclusive",
      },
    });
    console.log("✓ Created Child Entity: Goldhawk Infrabulls Pvt. Ltd. (GOLDHAWK)");
  } else {
    goldhawk.billingParentId = toor._id;
    goldhawk.deploymentMode = "SELF_HOSTED";
    goldhawk.onboardingCompleted = true;
    await goldhawk.save();
    console.log("✓ Updated Child Entity: Goldhawk Infrabulls Pvt. Ltd. (GOLDHAWK)");
  }

  // 3. Ensure Default Double-Entry Chart of Accounts for both entities
  try {
    await ensureDefaultAccounts({ businessId: toor._id });
    await ensureDefaultAccounts({ businessId: goldhawk._id });
    console.log("✓ Verified Double-Entry Chart of Accounts (COA) for TOOR & Goldhawk");
  } catch (err) {
    console.warn("Notice during COA init:", err.message);
  }

  // 4. Ensure Subscriptions
  for (const biz of [toor, goldhawk]) {
    await BusinessSubscription.findOneAndUpdate(
      { businessId: biz._id },
      {
        planCode: "enterprise",
        status: "active",
        currentStart: new Date(),
        currentEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
      { upsert: true }
    );
  }

  // 5. Create or Update Owner User
  const hashedPassword = ownerPassword ? await hashPassword(ownerPassword) : null;
  let user = await User.findOne({ email: ownerEmail });
  if (!user) {
    user = await User.create({
      businessId: toor._id,
      name: ownerName,
      email: ownerEmail,
      password: hashedPassword,
      role: "owner",
      isActive: true,
    });
    console.log("✓ Created Owner User:", ownerEmail);
  } else {
    user.businessId = toor._id;
    user.name = ownerName;
    user.role = "owner";
    user.isActive = true;
    if (hashedPassword) {
      user.password = hashedPassword;
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
    }
    await user.save();
    console.log(hashedPassword ? "✓ Updated Owner User and replaced the password:" : "✓ Updated Owner User (password unchanged):", ownerEmail);
  }

  // 6. Ensure Multi-Company Membership
  await BusinessMembership.findOneAndUpdate(
    { userId: user._id, businessId: goldhawk._id },
    { role: "owner", isActive: true },
    { upsert: true }
  );
  await BusinessMembership.findOneAndUpdate(
    { userId: user._id, businessId: toor._id },
    { role: "owner", isActive: true },
    { upsert: true }
  );
  console.log("✓ Granted Multi-Company Group Access (TOOR + Goldhawk)");

  console.log("\n========================================================");
  console.log("🎉 WORKSPACE DEPLOYMENT SETUP COMPLETE");
  console.log("========================================================");
  console.log("Portal URL:          http://localhost:5174/login (or your production domain)");
  console.log("Admin / Owner Email:", ownerEmail);
  console.log("Admin Password:      " + (ownerPassword ? "(the OWNER_PASSWORD you supplied - not shown)" : "(unchanged)"));
  console.log("Role:                Owner (Full Access to TOOR & Goldhawk)");
  console.log("Branding:            Powered by NEMNIDHI");
  console.log("========================================================\n");

  await mongoose.disconnect();
}

initWorkspace().catch((err) => {
  console.error("Init Workspace Error:", err);
  process.exit(1);
});
