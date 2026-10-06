require("../config/load-env")();

const mongoose = require("mongoose");
const Business = require("../models/Business");
const Customer = require("../models/Customer");
const IntegrationCredential = require("../models/IntegrationCredential");
const IntegrationCustomerMapping = require("../models/IntegrationCustomerMapping");

async function syncCrmClients() {
  const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27018/billstack?replicaSet=rs0";
  console.log("Connecting to MongoDB:", mongoUri);
  await mongoose.connect(mongoUri);

  const client = mongoose.connection.getClient();
  const adminDb = client.db().admin();
  const dbs = await adminDb.listDatabases();
  console.log("Available Databases:", dbs.databases.map(d => d.name));

  // Find CRM DB
  const crmDbCandidates = ["the-office-on-rent", "the_office_on_rent", "crm_billstack_e2e_20260928", "samvid_os", "crm"];
  let crmDbName = crmDbCandidates.find(name => dbs.databases.some(d => d.name === name));
  
  if (!crmDbName) {
    console.warn("Could not find standard CRM DB name. Looking for database with clients...");
    for (const d of dbs.databases) {
      if (d.name !== "admin" && d.name !== "config" && d.name !== "local" && d.name !== "billstack") {
        crmDbName = d.name;
        break;
      }
    }
  }

  console.log("Using CRM Database:", crmDbName);
  const crmDb = client.db(crmDbName);

  // Find TOOR business
  const toor = await Business.findOne({
    $or: [{ billingEntityCode: "TOOR" }, { slug: "the-office-on-rent" }, { slug: "toor" }]
  });

  if (!toor) {
    throw new Error("THE OFFICE ON RENT business entity not found in BillStack database.");
  }

  console.log("Target BillStack Business:", toor.name, "(" + toor._id + ")");

  // Look for clients across CRM collections
  const crmCols = await crmDb.listCollections().toArray();
  const colNames = crmCols.map(c => c.name);
  console.log("CRM Collections:", colNames);

  let rawClients = [];
  const candidateCollections = ["coworkingclients", "clients", "crmcontacts", "leads", "coworkingbookings"];

  for (const cName of candidateCollections) {
    if (colNames.includes(cName)) {
      const docs = await crmDb.collection(cName).find({}).toArray();
      if (docs.length > 0) {
        console.log(`Found ${docs.length} records in ${cName}`);
        // Check if records look like clients (have name / clientName)
        const hasClient = docs.some(d => (d.name && typeof d.name === "string") || (d.clientName && typeof d.clientName === "string") || (d.companyName && typeof d.companyName === "string"));
        if (hasClient && rawClients.length === 0) {
          rawClients = docs.map(d => ({
            externalId: String(d._id),
            name: d.name || d.clientName || d.companyName || d.contactPerson || "Unnamed Client",
            phone: d.phone || d.mobile || d.contactPhone || "",
            email: d.email || d.contactEmail || "",
            companyName: d.companyName || d.businessName || d.legalName || "",
            billingAddress: typeof d.address === "string" ? d.address : (d.address?.line1 || d.billingAddress || ""),
            gstNumber: (d.gstNumber || d.gstin || d.gstTaxId || "").toUpperCase().trim(),
            raw: d
          }));
          console.log(`Selected ${rawClients.length} clients from ${cName} for syncing!`);
          break;
        }
      }
    }
  }

  if (rawClients.length === 0) {
    // If not found in candidate collections, search all collections for 'Raj Thakur' or similar
    console.log("Searching all collections for client names...");
    for (const cName of colNames) {
      const match = await crmDb.collection(cName).findOne({
        $or: [
          { name: /Raj Thakur/i },
          { clientName: /Raj Thakur/i },
          { companyName: /Raj Thakur/i },
          { "client.name": /Raj Thakur/i }
        ]
      });
      if (match) {
        console.log(`Match found in collection: ${cName}`);
        const allDocs = await crmDb.collection(cName).find({}).toArray();
        rawClients = allDocs.map(d => ({
          externalId: String(d._id),
          name: d.name || d.clientName || d.companyName || d.client?.name || "Client",
          phone: d.phone || d.mobile || d.client?.phone || "",
          email: d.email || d.client?.email || "",
          companyName: d.companyName || d.client?.companyName || "",
          billingAddress: typeof d.address === "string" ? d.address : (d.address?.line1 || ""),
          gstNumber: (d.gstNumber || d.gstin || "").toUpperCase().trim(),
          raw: d
        }));
        break;
      }
    }
  }

  console.log(`\n--- SYNCING ${rawClients.length} CLIENTS TO BILLSTACK ---`);
  let syncedCount = 0;

  for (const c of rawClients) {
    if (!c.name || c.name === "Client") continue;

    // Check if customer exists in BillStack by name or phone or email
    const query = {
      businessId: toor._id,
      $or: [
        { name: c.name },
        ...(c.phone ? [{ phone: c.phone }] : []),
        ...(c.email ? [{ email: c.email }] : [])
      ]
    };

    let existing = await Customer.findOne(query);

    if (!existing) {
      existing = await Customer.create({
        businessId: toor._id,
        name: c.name.trim(),
        phone: c.phone ? String(c.phone).trim() : "",
        email: c.email ? String(c.email).trim().toLowerCase() : "",
        billingAddress: c.billingAddress ? String(c.billingAddress).trim() : "",
        gstNumber: c.gstNumber || "",
        companyName: c.companyName ? String(c.companyName).trim() : "",
        notes: "Synced from The Office On Rent CRM (ID: " + c.externalId + ")",
      });
      console.log(`✓ Created Customer in BillStack: ${c.name}`);
    } else {
      existing.name = c.name.trim();
      if (c.phone) existing.phone = String(c.phone).trim();
      if (c.email) existing.email = String(c.email).trim().toLowerCase();
      if (c.billingAddress) existing.billingAddress = String(c.billingAddress).trim();
      if (c.gstNumber) existing.gstNumber = c.gstNumber;
      await existing.save();
      console.log(`✓ Updated Customer in BillStack: ${c.name}`);
    }

    // Save external customer mapping for future handoffs/syncs
    await IntegrationCustomerMapping.findOneAndUpdate(
      { businessId: toor._id, source: "THE_OFFICE_ON_RENT_CRM", externalId: c.externalId },
      { customerId: existing._id },
      { upsert: true }
    );

    syncedCount++;
  }

  // Ensure active CRM API Key in IntegrationCredential
  const crmKey = process.env.INTEGRATION_CRM_API_KEY || "toor_crm_live_integration_key_2026";
  await IntegrationCredential.findOneAndUpdate(
    { businessId: toor._id, source: "THE_OFFICE_ON_RENT_CRM" },
    {
      businessId: toor._id,
      source: "THE_OFFICE_ON_RENT_CRM",
      name: "The Office On Rent CRM Connector",
      apiKey: crmKey,
      isActive: true,
      lastUsedAt: new Date(),
    },
    { upsert: true }
  );

  console.log("\n========================================================");
  console.log(`🎉 CRM SYNC COMPLETE: ${syncedCount} CLIENTS SYNCED TO BILLSTACK`);
  console.log("========================================================");
  console.log("Target Workspace: THE OFFICE ON RENT");
  console.log("Portal Customers Page: https://billstack.theofficeonrent.com/dashboard/customers");
  console.log("CRM Integration API Key: " + crmKey);
  console.log("========================================================\n");

  process.exit(0);
}

syncCrmClients().catch(err => {
  console.error("Sync Error:", err);
  process.exit(1);
});
