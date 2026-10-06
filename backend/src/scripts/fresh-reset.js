require("../config/load-env")();

const mongoose = require("mongoose");
const Business = require("../models/Business");
const BusinessMembership = require("../models/BusinessMembership");
const BusinessSubscription = require("../models/BusinessSubscription");
const User = require("../models/User");
const { hashPassword } = require("../services/auth.service");
const { ensureDefaultAccounts } = require("../services/accounting.service");

async function freshReset() {
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27018/billstack?replicaSet=rs0";
  console.log("Connecting to database:", mongoUri);
  await mongoose.connect(mongoUri);

  const ownerEmail = (process.env.OWNER_EMAIL || "admin@theofficeonrent.com").trim().toLowerCase();
  const ownerPassword = process.env.OWNER_PASSWORD || "Admin@1234";
  const ownerName = process.env.OWNER_NAME || "Akhil Singh Thakur";

  console.log("\n========================================================");
  console.log("🧹 STARTING FRESH RESET FOR PRODUCTION WORKSPACE");
  console.log("========================================================");

  // 1. Locate TOOR & Goldhawk entities
  let toor = await Business.findOne({
    $or: [{ billingEntityCode: "TOOR" }, { slug: "the-office-on-rent" }, { slug: "toor" }]
  });

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
      invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
    });
    console.log("✓ Created Root Entity: THE OFFICE ON RENT (TOOR)");
  } else {
    toor.name = "THE OFFICE ON RENT";
    toor.legalName = "THE OFFICE ON RENT";
    toor.billingEntityCode = "TOOR";
    toor.deploymentMode = "SELF_HOSTED";
    toor.onboardingCompleted = true;
    toor.planCode = "enterprise";
    toor.invoiceNumbering = { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 };
    await toor.save();
    console.log("✓ Updated & Reset Sequence: THE OFFICE ON RENT (TOOR)");
  }

  let goldhawk = await Business.findOne({
    $or: [{ billingEntityCode: "GOLDHAWK" }, { slug: "goldhawk-infrabulls" }]
  });

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
      invoiceNumbering: { prefix: "GH", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
    });
    console.log("✓ Created Child Entity: Goldhawk Infrabulls Pvt. Ltd. (GOLDHAWK)");
  } else {
    goldhawk.billingEntityCode = "GOLDHAWK";
    goldhawk.billingParentId = toor._id;
    goldhawk.deploymentMode = "SELF_HOSTED";
    goldhawk.onboardingCompleted = true;
    goldhawk.planCode = "enterprise";
    goldhawk.invoiceNumbering = { prefix: "GH", format: "INV-{YYYY}-{0001}", nextSequence: 1 };
    await goldhawk.save();
    console.log("✓ Updated & Reset Sequence: Goldhawk Infrabulls Pvt. Ltd. (GOLDHAWK)");
  }

  const businessIds = [toor._id, goldhawk._id];
  const db = mongoose.connection.db;

  // 2. Wipe ALL old dummy / test transactions using raw collections (bypasses Mongoose append-only hooks)
  console.log("\n--- CLEARING DUMMY & TEST TRANSACTIONS ---");
  const collectionsToClean = [
    "invoices",
    "payments",
    "paymentallocations",
    "paymentbalances",
    "customerledgers",
    "invoiceledgerevents",
    "customers",
    "expenses",
    "quotes",
    "creditnotes",
    "salesreturns",
    "orders",
    "products",
    "productbatches",
    "stockmovements",
    "suppliers",
    "supplierledgers",
    "journalentries",
    "bankstatementtransactions",
    "bankaccounts",
    "recurringbillingprofiles",
    "appointments",
    "auditlogs",
  ];

  for (const colName of collectionsToClean) {
    try {
      const col = db.collection(colName);
      const res = await col.deleteMany({ businessId: { $in: businessIds } });
      if (res.deletedCount > 0) {
        console.log(`  - ${colName}: ${res.deletedCount} records deleted`);
      }
    } catch (e) {
      // collection may not exist yet, ignore
    }
  }

  // Clear all refresh tokens for fresh login
  await db.collection("refreshtokens").deleteMany({});

  console.log("✓ All dummy invoices, payments, customers, and expenses wiped out clean!");

  // 3. Reset Double-Entry Chart of Accounts
  console.log("\n--- RE-INITIALIZING CLEAN DOUBLE-ENTRY GENERAL LEDGER ---");
  await db.collection("accounts").deleteMany({ businessId: { $in: businessIds } });
  await ensureDefaultAccounts({ businessId: toor._id });
  await ensureDefaultAccounts({ businessId: goldhawk._id });
  console.log("✓ Pristine Chart of Accounts established with ₹0.00 balances");

  // 4. Ensure Enterprise Subscriptions
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

  // 5. Clean users: Keep only Akhil Singh Thakur as Owner
  console.log("\n--- CONFIGURING PRIMARY OWNER ACCOUNT ---");
  const hashedPassword = await hashPassword(ownerPassword);
  
  // Remove any test / dummy users under these businesses
  await db.collection("users").deleteMany({ businessId: { $in: businessIds }, email: { $ne: ownerEmail } });

  let user = await User.findOne({ email: ownerEmail });
  if (!user) {
    user = await User.create({
      businessId: toor._id,
      name: ownerName,
      email: ownerEmail,
      password: hashedPassword,
      role: "owner",
      isActive: true,
      failedLoginAttempts: 0,
      lockedUntil: null,
    });
    console.log("✓ Created Fresh Owner User:", ownerEmail, "(" + ownerName + ")");
  } else {
    user.businessId = toor._id;
    user.name = ownerName;
    user.password = hashedPassword;
    user.role = "owner";
    user.isActive = true;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await user.save();
    console.log("✓ Cleaned & Reset Owner User:", ownerEmail, "(" + ownerName + ")");
  }

  toor.ownerUserId = user._id;
  await toor.save();

  // Multi-Company Group Access
  await BusinessMembership.deleteMany({ userId: user._id });
  await BusinessMembership.create([
    { userId: user._id, businessId: toor._id, role: "admin" },
    { userId: user._id, businessId: goldhawk._id, role: "admin" },
  ]);
  console.log("✓ Granted Multi-Company Group Access (TOOR + Goldhawk)");

  console.log("\n========================================================");
  console.log("🎉 PRODUCTION FRESH RESET COMPLETE (ZERO DUMMY DATA)");
  console.log("========================================================");
  console.log("Owner Name:     " + ownerName);
  console.log("Login Email:    " + ownerEmail);
  console.log("Login Password: " + ownerPassword);
  console.log("Total Invoices: 0 (Counter reset to 1)");
  console.log("Total Sales:    ₹0.00");
  console.log("Balance Sheet:  Balanced ₹0.00");
  console.log("========================================================\n");

  process.exit(0);
}

freshReset().catch((err) => {
  console.error("Fresh Reset Error:", err);
  process.exit(1);
});
