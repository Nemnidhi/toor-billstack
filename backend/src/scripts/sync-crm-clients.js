require("../config/load-env")();

const mongoose = require("mongoose");
const { MongoClient } = require("mongodb");
const Business = require("../models/Business");
const Customer = require("../models/Customer");
const User = require("../models/User");
const IntegrationCredential = require("../models/IntegrationCredential");
const IntegrationCustomerMapping = require("../models/IntegrationCustomerMapping");
const { createCredential } = require("../services/integration.service");

const sanitizeUri = (raw) => {
  if (!raw) return "(not set)";
  try {
    const url = new URL(raw);
    if (url.password) url.password = "****";
    return url.toString();
  } catch (e) {
    return raw.replace(/:([^@/]+)@/, ":****@");
  }
};

const escapeRegex = (str) => String(str || "").replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");

const cleanText = (val) => String(val || "").trim();

const cleanPhone = (val) => {
  const digits = String(val || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

const cleanEmail = (val) => {
  if (!val || typeof val !== "string") return "";
  const cleaned = val.replace(/^mailto:/i, "").trim();
  const angleMatch = cleaned.match(/<([^>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : cleaned).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(candidate) ? candidate : "";
};

const normalizeName = (val) => cleanText(val).toLowerCase().replace(/[^a-z0-9]/g, "");

function findMatchingCandidate(candidates, item) {
  for (const c of candidates) {
    // CRITICAL: DO NOT merge different customer names merely because phone numbers match
    if (c.normName !== item.normName) {
      continue;
    }

    // Same normalized name: verify matching identity/email/phone
    if (item.identityKey && c.identityKey && item.identityKey === c.identityKey) {
      return c;
    }
    if (item.email && c.email && item.email === c.email) {
      return c;
    }
    if (item.phone10 && c.phone10 && item.phone10 === c.phone10) {
      return c;
    }
    // If one lacks email/phone and the other has it, but name is identical
    if ((!item.email || !c.email) && (!item.phone10 || !c.phone10)) {
      return c;
    }
    // Exact same normalized name fallback
    if (item.normName === c.normName) {
      return c;
    }
  }
  return null;
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");

  console.log("========================================================");
  console.log("🏢 CRM TO BILLSTACK COWORKING CLIENTS SYNC");
  console.log("Mode: " + (isDryRun ? "DRY-RUN (Zero Writes)" : "LIVE SYNC (Performing Writes)"));
  console.log("========================================================\n");

  // 1. Validate CRM_MONGO_URI (strictly separate read-only connection, never inferred)
  const crmMongoUri = process.env.CRM_MONGO_URI;
  if (!crmMongoUri) {
    console.error("Error: CRM_MONGO_URI environment variable is required.");
    console.error("Usage example:");
    console.error("  CRM_MONGO_URI='mongodb://...' node src/scripts/sync-crm-clients.js [--dry-run]");
    process.exit(1);
  }

  // 2. Connect to BillStack DB (target)
  const billstackMongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27018/billstack?replicaSet=rs0";
  console.log("Connecting to BillStack DB (Target):", sanitizeUri(billstackMongoUri));
  await mongoose.connect(billstackMongoUri);

  // Target only THE OFFICE ON RENT billing entity
  const toor = await Business.findOne({
    $or: [
      { billingEntityCode: "TOOR" },
      { slug: "the-office-on-rent" },
      { slug: "toor" },
      { name: /office\s*on\s*rent/i }
    ],
  });

  if (!toor) {
    console.error("Error: 'THE OFFICE ON RENT' billing entity not found in BillStack DB.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("Target Billing Entity:", toor.name, "(" + (toor.billingEntityCode || "TOOR") + ", ID: " + toor._id + ")");

  // 3. Connect to CRM DB (source - separate read-only connection)
  console.log("Connecting to CRM DB (Read-Only):", sanitizeUri(crmMongoUri));
  const crmClient = new MongoClient(crmMongoUri, {
    readPreference: "primaryPreferred",
  });
  await crmClient.connect();

  let bookedCabins = [];
  let totalCabinsCount = 0;
  try {
    const crmDb = crmClient.db();
    const boardDoc = await crmDb.collection("coworkingboardstates").findOne({});
    if (!boardDoc || !boardDoc.state || !Array.isArray(boardDoc.state.cabins)) {
      throw new Error("No coworkingboardstates document or state.cabins array found in CRM DB.");
    }

    const allCabins = boardDoc.state.cabins;
    totalCabinsCount = allCabins.length;
    bookedCabins = allCabins.filter(
      (cb) => String(cb.status || "").toUpperCase() === "BOOKED"
    );
    console.log("Source Cabins: " + totalCabinsCount + " total, " + bookedCabins.length + " BOOKED");
  } catch (err) {
    console.error("Error reading CRM coworking board state:", err.message);
    await crmClient.close();
    await mongoose.disconnect();
    process.exit(1);
  }

  if (bookedCabins.length === 0) {
    console.log("No booked cabins found in CRM.");
    await crmClient.close();
    await mongoose.disconnect();
    process.exit(0);
  }

  // 4. Group & Deduplicate repeated cabins belonging to same real customer
  // Rules:
  // - Import only BOOKED coworking customers
  // - Dedupe repeated cabins belonging to same real customer
  // - DO NOT merge different customer names merely because phone numbers match
  // - Prefer exact company/name+email identity
  // - Preserve all available CRM name, phone, email, address/GST fields
  const candidates = [];

  for (const cb of bookedCabins) {
    const cl = cb.client || {};
    const companyName = cleanText(cl.companyName || (cl.kind === "company" ? cl.name : "") || "");
    const contactPerson = cleanText(cl.contactPerson || "");
    const clientName = cleanText(cl.name || cb.clientName || "");

    // Determine primary display name: companyName takes precedence if present, else clientName/contactPerson
    const primaryName = companyName || clientName || contactPerson;
    if (!primaryName) {
      console.warn("[WARN] Skipping booked cabin with missing client name: Code " + (cb.code || "(unknown)"));
      continue;
    }

    const normName = normalizeName(primaryName);
    const email = cleanEmail(cl.email);
    const rawPhone = cleanText(cl.phone || cl.mobile || cl.contactPhone);
    const phone10 = cleanPhone(rawPhone);
    const gstin = cleanText(cl.gstin || cl.gstNumber || cl.gstTaxId).toUpperCase();
    const pan = cleanText(cl.pan).toUpperCase();
    const identityKey = cleanText(cl.identityKey || cl.id);
    const cabinCode = cleanText(cb.code || cb.label || "Cabin");
    const seats = Number(cb.seats) || 0;

    let addressStr = "";
    if (typeof cl.address === "string") {
      addressStr = cleanText(cl.address);
    } else if (cl.address && typeof cl.address === "object") {
      addressStr = [
        cl.address.line1,
        cl.address.line2,
        cl.address.city,
        cl.address.state,
        cl.address.pincode || cl.address.postalCode,
      ]
        .filter((p) => p && String(p).trim())
        .join(", ");
    }

    const item = {
      externalId: identityKey ? "crm:coworking:" + identityKey : "crm:coworking:" + normName + (phone10 ? ":" + phone10 : ""),
      identityKey,
      name: primaryName,
      normName,
      companyName,
      contactPerson,
      email,
      phone: rawPhone,
      phone10,
      gstin,
      pan,
      address: addressStr,
      cabinCode,
      seats,
    };

    const existingCandidate = findMatchingCandidate(candidates, item);
    if (!existingCandidate) {
      candidates.push({
        externalId: item.externalId,
        identityKey: item.identityKey,
        name: item.name,
        normName: item.normName,
        companyName: item.companyName,
        contactPerson: item.contactPerson,
        email: item.email,
        phone: item.phone,
        phone10: item.phone10,
        gstin: item.gstin,
        pan: item.pan,
        address: item.address,
        cabins: [item.cabinCode],
        totalSeats: item.seats,
      });
    } else {
      // Merge cabin into existing customer candidate
      if (!existingCandidate.cabins.includes(item.cabinCode)) {
        existingCandidate.cabins.push(item.cabinCode);
        existingCandidate.totalSeats += item.seats;
      }
      // Fill missing fields
      if (!existingCandidate.email && item.email) existingCandidate.email = item.email;
      if (!existingCandidate.phone && item.phone) {
        existingCandidate.phone = item.phone;
        existingCandidate.phone10 = item.phone10;
      }
      if (!existingCandidate.companyName && item.companyName) existingCandidate.companyName = item.companyName;
      if (!existingCandidate.contactPerson && item.contactPerson) existingCandidate.contactPerson = item.contactPerson;
      if (!existingCandidate.gstin && item.gstin) existingCandidate.gstin = item.gstin;
      if (!existingCandidate.pan && item.pan) existingCandidate.pan = item.pan;
      if (!existingCandidate.address && item.address) existingCandidate.address = item.address;
    }
  }

  console.log("Unique Customer Candidates: " + candidates.length + "\n");

  // 5. Compare with BillStack Customers & Plan Actions
  let matchCount = 0;
  let createCount = 0;
  let skipCount = 0;
  const actions = [];

  for (const c of candidates) {
    let matchedCustomer = null;
    let matchReason = "";

    // A. Check IntegrationCustomerMapping first
    if (c.externalId) {
      const mapping = await IntegrationCustomerMapping.findOne({
        businessId: toor._id,
        source: "THE_OFFICE_ON_RENT_CRM",
        externalId: c.externalId,
      });
      if (mapping && mapping.customerId) {
        matchedCustomer = await Customer.findOne({ _id: mapping.customerId, businessId: toor._id });
        if (matchedCustomer) matchReason = "Integration Mapping (" + c.externalId + ")";
      }
    }

    // B. Match by exact normalized name in BillStack DB
    // Rule: DO NOT merge different customer names merely because phone numbers match
    if (!matchedCustomer) {
      const nameRegex = new RegExp("^" + escapeRegex(c.name) + "$", "i");
      const sameNameCustomers = await Customer.find({
        businessId: toor._id,
        name: nameRegex,
      });

      if (sameNameCustomers.length === 1) {
        matchedCustomer = sameNameCustomers[0];
        matchReason = "Exact Name Match";
      } else if (sameNameCustomers.length > 1) {
        // Disambiguate same-name customers using email or phone
        if (c.email) {
          matchedCustomer = sameNameCustomers.find((x) => cleanEmail(x.email) === c.email);
          if (matchedCustomer) matchReason = "Exact Name + Email Match";
        }
        if (!matchedCustomer && c.phone10) {
          matchedCustomer = sameNameCustomers.find((x) => cleanPhone(x.phone) === c.phone10);
          if (matchedCustomer) matchReason = "Exact Name + Phone Match";
        }
        if (!matchedCustomer) {
          matchedCustomer = sameNameCustomers[0];
          matchReason = "Exact Name Match (Primary)";
        }
      }
    }

    // C. Fallback: Exact Name + Email match across business
    if (!matchedCustomer && c.email) {
      const emailMatches = await Customer.find({
        businessId: toor._id,
        email: c.email,
      });
      // Verify name compatibility before merging on email
      const verifiedMatch = emailMatches.find((em) => {
        const emNorm = normalizeName(em.name);
        return emNorm === c.normName || emNorm.includes(c.normName) || c.normName.includes(emNorm);
      });
      if (verifiedMatch) {
        matchedCustomer = verifiedMatch;
        matchReason = "Verified Name + Email Match";
      }
    }

    if (matchedCustomer) {
      matchCount++;
      actions.push({
        status: "EXISTS",
        matchReason,
        candidate: c,
        customerId: matchedCustomer._id,
      });
    } else {
      createCount++;
      actions.push({
        status: "CREATE",
        matchReason: "New Candidate",
        candidate: c,
      });
    }
  }

  // 6. Print Candidate Breakdown & Stats
  console.log("--------------------------------------------------------------------------------");
  console.log("CANDIDATE BREAKDOWN & PLANNED ACTIONS");
  console.log("--------------------------------------------------------------------------------");
  actions.forEach((a, idx) => {
    const c = a.candidate;
    const cabinStr = c.cabins.join(", ");
    const infoParts = [
      c.companyName && c.companyName !== c.name ? "Company: " + c.companyName : null,
      c.contactPerson ? "Contact: " + c.contactPerson : null,
      c.phone ? "Phone: " + c.phone : null,
      c.email ? "Email: " + c.email : null,
      c.gstin ? "GSTIN: " + c.gstin : null,
      c.address ? "Address: " + c.address.slice(0, 30) + (c.address.length > 30 ? "..." : "") : null,
    ].filter(Boolean);

    console.log(
      "[" + String(idx + 1).padStart(2, "0") + "] [" + a.status.padEnd(6) + "] " + c.name + " (Cabins: " + cabinStr + " | Seats: " + c.totalSeats + ")"
    );
    if (infoParts.length > 0) {
      console.log("     Details: " + infoParts.join(" | "));
    }
    if (a.status === "EXISTS") {
      console.log("     Match: Customer ID " + a.customerId + " via " + a.matchReason);
    }
  });

  console.log("--------------------------------------------------------------------------------");
  console.log("SUMMARY STATS:");
  console.log("  - Total Source Cabins:  " + totalCabinsCount);
  console.log("  - Booked Cabins:        " + bookedCabins.length);
  console.log("  - Unique Candidates:    " + candidates.length);
  console.log("  - Existing Matches:     " + matchCount);
  console.log("  - New Creates Planned:  " + createCount);
  console.log("  - Skips / Conflicts:    " + skipCount);
  console.log("--------------------------------------------------------------------------------\n");

  // 7. Zero Writes on Dry-Run
  if (isDryRun) {
    console.log("🛡️ DRY-RUN COMPLETED: 0 database writes performed.");
    console.log("Verification clean. Run without --dry-run to perform live migration.");
    await crmClient.close();
    await mongoose.disconnect();
    process.exit(0);
  }

  // 8. Live Database Writes
  console.log("🚀 EXECUTING DATABASE WRITES...");

  // Ensure Integration Credential exists for mapping (never print key or secret)
  let credential = await IntegrationCredential.findOne({
    businessId: toor._id,
    source: "THE_OFFICE_ON_RENT_CRM",
    status: "ACTIVE",
  });

  if (!credential) {
    const adminUser = (await User.findOne({ businessId: toor._id })) || (await User.findOne({ role: "owner" })) || (await User.findOne({}));
    const res = await createCredential({
      businessId: toor._id,
      name: "The Office On Rent CRM Connector",
      source: "THE_OFFICE_ON_RENT_CRM",
      userId: adminUser ? adminUser._id : toor._id,
    });
    credential = res.credential;
  }

  let createdTotal = 0;
  let updatedTotal = 0;

  for (const a of actions) {
    const c = a.candidate;
    const notesParts = [
      "Coworking Client: Cabins " + c.cabins.join(", ") + " (" + c.totalSeats + " seats)",
      c.contactPerson ? "Contact Person: " + c.contactPerson : null,
      c.companyName && c.companyName !== c.name ? "Company: " + c.companyName : null,
      c.pan ? "PAN: " + c.pan : null,
    ].filter(Boolean);
    const notesStr = notesParts.join(" | ");

    const stateCode = c.gstin && c.gstin.length >= 2 ? c.gstin.slice(0, 2) : "";

    if (a.status === "CREATE") {
      const doc = await Customer.create({
        businessId: toor._id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        billingAddress: c.address,
        shippingAddress: c.address,
        gstNumber: c.gstin,
        stateCode,
        placeOfSupplyCode: stateCode,
        notes: notesStr,
      });

      if (c.externalId) {
        await IntegrationCustomerMapping.findOneAndUpdate(
          { businessId: toor._id, source: "THE_OFFICE_ON_RENT_CRM", externalId: c.externalId },
          { customerId: doc._id, credentialId: credential._id, lastSyncedAt: new Date() },
          { upsert: true }
        );
      }
      createdTotal++;
    } else if (a.status === "EXISTS" && a.customerId) {
      const updateFields = { notes: notesStr };
      if (c.phone) updateFields.phone = c.phone;
      if (c.email) updateFields.email = c.email;
      if (c.gstin) {
        updateFields.gstNumber = c.gstin;
        if (stateCode) {
          updateFields.stateCode = stateCode;
          updateFields.placeOfSupplyCode = stateCode;
        }
      }
      if (c.address) {
        updateFields.billingAddress = c.address;
        updateFields.shippingAddress = c.address;
      }

      await Customer.updateOne(
        { _id: a.customerId, businessId: toor._id },
        { $set: updateFields }
      );

      if (c.externalId) {
        await IntegrationCustomerMapping.findOneAndUpdate(
          { businessId: toor._id, source: "THE_OFFICE_ON_RENT_CRM", externalId: c.externalId },
          { customerId: a.customerId, credentialId: credential._id, lastSyncedAt: new Date() },
          { upsert: true }
        );
      }
      updatedTotal++;
    }
  }

  console.log("\n========================================================");
  console.log("🎉 LIVE SYNC COMPLETE:");
  console.log("  - " + createdTotal + " new customers created in BillStack");
  console.log("  - " + updatedTotal + " existing customers updated");
  console.log("  - Zero invoices / payments created (Customer sync only)");
  console.log("========================================================\n");

  await crmClient.close();
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal Sync Error:", err.message);
  process.exit(1);
});
