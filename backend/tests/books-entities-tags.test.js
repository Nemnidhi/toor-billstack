// Client answers (23 Nov 2026), items 2 and 3: more businesses with their own books (companies and
// the founder's personal books), and the group-wide business line x category tags with their report.
// Needs a replica-set MongoDB:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_entities_test?replicaSet=rs0&directConnection=true" node --test tests/books-entities-tags.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Invoice = require("../src/models/Invoice");
const JournalEntry = require("../src/models/JournalEntry");
const entities = require("../src/services/billing-entity.service");
const tags = require("../src/services/reporting-tags.service");
const expenses = require("../src/services/expense.service");
const accounting = require("../src/services/accounting.service");
const { getTagMatrix } = require("../src/services/tag-matrix.service");
const { buildManagementReportPdf, slicesOf, pieSvg } = require("../src/services/management-report-pdf.service");
const reports = require("../src/services/accounting-reports.service");

const MONGO_URI = process.env.TEST_MONGO_URI;

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  // Start from the old index, as on a live server, and check the startup step replaces it.
  await Business.init();
  await Business.collection.dropIndex("billing_entity_code_once_per_group").catch(() => {});
  await Business.collection.createIndex({ billingParentId: 1, billingEntityCode: 1 }, { unique: true, partialFilterExpression: { billingParentId: { $type: "objectId" } } });
  await require("../src/config/db").ensureBusinessIndexes();
  const names = (await Business.collection.indexes()).map((i) => i.name);
  assert.ok(!names.includes("billingParentId_1_billingEntityCode_1") && names.includes("billing_entity_code_once_per_group"));
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const setup = async () => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `TOOR ${uid}`, slug: `toor-${uid}`, deploymentMode: "SELF_HOSTED", billingEntityCode: "TOOR",
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const owner = await User.create({ businessId: business._id, name: `Owner ${uid}`, email: `o-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  const admin = await User.create({ businessId: business._id, name: `Admin ${uid}`, email: `a-${uid}@example.com`, password: "x".repeat(20), role: "admin" });
  const accountant = await User.create({ businessId: business._id, name: `Acct ${uid}`, email: `c-${uid}@example.com`, password: "x".repeat(20), role: "accountant" });
  return { business, owner, admin, accountant };
};

const balance = async (businessId, code) => {
  const entries = await JournalEntry.find({ businessId, status: "POSTED" });
  let n = 0;
  for (const e of entries) for (const l of e.lines) if (l.accountCode === code) n += l.debitMinor - l.creditMinor;
  return n;
};

test("the group owner adds companies and personal books; personal books stay private", async () => {
  const { business, owner, admin } = await setup();
  await assert.rejects(() => entities.createEntity(admin, { name: "Side Co" }), /primary billing company owner/);
  await assert.rejects(() => entities.createEntity(owner, { name: "Side Co", gstin: "BAD" }), /GSTIN is not valid/);

  const side = await entities.createEntity(owner, { name: "Side Co", gstin: "23ABCDE1234F1Z5", invoicePrefix: "sc" });
  assert.equal(String(side.billingParentId), String(business._id));
  assert.equal(side.entityKind, "COMPANY");
  assert.equal(side.gstConfiguration.enabled, true);
  assert.equal(side.invoiceNumbering.prefix, "SC");
  await assert.rejects(() => entities.createEntity(owner, { name: "side co" }), /already exists/);

  const personal = await entities.createEntity(owner, { name: "Founder personal", kind: "PERSONAL", gstin: "23ABCDE1234F1Z5" });
  assert.equal(personal.entityKind, "PERSONAL");
  assert.equal(personal.gstConfiguration.enabled, false, "personal books never carry GST");

  const ownerSees = (await entities.listEntities(owner)).map((e) => e.name);
  assert.ok(ownerSees.includes("Side Co") && ownerSees.includes("Founder personal"));
  const adminSees = (await entities.listEntities(admin)).map((e) => e.name);
  assert.ok(adminSees.includes("Side Co"), "an admin of the group reaches the group's companies");
  assert.ok(!adminSees.includes("Founder personal"), "but not someone's personal books");
  await assert.rejects(() => entities.resolveEntityUser(admin, personal._id));

  // Access by hand: the owner grants the admin the personal books.
  await entities.grantAccess(owner, { userId: admin._id, businessId: personal._id, role: "accountant" });
  assert.ok((await entities.listEntities(admin)).some((e) => e.name === "Founder personal"));
  assert.equal((await entities.resolveEntityUser(admin, personal._id)).role, "accountant");

  // Rename and archive.
  await entities.updateEntity(owner, side._id, { name: "Side Company" });
  await entities.updateEntity(owner, side._id, { archived: true });
  assert.ok(!(await entities.listEntities(owner)).some((e) => e.name === "Side Company"), "archived businesses drop out of the switcher");
  const gh = await entities.ensureGoldhawk(owner);
  await assert.rejects(() => entities.updateEntity(owner, gh._id, { archived: true }), /cannot be archived/);
  await assert.rejects(() => Business.create({ name: "GH 2", slug: `gh2-${business._id}`, billingParentId: business._id, billingEntityCode: "GOLDHAWK" }), /E11000/, "still one Goldhawk per group");
});

test("an expense paid by credit card is owed to the card, not paid from the bank", async () => {
  const { owner } = await setup();
  const personal = await entities.createEntity(owner, { name: "Founder card", kind: "PERSONAL" });
  await expenses.createExpense({ businessId: personal._id, userId: owner._id, payload: { category: "Travel & Conveyance", amountBeforeTax: 4200, paymentStatus: "PAID", paidAmount: 4200, paymentMethod: "CREDIT_CARD", expenseDate: "2026-11-05" } });
  assert.equal(await balance(personal._id, "2060"), -420000, "card payable credited");
  assert.equal(await balance(personal._id, "1020"), 0, "bank untouched until the card bill is paid");
});

test("business lines and categories: one list for the group, checked on save, archived not renamed", async () => {
  const { business, owner, accountant } = await setup();
  const child = await entities.createEntity(owner, { name: "Second Co" });
  await assert.rejects(() => tags.setTagLists(business._id, { businessLines: ["Workspace", "workspace"] }), /twice/);
  await tags.setTagLists(business._id, { businessLines: ["Workspace", "TOOR"], categories: ["C1", "C2"] });
  const fromChild = await tags.getTagLists(child._id);
  assert.deepEqual(fromChild.businessLines.map((r) => r.name), ["Workspace", "TOOR"], "a child company reads the group's lists");

  // Dropping a name keeps it as archived.
  await tags.setTagLists(child._id, { categories: ["C1"] });
  const after = await tags.getTagLists(business._id);
  assert.deepEqual(after.categories, [{ name: "C1", archived: false }, { name: "C2", archived: true }]);

  assert.deepEqual(await tags.cleanTags(child._id, { businessLine: "workspace", reportCategory: "" }), { businessLine: "Workspace", reportCategory: "" });
  await assert.rejects(() => tags.cleanTags(child._id, { businessLine: "Retail" }), /not a business line yet/);
  await assert.rejects(() => tags.cleanTags(child._id, { reportCategory: "C2" }), /archived/);
  assert.deepEqual(await tags.cleanTags(child._id, { reportCategory: "C2" }, { reportCategory: "C2" }), { reportCategory: "C2" }, "a document keeps an archived name it already had");
  assert.deepEqual(await tags.cleanTags(child._id, { notes: "x" }), {}, "an edit without tags leaves them alone");
  void accountant;
});

test("the business line x category report: income, expenses, profit, shares and companies", async () => {
  const { business, owner, accountant } = await setup();
  const second = await entities.createEntity(owner, { name: "Second Co" });
  await tags.setTagLists(business._id, { businessLines: ["Workspace", "Enterprise"], categories: ["C1", "C2"] });

  const customer = await Customer.create({ businessId: business._id, name: "Client A", createdBy: owner._id });
  const invoice = await Invoice.create({
    businessId: business._id, customerId: customer._id, invoiceNumber: "INV-T1", invoiceDate: new Date("2026-10-01T00:00:00Z"), dueDate: new Date("2026-10-01T00:00:00Z"),
    customerDetails: { name: customer.name }, businessDetails: { name: business.name },
    lineItems: [{ productName: "Desk rent", quantity: 1, rate: 30000, taxRate: 0, itemTotal: 30000 }],
    subtotal: 30000, totalTax: 0, grandTotal: 30000, amountPaid: 0, balanceDue: 30000, paymentStatus: "unpaid", status: "issued",
    businessLine: "Workspace", reportCategory: "C1", createdBy: owner._id,
  });
  await accounting.postInvoiceJournalEntry({ invoice, business, userId: owner._id });
  await expenses.createExpense({ businessId: business._id, userId: owner._id, payload: { category: "Housekeeping & Security", amountBeforeTax: 8000, expenseDate: "2026-10-04", businessLine: "Workspace", reportCategory: "C2" } });
  await expenses.createExpense({ businessId: second._id, userId: owner._id, payload: { category: "Internet & Communication", amountBeforeTax: 2000, expenseDate: "2026-10-04", businessLine: "Enterprise" } });

  const entries = await JournalEntry.find({ businessId: business._id, status: "POSTED" }).lean();
  assert.ok(entries.flatMap((e) => e.lines).some((l) => l.businessLine === "Workspace" && l.reportCategory === "C1"), "journal lines carry the tags");

  const period = { from: "2026-04-01", to: "2027-03-31" };
  const one = await getTagMatrix({ user: owner, query: { ...period, measure: "profit" } });
  assert.equal(one.total, 22000, "only the current company");
  const ws = one.rows.find((r) => r.key === "Workspace");
  assert.deepEqual(ws.cells.map((c) => [c.column, c.amount]), [["C1", 30000], ["C2", -8000]]);

  const group = await getTagMatrix({ user: owner, query: { ...period, entity: "all", measure: "expenses" } });
  assert.equal(group.total, 10000);
  const notSet = group.columns.find((c) => c.key === group.notSetKey);
  assert.deepEqual([notSet.label, notSet.total, notSet.percentOfTotal], ["Not set", 2000, 20]);
  assert.equal(group.rows.find((r) => r.key === "Enterprise").percentOfTotal, 20);

  const byCompany = await getTagMatrix({ user: owner, query: { ...period, entity: "all", rows: "company", measure: "income" } });
  assert.deepEqual(byCompany.rows.map((r) => [r.label, r.total]), [[business.name, 30000], ["Second Co", 0]]);

  await assert.rejects(() => getTagMatrix({ user: owner, query: { rows: "reportCategory", columns: "reportCategory" } }), /must be different/);
  assert.equal((await getTagMatrix({ user: owner, query: { ...period, entity: "TOOR" } })).total, 22000, "TOOR = the primary company");
  assert.equal((await getTagMatrix({ user: owner, query: { ...period, entity: String(second._id), measure: "expenses" } })).total, 2000);
  const viaAccountant = await getTagMatrix({ user: accountant, query: { ...period } });
  assert.equal(viaAccountant.total, 22000, "an accountant of the company reads it");
});

test("the management report PDF: pies group the tail as Others, and the file renders from real books", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ label: `H${i}`, value: 100 - i }));
  const slices = slicesOf([...many, { label: "Loss", value: -50 }]);
  assert.equal(slices.length, 7);
  assert.deepEqual(slices.at(-1), { label: "Others", value: 94 + 93 + 92 + 91 });
  assert.ok(!slices.some((s) => s.label === "Loss"), "a pie shows positive amounts only");
  assert.match(pieSvg([{ label: "All", value: 5 }]), /<circle/);
  assert.equal(pieSvg([]), null);

  const { business, owner } = await setup();
  await tags.setTagLists(business._id, { businessLines: ["Workspace"], categories: ["C1"] });
  await expenses.createExpense({ businessId: business._id, userId: owner._id, payload: { category: "Rent", amountBeforeTax: 5000, expenseDate: "2026-10-04", businessLine: "Workspace", reportCategory: "C1" } });
  const period = { from: "2026-04-01", to: "2027-03-31" };
  const pl = await reports.getProfitAndLossReport({ businessId: business._id, query: period });
  const m = (measure) => getTagMatrix({ user: owner, query: { ...period, measure } });
  const pdf = await buildManagementReportPdf({ pl, matrixIncome: await m("income"), matrixProfit: await m("profit"), companies: [business.name] });
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(pdf.length > 5000);
});
