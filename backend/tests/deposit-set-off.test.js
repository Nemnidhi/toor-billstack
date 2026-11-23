// Client answers (23 Nov 2026), item 7 (D15): (a) a tenant's deposit pays their unpaid invoices,
// and the set-off can be undone; (b) keeping part of a deposit with GST is a tax invoice (so it
// reaches GSTR-1) paid from the deposit. Runs the real app over HTTP against a throw-away database:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_deposit_setoff_test?replicaSet=rs0&directConnection=true" node --test tests/deposit-set-off.test.js
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
const Customer = require("../src/models/Customer");
const JournalEntry = require("../src/models/JournalEntry");
const { signAccessToken } = require("../src/services/auth.service");

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

const call = async (user, method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${signAccessToken(user)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};

const setup = async () => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `TOOR ${uid}`, slug: `toor-${uid}`, deploymentMode: "SELF_HOSTED", billingEntityCode: "TOOR", onboardingCompleted: true,
    gstTaxId: "23AAACI1195H1ZK", gstConfiguration: { enabled: true, stateCode: "23", gstin: "23AAACI1195H1ZK" },
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const owner = await User.create({ businessId: business._id, name: `Owner ${uid}`, email: `owner-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  const customer = await Customer.create({ businessId: business._id, name: "Tenant Pvt Ltd", gstNumber: "23AAPFU0939F1ZW", billingAddress: "Indore, Madhya Pradesh", stateCode: "23" });
  const invoice = async (amount, date) => {
    const res = await call(owner, "POST", "/invoices", { customerId: customer._id, invoiceDate: date, allowDuplicate: true, lineItems: [{ productName: "Cabin rent", hsnSac: "997212", quantity: 1, rate: amount, taxRate: 18 }] });
    assert.equal(res.status, 201, res.json.message);
    return res.json.data;
  };
  const deposit = await call(owner, "POST", "/accounting/deposits?entity=TOOR", { direction: "RECEIVED", customerId: customer._id, amount: 50000, date: "2026-04-05", purpose: "SECURITY" });
  assert.equal(deposit.status, 201, deposit.json.message);
  return { business, owner, customer, invoice, deposit: deposit.json.data };
};

const balances = async (businessId) => {
  const sum = {};
  for (const je of await JournalEntry.find({ businessId, status: "POSTED" }).lean()) {
    for (const l of je.lines) sum[l.accountCode] = (sum[l.accountCode] || 0) + (l.debitMinor - l.creditMinor) / 100;
  }
  return sum;
};

test("D15a: a deposit pays two invoices; books, invoices and the deposit agree; undo puts it all back", async () => {
  const { business, owner, invoice, deposit } = await setup();
  const a = await invoice(10000, "2026-09-01"); // 11,800 with GST
  const b = await invoice(5000, "2026-10-01"); // 5,900
  const before = await balances(business._id);

  const options = await call(owner, "GET", `/accounting/deposits/${deposit._id}/set-off?entity=TOOR`);
  assert.equal(options.status, 200, options.json.message);
  assert.deepEqual(options.json.data.invoices.map((i) => i.balanceDue), [11800, 5900]);

  const res = await call(owner, "POST", `/accounting/deposits/${deposit._id}/set-off?entity=TOOR`, { date: "2026-11-20", allocations: [{ invoiceId: a._id, amount: 11800 }, { invoiceId: b._id, amount: 2000 }], note: "tenant left" });
  assert.equal(res.status, 200, res.json.message);
  assert.deepEqual(res.json.data.failed, []);
  assert.equal(res.json.data.total, 13800);
  assert.equal(res.json.data.deposit.balance, 36200);

  const inv = async (id) => (await call(owner, "GET", `/invoices/${id}`)).json.data;
  assert.equal((await inv(a._id)).balanceDue, 0);
  assert.equal((await inv(b._id)).balanceDue, 3900);

  const after = await balances(business._id);
  const moved = (code) => Math.round(((after[code] || 0) - (before[code] || 0)) * 100) / 100;
  assert.equal(moved("2410"), 13800, "the deposit held for the tenant fell by 13,800 (a debit)");
  assert.equal(moved("1100"), -13800, "receivables fell by the same");
  assert.equal(moved("1020"), 0, "no money moved through the bank");
  assert.equal(moved("2100"), 0, "nothing left waiting as an advance");

  // Payments cannot reverse it on its own; the deposit undoes it.
  const blocked = await call(owner, "POST", `/payments/${res.json.data.paymentId}/reverse`, { reason: "x" });
  assert.notEqual(blocked.status, 200);
  const moveId = res.json.data.deposit.movements.find((m) => m.kind === "SET_OFF")._id;
  const undo = await call(owner, "POST", `/accounting/deposits/${deposit._id}/set-off/${moveId}/undo?entity=TOOR`, {});
  assert.equal(undo.status, 200, undo.json.message);
  assert.equal(undo.json.data.balance, 50000);
  assert.equal((await inv(a._id)).balanceDue, 11800);
  const undone = await balances(business._id);
  for (const code of ["2410", "1100", "1020", "2100"]) assert.equal(Math.round(((undone[code] || 0) - (before[code] || 0)) * 100), 0, `${code} back where it was`);
});

test("D15a checks: not more than the deposit or the invoice, only the tenant's own invoices", async () => {
  const { owner, invoice, deposit } = await setup();
  const a = await invoice(50000, "2026-09-01"); // 59,000
  const tooMuch = await call(owner, "POST", `/accounting/deposits/${deposit._id}/set-off?entity=TOOR`, { allocations: [{ invoiceId: a._id, amount: 59000 }] });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.json.message, /Only 50000 is left/);
  const overInvoice = await call(owner, "POST", `/accounting/deposits/${deposit._id}/set-off?entity=TOOR`, { allocations: [{ invoiceId: a._id, amount: 60000 }] });
  assert.match(overInvoice.json.message, /is due on invoice/);

  const other = await Customer.create({ businessId: deposit.businessId, name: "Someone Else", stateCode: "23" });
  const theirs = await call(owner, "POST", "/invoices", { customerId: other._id, allowDuplicate: true, lineItems: [{ productName: "Day pass", hsnSac: "997212", quantity: 1, rate: 500, taxRate: 18 }] });
  assert.equal(theirs.status, 201, theirs.json.message);
  const wrong = await call(owner, "POST", `/accounting/deposits/${deposit._id}/set-off?entity=TOOR`, { allocations: [{ invoiceId: theirs.json.data._id, amount: 590 }] });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.message, /is not Tenant Pvt Ltd's/);
});

test("D15b: keeping part of the deposit with GST is a tax invoice paid from the deposit", async () => {
  const { owner, invoice, deposit } = await setup();
  // What the Deposits page does for "Keep with GST": an invoice whose total is the amount kept
  // (GST included), then a set-off of that invoice.
  const kept = 11800;
  const recovery = await invoice(Math.round((kept / 1.18) * 100) / 100, "2026-11-20");
  assert.equal(recovery.grandTotal, kept);
  assert.equal(recovery.gstBreakup.cgst + recovery.gstBreakup.sgst, 1800);
  const res = await call(owner, "POST", `/accounting/deposits/${deposit._id}/set-off?entity=TOOR`, { date: "2026-11-20", allocations: [{ invoiceId: recovery._id, amount: recovery.grandTotal }] });
  assert.equal(res.status, 200, res.json.message);
  assert.equal(res.json.data.deposit.balance, 38200, "the rest is still the tenant's, to refund");
});

test("an older deposit typed with a name only is linked to the customer on its first set-off; the register keeps undone history", async () => {
  const { owner, customer, invoice } = await setup();
  const named = await call(owner, "POST", "/accounting/deposits?entity=TOOR", { direction: "RECEIVED", partyName: "Tenant (old entry)", amount: 20000, date: "2026-04-01" });
  const a = await invoice(1000, "2026-09-01");
  const none = await call(owner, "POST", `/accounting/deposits/${named.json.data._id}/set-off?entity=TOOR`, { allocations: [{ invoiceId: a._id, amount: 1180 }] });
  assert.match(none.json.message, /Choose whose deposit/);
  const listed = await call(owner, "GET", `/accounting/deposits/${named.json.data._id}/set-off?entity=TOOR&customerId=${customer._id}`);
  assert.equal(listed.json.data.invoices.length, 1);
  const res = await call(owner, "POST", `/accounting/deposits/${named.json.data._id}/set-off?entity=TOOR`, { customerId: customer._id, allocations: [{ invoiceId: a._id, amount: 1180 }] });
  assert.equal(res.status, 200, res.json.message);
  assert.equal(String(res.json.data.deposit.customerId), String(customer._id));
  const move = res.json.data.deposit.movements[0];
  await call(owner, "POST", `/accounting/deposits/${named.json.data._id}/set-off/${move._id}/undo?entity=TOOR`, {});
  const register = await call(owner, "GET", "/accounting/deposits?entity=TOOR");
  const row = register.json.data.rows.find((r) => r._id === named.json.data._id);
  assert.equal(row.balance, 20000);
  assert.equal(row.movements.length, 1, "the undone set-off is still in the history");
  assert.ok(row.movements[0].undoneAt);
});
