// Client answers (23 Nov 2026), item 5: a bill photo / PDF read into the expense form. The Claude
// API is replaced by a fake client; nothing here calls Anthropic. The pure checks run anywhere;
// the end-to-end read needs a throw-away database:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_bill_reader_test?replicaSet=rs0&directConnection=true" node --test tests/bill-reader.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const reader = require("../src/services/bill-reader.service");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64)]).toString("base64");
const bill = (extra = {}) => ({
  isBill: true, vendorName: "Sharma Stationers", supplierGstin: "27AAPFU0939F1ZV", billNumber: "SS/451", billDate: "2026-11-05", currency: "INR",
  amountBeforeTax: 1000, cgst: null, sgst: null, igst: 180, cess: null, totalAmount: 1180, gstRate: 18, reverseCharge: false,
  category: "Office Supplies", description: "Printer paper and toner", paidBy: "UPI",
  lineItems: [{ description: "A4 paper", amount: 400 }, { description: "Toner", amount: 600 }], unclear: "", ...extra,
});
const fakeClient = (answer, capture = {}) => () => ({
  beta: { messages: { create: async (request) => { capture.request = request; return { stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 1800, output_tokens: 400 }, content: [{ type: "text", text: JSON.stringify(answer) }] }; } } },
});
const today = new Date("2026-11-23T10:00:00+05:30");

test("an IGST bill from another state: fields, place of supply and no warnings", () => {
  const { fields, warnings } = reader.toExpenseFields(bill(), { businessStateCode: "23", today });
  assert.deepEqual(warnings, []);
  assert.equal(fields.expenseDate, "2026-11-05");
  assert.equal(fields.amountBeforeTax, 1000);
  assert.equal(fields.gstType, "GST_RECORDED");
  assert.equal(fields.gstEnabled, true);
  assert.equal(fields.gstRate, 18);
  assert.equal(fields.placeOfSupplyCode, "27", "IGST: the supplier's state");
  assert.equal(fields.supplierGstin, "27AAPFU0939F1ZV");
  assert.equal(fields.supplierInvoiceNumber, "SS/451");
  assert.equal(fields.paymentMethod, "UPI");
  assert.match(fields.notes, /A4 paper: ₹400; Toner: ₹600/);
});

