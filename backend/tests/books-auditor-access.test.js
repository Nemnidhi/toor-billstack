// Client answers (23 Nov 2026), item 1: the auditor role (D11) - reads what an accountant reads,
// changes nothing except the areas the owner grants - and the accountant closing / reopening the
// books (D14). Runs the real app over HTTP against a throw-away database:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_auditor_test?replicaSet=rs0&directConnection=true" node --test tests/books-auditor-access.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
process.env.BILLSTACK_DEPLOYMENT_MODE = "SELF_HOSTED";
process.env.NODE_ENV = "test";
const mongoose = require("mongoose");
const app = require("../src/app");
const Business = require("../src/models/Business");
const User = require("../src/models/User");
const { signAccessToken } = require("../src/services/auth.service");
const entities = require("../src/services/billing-entity.service");

const MONGO_URI = process.env.TEST_MONGO_URI;
let server;
let base;

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await require("../src/config/db").ensureBusinessIndexes();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const call = async (user, method, path, body, headers = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${signAccessToken(user)}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

const setup = async () => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `TOOR ${uid}`, slug: `toor-${uid}`, deploymentMode: "SELF_HOSTED", billingEntityCode: "TOOR", onboardingCompleted: true,
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const make = (role, extra = {}) => User.create({ businessId: business._id, name: `${role} ${uid}`, email: `${role}-${uid}@example.com`, password: "x".repeat(20), role, ...extra });
  return { business, owner: await make("owner"), accountant: await make("accountant"), auditor: await make("auditor"), staff: await make("staff") };
};

const expense = { category: "Rent", amountBeforeTax: 1000, expenseDate: "2026-10-03" };

test("an auditor reads what an accountant reads and changes nothing", async () => {
  const { auditor, staff } = await setup();
  for (const path of ["/expenses", "/invoices", "/customers", "/accounting/reports/profit-loss?entity=TOOR", "/accounting/trial-balance", "/accounting/period-lock?entity=TOOR", "/accounting/reports/tag-matrix", "/accounting/reports/management.pdf?entity=TOOR"]) {
    const { status, json } = await call(auditor, "GET", path);
    assert.equal(status, 200, `${path}: ${json.message}`);
  }
  const blocked = await call(auditor, "POST", "/expenses", expense);
  assert.equal(blocked.status, 403);
  assert.match(blocked.json.message, /read-only/);
  assert.equal((await call(auditor, "POST", "/customers", { name: "X" })).status, 403);
  assert.equal((await call(auditor, "PUT", "/accounting/period-lock?entity=TOOR", { lockedUpTo: "2026-09-30" })).status, 403);
  assert.equal((await call(auditor, "GET", "/team")).status, 403, "team stays owner / admin only");
  assert.equal((await call(staff, "GET", "/accounting/trial-balance")).status, 403, "staff still cannot read the books");
});

test("granted areas: an auditor acts as an accountant there and nowhere else", async () => {
  const { owner, auditor } = await setup();
  const set = await call(owner, "PUT", `/team/${auditor._id}`, { grants: ["expenses", "period_lock", "not-a-grant"] });
  assert.equal(set.status, 200, set.json.message);
  assert.deepEqual(set.json.data.grants, ["expenses", "period_lock"], "unknown grants are dropped");
  const fresh = await User.findById(auditor._id);

  const created = await call(fresh, "POST", "/expenses", expense);
  assert.equal(created.status, 201, created.json.message);
  assert.equal((await call(fresh, "POST", "/customers", { name: "X" })).status, 403, "clients were not granted");
  const locked = await call(fresh, "PUT", "/accounting/period-lock?entity=TOOR", { lockedUpTo: "2026-09-30" });
  assert.equal(locked.status, 200, locked.json.message);

  // Changing the role away from auditor clears the grants.
  const back = await call(owner, "PUT", `/team/${auditor._id}`, { role: "staff" });
  assert.deepEqual(back.json.data.grants, []);
});

test("D14: the accountant closes and reopens the books; staff cannot", async () => {
  const { accountant, staff } = await setup();
  const close = await call(accountant, "PUT", "/accounting/period-lock?entity=TOOR", { lockedUpTo: "2026-09-30" });
  assert.equal(close.status, 200, close.json.message);
  const reopen = await call(accountant, "PUT", "/accounting/period-lock?entity=TOOR", { lockedUpTo: null });
  assert.equal(reopen.status, 200, reopen.json.message);
  assert.equal((await call(staff, "PUT", "/accounting/period-lock?entity=TOOR", { lockedUpTo: "2026-09-30" })).status, 403);
});

test("an auditor can be given another business read-only; new team members never get personal books", async () => {
  const { business, owner, auditor } = await setup();
  const personal = await entities.createEntity(owner, { name: "Founder personal", kind: "PERSONAL" });
  const side = await entities.createEntity(owner, { name: "Side Co" });
  await entities.grantAccess(owner, { userId: auditor._id, businessId: side._id, role: "auditor" });
  const header = { "x-business-id": String(side._id) };
  assert.equal((await call(auditor, "GET", "/expenses", undefined, header)).status, 200);
  assert.equal((await call(auditor, "POST", "/expenses", expense, header)).status, 403);

  const made = await call(owner, "POST", "/team", { name: "New Person", email: `new-${business._id}@example.com`, password: "Abcdef12#xyz", role: "accountant" });
  assert.equal(made.status, 201, made.json.message);
  const Membership = require("../src/models/BusinessMembership");
  const theirs = (await Membership.find({ userId: made.json.data.id })).map((m) => String(m.businessId));
  assert.ok(theirs.includes(String(side._id)), "the group's companies, as before");
  assert.ok(!theirs.includes(String(personal._id)), "but not personal books");
});
