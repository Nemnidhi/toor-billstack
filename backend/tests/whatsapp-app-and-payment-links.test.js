// Invoices, reminders and receipts through the company's WhatsApp app (signed calls, the customer's
// agreement, status reported back), and Razorpay payment links on invoices with the business's own
// keys: a paid link is recorded against the invoice (fee as a bank charge), a settlement moves the
// money to the bank. Runs the real app over HTTP against a throw-away database:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_wa_links_test?replicaSet=rs0&directConnection=true" node --test tests/whatsapp-app-and-payment-links.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");

process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
process.env.BILLSTACK_DEPLOYMENT_MODE = "SELF_HOSTED";
process.env.NODE_ENV = "test";
process.env.BILLSTACK_DATA_KEY = crypto.randomBytes(32).toString("hex");
const APP_SECRET = "whatsapp-app-secret-for-tests-0123456789abcdef";
process.env.WHATSAPP_APP_SECRET = APP_SECRET;
const WEBHOOK_SECRET = "rzp-webhook-secret-123";

const mongoose = require("mongoose");
const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Invoice = require("../src/models/Invoice");
const JournalEntry = require("../src/models/JournalEntry");
const MessageDelivery = require("../src/models/MessageDelivery");
const OnlinePaymentLink = require("../src/models/OnlinePaymentLink");
const Payment = require("../src/models/Payment");
const { signAccessToken } = require("../src/services/auth.service");
const onlinePayments = require("../src/services/online-payment.service");

const MONGO_URI = process.env.TEST_MONGO_URI;
let app;
let server;
let base;
let fakeApp;
const appCalls = [];
const razorpayCalls = [];
let linkCounter = 0;
// What Razorpay's settlement recon answers (set per test).
let reconItems = [];

const sign = (secret, timestamp, body) => crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/** A stand-in for the WhatsApp app: checks the signature; reminders are "not switched on". */
const startFakeApp = () => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const valid = req.headers["x-oor-caller"] === "billstack" && sign(APP_SECRET, req.headers["x-oor-timestamp"], body) === req.headers["x-oor-signature"];
      const payload = JSON.parse(body || "{}");
      appCalls.push({ url: req.url, valid, body: payload });
      res.writeHead(valid ? 201 : 401, { "content-type": "application/json" });
      if (!valid) return res.end(JSON.stringify({ error: "BAD_SIGNATURE" }));
      if (payload.purpose === "payment_reminder") return res.end(JSON.stringify({ data: { key: payload.key, purpose: payload.purpose, status: "skipped", reason: "This message is not switched on in the WhatsApp app (Settings > Automatic messages)." } }));
      res.end(JSON.stringify({ data: { key: payload.key, purpose: payload.purpose, status: "queued", reason: "" } }));
    });
  });
  srv.listen(0, "127.0.0.1", () => resolve(srv));
});