test("checks on what was read", () => {
  // CGST + SGST, rate not printed: taken from the taxes.
  let out = reader.toExpenseFields(bill({ igst: null, cgst: 90, sgst: 90, gstRate: null, supplierGstin: "23AAACI1195H1ZK" }), { businessStateCode: "23", today });
  assert.equal(out.fields.gstRate, 18, "CGST 90 + SGST 90 on 1,000 is 18%");
  assert.equal(out.fields.placeOfSupplyCode, "", "same state: no place of supply override");
  assert.deepEqual(out.warnings, []);

  out = reader.toExpenseFields(bill({ totalAmount: 1250 }), { businessStateCode: "23", today });
  assert.ok(out.warnings.some((w) => /does not match the bill's total/.test(w)));

  out = reader.toExpenseFields(bill({ amountBeforeTax: null }), { businessStateCode: "23", today });
  assert.equal(out.fields.amountBeforeTax, 1000, "worked out from the total less GST");
  assert.ok(out.warnings.some((w) => /worked out from the total/.test(w)));

  out = reader.toExpenseFields(bill({ supplierGstin: "27XX" }), { businessStateCode: "23", today });
  assert.equal(out.fields.supplierGstin, "");
  assert.ok(out.warnings.some((w) => /not a valid GSTIN/.test(w)));

  out = reader.toExpenseFields(bill({ billDate: null }), { businessStateCode: "23", today });
  assert.equal(out.fields.expenseDate, "2026-11-23");
  assert.ok(out.warnings.some((w) => /No bill date/.test(w)));
  out = reader.toExpenseFields(bill({ billDate: "2027-05-11" }), { businessStateCode: "23", today });
  assert.ok(out.warnings.some((w) => /in the future/.test(w)), "a day-first date read the wrong way round shows up");

  out = reader.toExpenseFields(bill({ igst: 0, totalAmount: 1000, gstRate: null, supplierGstin: null }), { businessStateCode: "23", today });
  assert.equal(out.fields.gstType, "NONE");
  assert.equal(out.fields.gstRate, "");

  out = reader.toExpenseFields(bill({ reverseCharge: true, igst: 0, totalAmount: 1000 }), { businessStateCode: "23", today });
  assert.equal(out.fields.gstType, "REVERSE_CHARGE");
  assert.equal(out.fields.gstEnabled, false);
});

test("not switched on without a key; files are checked before anything is sent", async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(reader.readBill({ businessId: "x", fileBase64: JPEG, fileName: "bill.jpg" }), (e) => e.statusCode === 503 && /not switched on/.test(e.message));
    assert.equal(reader.isConfigured(), false);
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    reader.setClientFactoryForTests(() => { throw new Error("must not be called"); });
    await assert.rejects(reader.readBill({ businessId: "x", fileBase64: JPEG, fileName: "bill.exe" }), /photo \(JPG, PNG, WEBP\) or a PDF/);
    await assert.rejects(reader.readBill({ businessId: "x", fileBase64: Buffer.from("not a pdf").toString("base64"), fileName: "bill.pdf" }), /does not match its type/);
  } finally {
    reader.setClientFactoryForTests(null);
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("end to end with a fake Claude: the request, the saved supplier, refusals and non-bills", { skip: !process.env.TEST_MONGO_URI && "TEST_MONGO_URI not set" }, async () => {
  const mongoose = require("mongoose");
  assert.ok(!/27018\/billstack(\?|$)/.test(process.env.TEST_MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(process.env.TEST_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  try {
    const Business = require("../src/models/Business");
    const Supplier = require("../src/models/Supplier");
    const uid = crypto.randomBytes(5).toString("hex");
    const business = await Business.create({ name: `Bills ${uid}`, slug: `bills-${uid}`, deploymentMode: "SELF_HOSTED", gstConfiguration: { enabled: true, stateCode: "23" } });
    const supplier = await Supplier.create({ businessId: business._id, supplierName: "Sharma Stationers Pvt Ltd", gstNumber: "27AAPFU0939F1ZV" });

    const capture = {};
    reader.setClientFactoryForTests(fakeClient(bill(), capture));
    const out = await reader.readBill({ businessId: business._id, userId: business._id, fileBase64: JPEG, fileName: "IMG_2041.JPG" });
    assert.equal(capture.request.model, "claude-opus-5-5");
    assert.equal(capture.request.output_config.format.type, "json_schema");
    assert.equal(capture.request.fallbacks, "default");
    assert.deepEqual(capture.request.betas, ["server-side-fallback-2026-07-01"]);
    const [file, prompt] = capture.request.messages[0].content;
    assert.equal(file.type, "image");
    assert.equal(file.source.media_type, "image/jpeg");
    assert.equal(prompt.type, "text");
    assert.equal(out.fields.placeOfSupplyCode, "27");
    assert.equal(out.fields.supplierId, String(supplier._id), "matched to the saved supplier by GSTIN");

    const pdf = Buffer.from("%PDF-1.4\n%fake\n").toString("base64");
    await reader.readBill({ businessId: business._id, userId: business._id, fileBase64: pdf, fileName: "bill.pdf" });
    assert.equal(capture.request.messages[0].content[0].type, "document");

    reader.setClientFactoryForTests(fakeClient({ ...bill(), isBill: false }));
    await assert.rejects(reader.readBill({ businessId: business._id, userId: business._id, fileBase64: JPEG, fileName: "cat.jpg" }), (e) => e.statusCode === 422 && /does not look like a bill/.test(e.message));

    reader.setClientFactoryForTests(() => ({ beta: { messages: { create: async () => ({ stop_reason: "refusal", content: [], usage: {} }) } } }));
    await assert.rejects(reader.readBill({ businessId: business._id, userId: business._id, fileBase64: JPEG, fileName: "x.jpg" }), (e) => e.statusCode === 422 && /would not read/.test(e.message));
  } finally {
    reader.setClientFactoryForTests(null);
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
