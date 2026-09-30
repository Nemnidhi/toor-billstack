require("../config/load-env")();

const connectDB = require("../config/db");
const Business = require("../models/Business");
const BusinessSubscription = require("../models/BusinessSubscription");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Supplier = require("../models/Supplier");
const User = require("../models/User");
const { hashPassword } = require("../services/auth.service");
const { getDeploymentMode, DEPLOYMENT_MODES } = require("../constants/modules");
const { ensureSelfHostedBusinessProfile } = require("../services/self-hosted-profile.service");

const seed = async () => {
  await connectDB();

  const deploymentMode = getDeploymentMode();
  const selfHosted = deploymentMode === DEPLOYMENT_MODES.SELF_HOSTED;
  const slug = "billstack-demo";
  await Promise.all([
    Business.deleteMany({ slug }),
    User.deleteMany({ email: { $in: ["owner@billstack.demo", "admin@billstack.demo"] } }),
  ]);

  const business = await Business.create({
    name: selfHosted ? "THE OFFICE ON RENT" : "BillStack Demo Pvt Ltd",
    slug,
    deploymentMode,
    industry: selfHosted ? "Real Estate" : "Retail",
    email: "hello@billstack.demo",
    billingEmail: "billing@billstack.demo",
    phone: "+91 9876543210",
    address: "Demo Street, Bengaluru",
    gstTaxId: "29ABCDE1234F2Z5",
    onboardingCompleted: true,
    planCode: "pro",
    invoiceTerms: "Payment due within 7 days.",
    defaultTaxSettings: {
      taxName: "GST",
      taxRate: 18,
      taxMode: "exclusive",
    },
    inventorySettings: {
      allowNegativeStock: false,
    },
  });

  const password = await hashPassword("password123");

  const owner = await User.create({
    businessId: business._id,
    name: "Demo Owner",
    email: "owner@billstack.demo",
    password,
    role: "owner",
  });

  await User.create({
    businessId: business._id,
    name: "Demo Admin",
    email: "admin@billstack.demo",
    password,
    role: "admin",
  });

  business.ownerUserId = owner._id;
  await business.save();

  // Self-hosted demos use the same persisted profile/module defaults as login.
  // Do not populate a retail/SaaS subscription workspace in the client edition.
  if (selfHosted) {
    await ensureSelfHostedBusinessProfile(business);
    console.log("Self-hosted Real Estate demo workspace initialized");
    return;
  }

  await BusinessSubscription.create({
    businessId: business._id,
    planCode: "pro",
    status: "active",
    currentStart: new Date(),
    currentEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  const [customer, supplier] = await Promise.all([
    Customer.create({
      businessId: business._id,
      name: "Acme Stores",
      phone: "+91 9988776655",
      email: "accounts@acme.demo",
      billingAddress: "MG Road, Bengaluru",
      shippingAddress: "Whitefield, Bengaluru",
      gstNumber: "29AAAAA1111A1Z1",
      notes: "Priority retail customer",
    }),
    Supplier.create({
      businessId: business._id,
      supplierName: "SupplyHub Traders",
      phone: "+91 9123456780",
      email: "sales@supplyhub.demo",
      address: "Peenya Industrial Area, Bengaluru",
      gstNumber: "29BBBBB2222B1Z2",
      paymentStatus: "paid",
      notes: "Primary supplier",
    }),
  ]);

  await Product.insertMany([
    {
      businessId: business._id,
      name: "Thermal Printer",
      sku: "TP-001",
      category: "Hardware",
      unitType: "piece",
      purchasePrice: 4500,
      sellingPrice: 5999,
      taxRate: 18,
      openingStock: 12,
      currentStock: 12,
      minimumStockLevel: 4,
      trackInventory: true,
      status: "active",
    },
    {
      businessId: business._id,
      name: "Billing Setup Service",
      sku: "SERV-101",
      category: "Services",
      unitType: "service",
      purchasePrice: 0,
      sellingPrice: 2500,
      taxRate: 18,
      openingStock: 0,
      currentStock: 0,
      minimumStockLevel: 0,
      trackInventory: false,
      status: "active",
    },
  ]);

  console.log("Seed complete");
  console.log(`Business: ${business.name}`);
  console.log(`Owner login: owner@billstack.demo / password123`);
  console.log(`Admin login: admin@billstack.demo / password123`);
  console.log(`Sample customer: ${customer.name}`);
  console.log(`Sample supplier: ${supplier.supplierName}`);
};

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