/** Razorpay's API, as BillStack calls it. */
const fakeRazorpay = async (url, options = {}) => {
  const path = new URL(url).pathname + new URL(url).search;
  const body = options.body ? JSON.parse(options.body) : null;
  razorpayCalls.push({ method: options.method, path, body, auth: options.headers?.Authorization || "" });
  const reply = (status, data) => ({ ok: status < 300, status, json: async () => data });
  if (!String(options.headers?.Authorization || "").startsWith("Basic ")) return reply(401, { error: { description: "no auth" } });
  if (options.method === "GET" && path.startsWith("/v1/payment_links")) return reply(200, { count: 0, items: [] });
  if (options.method === "POST" && path === "/v1/payment_links") {
    linkCounter += 1;
    return reply(200, { id: `plink_test${linkCounter}`, short_url: `https://rzp.io/i/test${linkCounter}`, status: "created", amount: body.amount, reference_id: body.reference_id });
  }
  if (options.method === "POST" && /\/cancel$/.test(path)) return reply(200, { status: "cancelled" });
  if (options.method === "GET" && path.startsWith("/v1/settlements/recon/combined")) return reply(200, { entity: "collection", count: reconItems.length, items: reconItems });
  return reply(404, { error: { description: "unknown" } });
};

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  fakeApp = await startFakeApp();
  process.env.WHATSAPP_APP_URL = `http://127.0.0.1:${fakeApp.address().port}`;
  onlinePayments.setFetchForTests(fakeRazorpay);
  app = require("../src/app");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await require("../src/config/db").ensureBusinessIndexes();
  await OnlinePaymentLink.syncIndexes();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  fakeApp?.close();
  onlinePayments.setFetchForTests(null);
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
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const post = async (path, raw, headers) => {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const razorpayWebhook = (businessId, payload, { secret = WEBHOOK_SECRET, eventId = crypto.randomBytes(6).toString("hex") } = {}) => {
  const raw = JSON.stringify(payload);
  return post(`/online-payments/webhooks/razorpay/${businessId}`, raw, { "x-razorpay-signature": crypto.createHmac("sha256", secret).update(raw).digest("hex"), "x-razorpay-event-id": eventId });
};

const appStatus = (payload, { secret = APP_SECRET, timestamp = String(Date.now()) } = {}) => {
  const raw = JSON.stringify(payload);
  return post("/communications/webhooks/whatsapp-app/status", raw, { "x-oor-timestamp": timestamp, "x-oor-signature": sign(secret, timestamp, raw) });
};

const balances = async (businessId) => {
  const sum = {};
  for (const je of await JournalEntry.find({ businessId, status: "POSTED" }).lean()) {
    for (const l of je.lines) sum[l.accountCode] = Math.round(((sum[l.accountCode] || 0) + (l.debitMinor - l.creditMinor) / 100) * 100) / 100;
  }
  return sum;
};

const setup = async () => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `The Office on Rent ${uid}`, slug: `toor-${uid}`, deploymentMode: "SELF_HOSTED", billingEntityCode: "TOOR", onboardingCompleted: true,
    gstTaxId: "23AAACI1195H1ZK", gstConfiguration: { enabled: true, stateCode: "23", gstin: "23AAACI1195H1ZK" },
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const owner = await User.create({ businessId: business._id, name: `Owner ${uid}`, email: `owner-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  const customer = await Customer.create({ businessId: business._id, name: "Asha Traders", phone: "98000 00001", gstNumber: "23AAPFU0939F1ZW", billingAddress: "Indore, Madhya Pradesh", stateCode: "23" });
  const res = await call(owner, "POST", "/invoices", { customerId: customer._id, invoiceDate: "2026-11-01", dueDate: "2026-11-30", allowDuplicate: true, lineItems: [{ productName: "Cabin rent", hsnSac: "997212", quantity: 1, rate: 10000, taxRate: 18 }] });
  assert.equal(res.status, 201, res.json.message);
  return { business, owner, customer, invoice: res.json.data };
};

test("payment links: the business's own keys, checked and stored sealed; one open link per invoice for what is due", async () => {
  const { business, owner, invoice } = await setup();
  const off = await call(owner, "POST", `/online-payments/invoices/${invoice._id}/link`);
  assert.equal(off.status, 400);
  assert.match(off.json.message, /not switched on/);

  const noHook = await call(owner, "PUT", "/online-payments/settings", { enabled: true, keyId: "rzp_test_Abc123XYZ", keySecret: "secret-key-0123456789" });
  assert.equal(noHook.status, 400, "a webhook secret is needed to record paid links");
  const saved = await call(owner, "PUT", "/online-payments/settings", { enabled: true, keyId: "rzp_test_Abc123XYZ", keySecret: "secret-key-0123456789", webhookSecret: WEBHOOK_SECRET });
  assert.equal(saved.status, 200, saved.json.message);
  assert.equal(saved.json.data.enabled, true);
  assert.equal(saved.json.data.keySecretSaved, true);
  assert.equal(saved.json.data.keySecret, undefined, "secrets never go back to the page");
  assert.ok(razorpayCalls.some((row) => row.method === "GET"), "the keys were checked with Razorpay");
  const stored = await Business.findById(business._id).select("+onlinePayments.keySecretSealed").lean();
  assert.match(stored.onlinePayments.keySecretSealed, /^v1:/);
  assert.ok(!stored.onlinePayments.keySecretSealed.includes("secret-key"), "sealed, not plain");

  const first = await call(owner, "POST", `/online-payments/invoices/${invoice._id}/link`);
  assert.equal(first.status, 201, first.json.message);
  assert.equal(first.json.data.amount, 11800);
  const created = razorpayCalls.find((row) => row.path === "/v1/payment_links" && row.method === "POST");
  assert.equal(created.body.amount, 1180000);
  assert.deepEqual(created.body.notify, { sms: false, email: false });
  assert.equal(created.body.customer.contact, "+919800000001");
  const again = await call(owner, "POST", `/online-payments/invoices/${invoice._id}/link`);
  assert.equal(String(again.json.data.id), String(first.json.data.id), "same amount due: the same link");

  const accountant = await User.create({ businessId: business._id, name: "Staff", email: `staff-${Date.now()}@example.com`, password: "x".repeat(20), role: "staff" });
  assert.equal((await call(accountant, "PUT", "/online-payments/settings", { enabled: false })).status, 403);
});

test("an invoice goes to the WhatsApp app only for a customer who agreed, with the pay link; status comes back signed", async () => {
  const { business, owner, customer, invoice } = await setup();
  await call(owner, "PUT", "/online-payments/settings", { enabled: true, keyId: "rzp_test_Abc123XYZ", keySecret: "secret-key-0123456789", webhookSecret: WEBHOOK_SECRET });
  const settings = await call(owner, "GET", "/communications/settings");
  assert.equal(settings.status, 200, settings.json.message);
  assert.equal(settings.json.data.whatsapp.provider, "WHATSAPP_APP");
  assert.equal(settings.json.data.whatsapp.configured, true);
  await call(owner, "GET", "/communications/templates");

  appCalls.length = 0;
  const refused = await call(owner, "POST", `/communications/invoices/${invoice._id}/send`, { channel: "WHATSAPP", category: "INVOICE_CREATED" });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /not agreed to WhatsApp/);
  assert.equal(appCalls.length, 0);

  const agreed = await call(owner, "PUT", `/customers/${customer._id}`, { name: customer.name, phone: customer.phone, gstNumber: customer.gstNumber, billingAddress: customer.billingAddress, whatsappConsent: { given: true, source: "told on the phone, 20 Nov" } });
  assert.equal(agreed.status, 200, agreed.json.message);
  assert.equal(agreed.json.data.whatsappConsent.given, true);

  const sent = await call(owner, "POST", `/communications/invoices/${invoice._id}/send`, { channel: "WHATSAPP", category: "INVOICE_CREATED" });
  assert.equal(sent.status, 200, sent.json.message);
  const asked = appCalls.find((row) => row.url === "/integrations/v1/messages");
  assert.ok(asked.valid, "signed with the shared secret, caller billstack");
  assert.equal(asked.body.purpose, "invoice_sent");
  assert.equal(asked.body.to, "98000 00001");
  assert.equal(asked.body.consent.given, true);
  assert.equal(asked.body.consent.source, "told on the phone, 20 Nov");
  assert.equal(asked.body.variables.invoice_number, invoice.invoiceNumber);
  assert.equal(asked.body.variables.amount, "11,800.00");
  assert.equal(asked.body.variables.company, business.name);
  assert.match(asked.body.variables.link, /^https:\/\/rzp\.io\/i\/test\d+$/, "the payment link goes in the message");

  const delivery = await MessageDelivery.findOne({ businessId: business._id, invoiceId: invoice._id });
  assert.equal(delivery.provider, "WHATSAPP_APP");
  assert.equal(delivery.status, "SENT");
  assert.equal(delivery.providerMessageId, asked.body.key);

  assert.equal((await appStatus({ key: asked.body.key, status: "delivered" }, { secret: "wrong-secret-wrong-secret-wrong-secret-x" })).status, 401);
  assert.equal((await appStatus({ key: asked.body.key, status: "delivered" }, { timestamp: String(Date.now() - 10 * 60 * 1000) })).status, 401, "too old");
  assert.equal((await appStatus({ key: asked.body.key, status: "read" })).status, 200);
  assert.equal((await appStatus({ key: asked.body.key, status: "delivered" })).status, 200);
  assert.equal((await MessageDelivery.findById(delivery._id)).status, "READ", "never moves back");

  // A reminder the app does not send (not switched on there): skipped with its reason, not retried.
  const reminder = await call(owner, "POST", `/communications/invoices/${invoice._id}/send`, { channel: "WHATSAPP", category: "PAYMENT_REMINDER" });
  assert.equal(reminder.status, 202, "taken, not sent");
  assert.equal(reminder.json.data.status, "SKIPPED");
  assert.match(reminder.json.data.failureReason, /not switched on/);
  const reminderCall = appCalls.filter((row) => row.body.purpose === "payment_reminder").at(-1);
  assert.equal(reminderCall.body.variables.amount, "11,800.00");
  assert.ok(/^\d+$/.test(reminderCall.body.variables.days_overdue));
});

test("a paid link is recorded once against the invoice, with Razorpay's fee; a settlement moves it to the bank", async () => {
  const { business, owner, invoice } = await setup();
  await call(owner, "PUT", "/online-payments/settings", { enabled: true, keyId: "rzp_test_Abc123XYZ", keySecret: "secret-key-0123456789", webhookSecret: WEBHOOK_SECRET });
  const link = (await call(owner, "POST", `/online-payments/invoices/${invoice._id}/link`)).json.data;
  const row = await OnlinePaymentLink.findById(link.id);
  const paid = {
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: row.providerLinkId, amount: 1180000, amount_paid: 1180000, status: "paid", reference_id: row.referenceId } },
      payment: { entity: { id: "pay_TEST123", amount: 1180000, fee: 2360, tax: 360, method: "upi", status: "captured", created_at: Math.floor(new Date("2026-11-21T10:00:00+05:30").getTime() / 1000) } },
    },
  };
  assert.equal((await razorpayWebhook(business._id, paid, { secret: "not-the-secret" })).status, 400, "signed with the business's webhook secret only");

  const first = await razorpayWebhook(business._id, paid, { eventId: "evt_1" });
  assert.equal(first.status, 200, first.json.message);
  assert.equal(first.json.recorded, true);
  const again = await razorpayWebhook(business._id, paid, { eventId: "evt_1" });
  assert.equal(again.json.duplicate, true);
  const resent = await razorpayWebhook(business._id, paid, { eventId: "evt_1b" });
  assert.equal(resent.status, 200);

  const payments = await Payment.find({ businessId: business._id });
  assert.equal(payments.length, 1, "one payment, however often Razorpay calls");
  assert.equal(payments[0].paymentMethod, "RAZORPAY");
  assert.equal(payments[0].referenceNumber, "pay_TEST123");
  const invoiceNow = await call(owner, "GET", `/invoices/${invoice._id}`);
  assert.equal(Number(invoiceNow.json.data.balanceDue), 0, "the invoice is paid");
  assert.equal((await OnlinePaymentLink.findById(link.id)).status, "PAID");

  let books = await balances(business._id);
  assert.equal(books["1030"], 11776.4, "held by Razorpay: 11,800 less its fee 23.60");
  assert.equal(books["5140"], 23.6, "the fee (with its GST) as a bank charge");

  // Every line of the settlement is a payment BillStack recorded: posted by itself.
  reconItems = [{ entity_id: "pay_TEST123", type: "payment", credit: 1177640, debit: 0, amount: 1180000, fee: 2360, tax: 360, settlement_id: "setl_TEST1" }];
  const settlement = { event: "settlement.processed", payload: { settlement: { entity: { id: "setl_TEST1", amount: 1177640, fees: 2360, tax: 360, utr: "UTR998877", created_at: Math.floor(Date.now() / 1000) } } } };
  assert.equal((await razorpayWebhook(business._id, settlement, { eventId: "evt_2" })).status, 200);
  assert.equal((await razorpayWebhook(business._id, settlement, { eventId: "evt_2b" })).status, 200);
  books = await balances(business._id);
  assert.equal(books["1030"] || 0, 0, "all settled");
  assert.equal(books["1020"], 11776.4);
  const entry = await JournalEntry.findOne({ businessId: business._id, sourceKey: "RAZORPAY_SETTLEMENT:setl_TEST1" });
  assert.match(entry.description, /UTR998877/, "the UTR, so the bank line matches it");
});

test("a link paid while the books are closed for that day waits on the invoice to be recorded again", async () => {
  const { business, owner, invoice } = await setup();
  await call(owner, "PUT", "/online-payments/settings", { enabled: true, keyId: "rzp_test_Abc123XYZ", keySecret: "secret-key-0123456789", webhookSecret: WEBHOOK_SECRET });
  const link = (await call(owner, "POST", `/online-payments/invoices/${invoice._id}/link`)).json.data;
  const row = await OnlinePaymentLink.findById(link.id);
  await Business.updateOne({ _id: business._id }, { $set: { booksLock: { lockedUpTo: "2026-11-30" } } });
  const paid = { event: "payment_link.paid", payload: { payment_link: { entity: { id: row.providerLinkId, amount: 1180000 } }, payment: { entity: { id: "pay_LOCKED1", amount: 1180000, fee: 0, tax: 0, method: "card", created_at: Math.floor(new Date("2026-11-21T10:00:00+05:30").getTime() / 1000) } } } };
  const res = await razorpayWebhook(business._id, paid, { eventId: "evt_locked" });
  assert.equal(res.status, 200, "Razorpay is not asked to retry for ever");
  const waiting = await OnlinePaymentLink.findById(link.id);
  assert.equal(waiting.status, "PAID_NOT_RECORDED");
  assert.ok(waiting.recordError);
  await Business.updateOne({ _id: business._id }, { $unset: { booksLock: 1 } });
  const again = await call(owner, "POST", `/online-payments/invoices/${invoice._id}/link/record`);
  assert.equal(again.status, 200, again.json.message);
  assert.equal(again.json.data.status, "PAID");
  assert.equal((await Payment.countDocuments({ businessId: business._id })), 1);
  assert.ok(await Invoice.findById(invoice._id));
});

const paidLink = async () => {
  const ctx = await setup();
  await call(ctx.owner, "PUT", "/online-payments/settings", { enabled: true, keyId: "rzp_test_Abc123XYZ", keySecret: "secret-key-0123456789", webhookSecret: WEBHOOK_SECRET });
  const link = (await call(ctx.owner, "POST", `/online-payments/invoices/${ctx.invoice._id}/link`)).json.data;
  const row = await OnlinePaymentLink.findById(link.id);
  const payId = `pay_${crypto.randomBytes(5).toString("hex")}`;
  const paid = { event: "payment_link.paid", payload: { payment_link: { entity: { id: row.providerLinkId, amount: 1180000 } }, payment: { entity: { id: payId, amount: 1180000, fee: 2360, tax: 360, method: "upi", created_at: Math.floor(new Date("2026-11-21T10:00:00+05:30").getTime() / 1000) } } } };
  return { ...ctx, link, paid, payId };
};

test("two copies of one paid event at the same moment record one payment and leave the link paid", async () => {
  const { business, link, paid } = await paidLink();
  const results = await Promise.all([razorpayWebhook(business._id, paid, { eventId: "evt_same" }), razorpayWebhook(business._id, paid, { eventId: "evt_same" })]);
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.json)));
  assert.equal(await Payment.countDocuments({ businessId: business._id }), 1);
  assert.equal((await OnlinePaymentLink.findById(link.id)).status, "PAID");
});

test("a settlement with a payment BillStack doesn't know waits for the accountant, then posts", async () => {
  const { business, owner, customer, paid, payId } = await paidLink();
  assert.equal((await razorpayWebhook(business._id, paid)).json.recorded, true);
  // The same settlement also carries a payment made on another Razorpay page.
  reconItems = [
    { entity_id: payId, type: "payment", credit: 1177640, debit: 0, fee: 2360, tax: 360, settlement_id: "setl_MIX1" },
    { entity_id: "pay_OTHERPAGE", type: "payment", credit: 49000, debit: 0, fee: 1000, tax: 0, settlement_id: "setl_MIX1" },
  ];
  const settlement = { event: "settlement.processed", payload: { settlement: { entity: { id: "setl_MIX1", amount: 1226640, utr: "UTRMIX", created_at: Math.floor(Date.now() / 1000) } } } };
  const res = await razorpayWebhook(business._id, settlement);
  assert.equal(res.status, 200, res.json.message);
  assert.equal(res.json.recorded, false);
  let books = await balances(business._id);
  assert.equal(books["1020"] || 0, 0, "nothing moved to the bank yet");
  const list = await call(owner, "GET", "/online-payments/settlements");
  const row = list.json.data.find((s) => s.settlementId === "setl_MIX1");
  assert.equal(row.status, "NEEDS_REVIEW");
  assert.match(row.reason, /pay_OTHERPAGE/);

  // The accountant records the other payment (a receipt by Razorpay), then posts the settlement.
  const other = await call(owner, "POST", "/payments", { direction: "RECEIVED", customerId: customer._id, amount: 490, paymentMethod: "RAZORPAY", paymentDate: "2026-11-22", referenceNumber: "pay_OTHERPAGE", idempotencyKey: `other-${payId}` });
  assert.equal(other.status, 201, other.json.message);
  const staff = await User.create({ businessId: business._id, name: "Staff", email: `staff-${Date.now()}@example.com`, password: "x".repeat(20), role: "staff" });
  assert.equal((await call(staff, "POST", `/online-payments/settlements/${row.id}/decide`, { action: "post" })).status, 403);
  const posted = await call(owner, "POST", `/online-payments/settlements/${row.id}/decide`, { action: "post" });
  assert.equal(posted.status, 200, posted.json.message);
  assert.equal(posted.json.data.status, "POSTED");
  books = await balances(business._id);
  assert.equal(books["1020"], 12266.4);
  assert.equal(books["1030"] || 0, 0, "Razorpay - Settlements Due back to nil");
  assert.equal((await call(owner, "POST", `/online-payments/settlements/${row.id}/decide`, { action: "post" })).status, 409, "once only");
});

test("a full refund in Razorpay waits on the invoice; reversing the payment makes it due again", async () => {
  const { business, owner, invoice, paid, payId } = await paidLink();
  await razorpayWebhook(business._id, paid);
  const refund = { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_FULL1", payment_id: payId, amount: 1180000, created_at: Math.floor(Date.now() / 1000) } } } };
  assert.equal((await razorpayWebhook(business._id, refund)).status, 200);
  assert.equal((await razorpayWebhook(business._id, refund)).status, 200, "a second copy changes nothing");
  const links = await call(owner, "GET", `/online-payments/invoices/${invoice._id}`);
  const paidRow = links.json.data.history.find((row) => row.status === "PAID");
  assert.equal(paidRow.refunds.length, 1);
  assert.equal(paidRow.refunds[0].status, "NOT_RECORDED");
  assert.equal(paidRow.fullRefund, true);

  const done = await call(owner, "POST", `/online-payments/invoices/${invoice._id}/refunds/rfnd_FULL1/record`, { how: "reverse" });
  assert.equal(done.status, 200, done.json.message);
  assert.equal(done.json.data.refunds[0].status, "RECORDED");
  const invoiceNow = await call(owner, "GET", `/invoices/${invoice._id}`);
  assert.equal(Number(invoiceNow.json.data.balanceDue), 11800, "due again");
  const books = await balances(business._id);
  assert.equal(books["1030"], -23.6, "the refund left Razorpay; only the fee Razorpay kept is short");
  assert.equal((await call(owner, "POST", `/online-payments/invoices/${invoice._id}/refunds/rfnd_FULL1/record`, { how: "reverse" })).status, 409);
});
