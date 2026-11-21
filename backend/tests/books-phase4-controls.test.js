// Books phase 4 (21 Nov 2026): controls. Period lock, the edit log (Companies (Accounts) Rules
// rule 3(1): every change kept, cannot be switched off), the financial-year invoice series,
// Goldhawk's GST registration watch and switch, and documents attached to bills / agreements.
// Needs a replica-set MongoDB:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_books_phase4_test?replicaSet=rs0&directConnection=true" node --test tests/books-phase4-controls.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Supplier = require("../src/models/Supplier");
const Invoice = require("../src/models/Invoice");
const EditLog = require("../src/models/EditLog");
const accounting = require("../src/services/accounting.service");
const controls = require("../src/services/controls.service");
const context = require("../src/utils/request-context");
const { invoiceSequenceFor, buildInvoiceNumber, fyLabel, GST_INVOICE_NUMBER } = require("../src/utils/invoice");

const MONGO_URI = process.env.TEST_MONGO_URI;
const storedFiles = [];

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
});

test.after(async () => {
  for (const name of storedFiles) await fs.promises.unlink(path.join(controls.DOCUMENT_DIR, name)).catch(() => {});
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const uidOf = () => crypto.randomBytes(6).toString("hex");

const setup = async () => {
  const uid = uidOf();
  const business = await Business.create({
    name: `TOOR ${uid}`,
    slug: `toor-${uid}`,
    deploymentMode: "SELF_HOSTED",
    gstTaxId: "23CGZPB7175E1Z5",
    gstConfiguration: { enabled: true, gstin: "23CGZPB7175E1Z5", stateCode: "23" },
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const user = await User.create({ businessId: business._id, name: `U ${uid}`, email: `u-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  const customer = await Customer.create({ businessId: business._id, name: `Tenant ${uid}`, phone: "9876543210" });
  return { business, user, customer };
};

const manualEntry = async (business, user, day) => {
  const accounts = await accounting.ensureDefaultAccounts({ businessId: business._id });
  const byCode = (code) => accounts.get(code);
  const line = (a, dr, cr) => ({ accountId: a._id, accountCode: a.code, accountName: a.name, debitMinor: dr, creditMinor: cr });
  return accounting.postJournalEntry({
    businessId: business._id,
    userId: user._id,
    entryDate: new Date(`${day}T06:00:00Z`),
    description: "Test entry",
    sourceType: "MANUAL",
    sourceKey: `MANUAL:${uidOf()}`,
    lines: [line(byCode("5100"), 10000, 0), line(byCode("1010"), 0, 10000)],
  });
};

test("a closed period refuses postings on or before the lock day and accepts later ones; reopening allows them again", async () => {
  const { business, user } = await setup();
  await controls.setPeriodLock({ businessId: business._id, userId: user._id, lockedUpTo: "2026-09-30" });
  await assert.rejects(() => manualEntry(business, user, "2026-09-30"), (e) => e.statusCode === 409 && /closed up to 30-09-2026/.test(e.message));
  await assert.rejects(() => manualEntry(business, user, "2026-04-15"), (e) => e.statusCode === 409);
  const ok = await manualEntry(business, user, "2026-10-01");
  assert.ok(ok._id);

  const state = await controls.getPeriodLock({ businessId: business._id });
  assert.equal(state.lockedUpTo, "2026-09-30");
  await assert.rejects(() => controls.setPeriodLock({ businessId: business._id, userId: user._id, lockedUpTo: "2999-01-01" }), (e) => e.statusCode === 400);

  await controls.setPeriodLock({ businessId: business._id, userId: user._id, lockedUpTo: "" });
  const again = await manualEntry(business, user, "2026-09-30");
  assert.ok(again._id);

  // closing and reopening are themselves in the edit log
  const lockLines = await EditLog.find({ businessId: business._id, model: "Business", "changes.path": "booksLock" });
  assert.equal(lockLines.length, 2);
});

test("the edit log keeps creates, field changes and deletes with who made them, and cannot be changed", async () => {
  const { business, user } = await setup();
  let supplier;
  await context.run({ requestId: "req-1", ip: "10.0.0.5", userId: null, userEmail: "" }, async () => {
    context.setUser({ _id: user._id, email: user.email, name: user.name });
    supplier = await Supplier.create({ businessId: business._id, supplierName: "Landlord A", phone: "9876543212" });
    supplier.phone = "9000000001";
    await supplier.save();
    await Supplier.updateOne({ _id: supplier._id }, { $set: { supplierName: "Landlord A (HUF)" } });
    await Supplier.deleteOne({ _id: supplier._id });
  });

  const lines = await EditLog.find({ recordId: supplier._id }).sort({ at: 1, _id: 1 }).lean();
  assert.deepEqual(lines.map((l) => l.action), ["CREATE", "UPDATE", "UPDATE", "DELETE"]);
  assert.equal(lines[0].userEmail, user.email);
  assert.equal(lines[0].ip, "10.0.0.5");
  assert.deepEqual(lines[1].changes.map((c) => [c.path, c.before, c.after]), [["phone", "9876543212", "9000000001"]]);
  assert.equal(lines[2].changes.find((c) => c.path === "supplierName").after, "Landlord A (HUF)");
  assert.equal(lines[3].snapshot.supplierName, "Landlord A (HUF)");

  // the log itself cannot be edited or removed
  await assert.rejects(() => EditLog.updateOne({ _id: lines[0]._id }, { $set: { userEmail: "x" } }));
  await assert.rejects(() => EditLog.deleteMany({ businessId: business._id }));
  const doc = await EditLog.findById(lines[0]._id);
  doc.userEmail = "someone-else";
  await assert.rejects(() => doc.save());

  const page = await controls.listEditLog({ businessId: business._id, query: { model: "Supplier" } });
  assert.equal(page.pagination.total, 4);
  assert.ok(page.models.includes("Supplier"));
  const csv = await controls.exportEditLogCsv({ businessId: business._id, query: { recordId: String(supplier._id) } });
  assert.match(csv, /phone,9876543212,9000000001/);
});

test("a rolled-back transaction leaves no edit-log line", async () => {
  const { business } = await setup();
  const session = await mongoose.startSession();
  let id;
  try {
    await session.withTransaction(async () => {
      const [s] = await Supplier.create([{ businessId: business._id, supplierName: "Rolled back", phone: "9876543299" }], { session });
      id = s._id;
      throw new Error("stop");
    });
  } catch (error) {
    assert.equal(error.message, "stop");
  } finally {
    await session.endSession();
  }
  assert.equal(await EditLog.countDocuments({ recordId: id }), 0);
});

test("a {FY} invoice series restarts at 1 in a new financial year and stays within 16 characters", () => {
  const numbering = { prefix: "TOOR", format: "TOOR/{FY}/{0001}", nextSequence: 214, sequenceFy: "25-26" };
  const april = new Date("2026-04-01T00:30:00+05:30");
  assert.equal(fyLabel(april), "26-27");
  assert.equal(fyLabel(new Date("2026-03-31T23:30:00+05:30")), "25-26");
  assert.deepEqual(invoiceSequenceFor(numbering, april), { sequence: 1, sequenceFy: "26-27" });
  assert.deepEqual(invoiceSequenceFor({ ...numbering, sequenceFy: "26-27" }, april), { sequence: 214, sequenceFy: "26-27" });
  const number = buildInvoiceNumber({ prefix: "TOOR", format: numbering.format, sequence: 1, date: april });
  assert.equal(number, "TOOR/26-27/0001");
  assert.ok(GST_INVOICE_NUMBER.test(number));
  assert.ok(!GST_INVOICE_NUMBER.test("INV-2026-0001-EXTRA"));
  // formats without {FY} keep running across years
  assert.deepEqual(invoiceSequenceFor({ format: "INV-{YYYY}-{0001}", nextSequence: 9 }, april), { sequence: 9, sequenceFy: "" });
});

test("Goldhawk: watch levels against Rs 20 lakh, and GST bills only after its registration date is set", async () => {
  const { business: toor, user, customer } = await setup();
  const uid = uidOf();
  const gh = await Business.create({ name: `Goldhawk ${uid}`, slug: `gh-${uid}`, deploymentMode: "SELF_HOSTED", billingParentId: toor._id, billingEntityCode: "GOLDHAWK", gstConfiguration: { enabled: true, gstin: "23AAAAA0000A1Z5" } });
  assert.equal(gh.gstConfiguration.enabled, false, "GST stays off without a registration date");

  const bill = (amount, tax = 0) =>
    Invoice.create({
      businessId: gh._id, customerId: customer._id, invoiceNumber: `GH-${uidOf()}`, invoiceDate: new Date(), dueDate: new Date(),
      customerDetails: { name: customer.name }, businessDetails: { name: gh.name },
      lineItems: [{ productName: "Brokerage", quantity: 1, rate: amount, taxRate: tax ? 18 : 0, taxableAmount: amount, taxAmount: tax, tax, itemTotal: amount + tax }],
      subtotal: amount, totalTax: tax, grandTotal: amount + tax, amountPaid: 0, balanceDue: amount + tax, paymentStatus: "unpaid", status: "issued", createdBy: user._id,
    });

  await bill(1600000);
  let watch = await controls.goldhawkWatch({ businessId: toor._id });
  assert.equal(watch.level, "WARNING");
  assert.equal(watch.turnover, 1600000);
  await bill(300000);
  watch = await controls.goldhawkWatch({ businessId: toor._id });
  assert.equal(watch.level, "DANGER");
  await bill(200000);
  watch = await controls.goldhawkWatch({ businessId: toor._id });
  assert.equal(watch.level, "CROSSED");

  await assert.rejects(() => bill(10000, 1800), /must not contain GST/);

  gh.gstRegisteredFrom = new Date();
  gh.gstConfiguration = { enabled: true, gstin: "23AAAAA0000A1Z5", stateCode: "23", state: "Madhya Pradesh" };
  gh.gstTaxId = "23AAAAA0000A1Z5";
  await gh.save();
  watch = await controls.goldhawkWatch({ businessId: toor._id });
  assert.equal(watch.level, "REGISTERED");
  const withGst = await bill(10000, 1800);
  assert.equal(withGst.totalTax, 1800);
  assert.equal(await accounting.isGoldhawkBusiness({ businessId: gh._id }), false);
});

test("documents: a PDF agreement is attached to a landlord, read back, listed when ending, and refused when the content is not a PDF", async () => {
  const { business, user } = await setup();
  const landlord = await Supplier.create({ businessId: business._id, supplierName: "Landlord B", phone: "9876543213" });
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const ends = new Date(Date.now() + 20 * 86400000);
  const item = await controls.addAttachment({ businessId: business._id, userId: user._id, recordType: "supplier", recordId: landlord._id, fileBase64: pdf.toString("base64"), fileName: "lease.pdf", kind: "AGREEMENT", validFrom: "2025-12-01", validTo: ends.toISOString() });
  storedFiles.push(item.storedName);
  assert.equal(item.kind, "AGREEMENT");
  assert.equal(item.mimeType, "application/pdf");

  const { full } = await controls.readAttachment({ businessId: business._id, recordType: "supplier", recordId: landlord._id, attachmentId: item._id });
  assert.deepEqual(await fs.promises.readFile(full), pdf);

  const ending = await controls.expiringAgreements({ businessId: business._id, days: 30 });
  assert.equal(ending.length, 1);
  assert.equal(ending[0].fileName, "lease.pdf");

  await assert.rejects(
    () => controls.addAttachment({ businessId: business._id, userId: user._id, recordType: "supplier", recordId: landlord._id, fileBase64: Buffer.from("MZ not a pdf").toString("base64"), fileName: "lease.pdf" }),
    (e) => e.statusCode === 400 && /does not match/.test(e.message)
  );
  await assert.rejects(
    () => controls.addAttachment({ businessId: business._id, userId: user._id, recordType: "supplier", recordId: landlord._id, fileBase64: pdf.toString("base64"), fileName: "run.exe" }),
    (e) => e.statusCode === 400
  );

  // another business cannot read it
  const other = await setup();
  await assert.rejects(() => controls.readAttachment({ businessId: other.business._id, recordType: "supplier", recordId: landlord._id, attachmentId: item._id }), (e) => e.statusCode === 404);

  await controls.removeAttachment({ businessId: business._id, recordType: "supplier", recordId: landlord._id, attachmentId: item._id });
  const after = await Supplier.findById(landlord._id).lean();
  assert.equal(after.attachments.length, 0);
});
