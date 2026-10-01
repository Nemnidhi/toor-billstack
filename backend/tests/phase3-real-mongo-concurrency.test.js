const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Invoice = require("../src/models/Invoice");
const Payment = require("../src/models/Payment");
const PaymentAllocation = require("../src/models/PaymentAllocation");
const PaymentBalance = require("../src/models/PaymentBalance");
const CustomerLedger = require("../src/models/CustomerLedger");
const { allocatePayment, createPayment, netPaymentAllocations } = require("../src/services/payment.service");

const MONGO_URI = process.env.TEST_MONGO_URI || "mongodb://127.0.0.1:27018/billstack_concurrency_test?replicaSet=rs0&directConnection=true";

test.before(async () => {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const admin = mongoose.connection.db.admin();
  const status = await admin.command({ replSetGetStatus: 1 });
  assert.equal(status.ok, 1, "Replica set must be healthy and active");
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const setupFixtures = async () => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `Test Business ${uid}`,
    slug: `test-biz-${uid}`,
    deploymentMode: "SELF_HOSTED",
    businessProfile: { industryCode: "REAL_ESTATE", playerTypeCode: "BROKER", businessModel: "SERVICE", onboardingStatus: "COMPLETED" },
    gstConfiguration: { enabled: true, gstin: "23CGZPB7175E1Z5", stateCode: "23" },
    bankDetails: { accountName: "Test Seller", bankName: "Test Bank", accountNumber: "12345" },
  });

  const user = await User.create({
    businessId: business._id,
    name: `User ${uid}`,
    email: `user-${uid}@example.com`,
    password: "hashedPassword123",
    role: "owner",
  });

  const customer = await Customer.create({
    businessId: business._id,
    name: `Customer ${uid}`,
    phone: "9876543210",
  });

  return { business, user, customer };
};

const createTestInvoice = async ({ business, customer, user, grandTotal, invoiceNumber }) => {
  return Invoice.create({
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber,
    invoiceDate: new Date(),
    dueDate: new Date(Date.now() + 86400000),
    lineItems: [{
      productName: "Service",
      quantity: 1,
      rate: grandTotal,
      itemTotal: grandTotal,
      taxableAmount: grandTotal,
      tax: 0,
      taxRate: 0,
    }],
    subtotal: grandTotal,
    grandTotal,
    amountPaid: 0,
    balanceDue: grandTotal,
    paymentStatus: "unpaid",
    status: "issued",
    createdBy: user._id,
  });
};

// ---------------------------------------------------------------------------
// TEST 1: The core concurrency gap:
// A single ₹10,000 payment concurrently allocated:
// - ₹7,000 to Invoice A
// - ₹7,000 to Invoice B
//
// Expected:
// exactly one succeeds,
// exactly one fails,
// total committed allocation <= ₹10,000.
// ---------------------------------------------------------------------------
test("REAL MONGO CONCURRENCY: single payment 10,000 contested by Invoice A (7,000) and Invoice B (7,000)", async () => {
  const { business, user, customer } = await setupFixtures();

  const invA = await createTestInvoice({ business, customer, user, grandTotal: 10000, invoiceNumber: `INV-A-${Date.now()}` });
  const invB = await createTestInvoice({ business, customer, user, grandTotal: 10000, invoiceNumber: `INV-B-${Date.now()}` });

  const payment = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: {
      direction: "RECEIVED",
      amount: 10000,
      customerId: customer._id,
      paymentMethod: "BANK_TRANSFER",
      referenceNumber: "PAY-CONCURRENT-1",
    },
  });

  // Concurrently attempt to allocate 7,000 to Invoice A and 7,000 to Invoice B
  const results = await Promise.allSettled([
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: payment._id,
      payload: { invoiceId: invA._id, allocatedAmount: 7000 },
    }),
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: payment._id,
      payload: { invoiceId: invB._id, allocatedAmount: 7000 },
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one allocation must succeed");
  assert.equal(rejected.length, 1, "Exactly one allocation must fail");
  assert.match(rejected[0].reason.message, /exceeds available payment amount/);

  // Verify DB state
  const allocations = await PaymentAllocation.find({ paymentId: payment._id });
  assert.equal(allocations.length, 1, "Exactly one PaymentAllocation document committed in DB");
  assert.equal(allocations[0].allocatedAmount, 7000);

  const netAllocatedMinor = await netPaymentAllocations({ businessId: business._id, paymentId: payment._id });
  assert.equal(netAllocatedMinor, 700000, "Total committed allocation in minor units must be 700,000 (<= 1,000,000)");

  const balance = await PaymentBalance.findOne({ _id: payment._id });
  assert.equal(balance.allocatedMinor, 700000, "PaymentBalance.allocatedMinor must equal 700,000");
  assert.equal(balance.totalMinor, 1000000, "PaymentBalance.totalMinor must equal 1,000,000");

  // Verify invoice state
  const updatedInvA = await Invoice.findById(invA._id);
  const updatedInvB = await Invoice.findById(invB._id);
  const winnerInv = updatedInvA.amountPaid === 7000 ? updatedInvA : updatedInvB;
  const loserInv  = updatedInvA.amountPaid === 0 ? updatedInvA : updatedInvB;

  assert.equal(winnerInv.amountPaid, 7000);
  assert.equal(winnerInv.balanceDue, 3000);
  assert.equal(winnerInv.paymentStatus, "partial");

  assert.equal(loserInv.amountPaid, 0);
  assert.equal(loserInv.balanceDue, 10000);
  assert.equal(loserInv.paymentStatus, "unpaid");
});

// ---------------------------------------------------------------------------
// TEST 2: Valid concurrent allocations where totals remain within limits
// Single payment 10,000 concurrently allocated:
// - 4,000 to Invoice A
// - 5,000 to Invoice B
//
// Expected: both succeed, total committed = 9,000 <= 10,000
// ---------------------------------------------------------------------------
test("REAL MONGO CONCURRENCY: valid concurrent allocations within payment limits both succeed", async () => {
  const { business, user, customer } = await setupFixtures();

  const invA = await createTestInvoice({ business, customer, user, grandTotal: 6000, invoiceNumber: `INV-V1-${Date.now()}` });
  const invB = await createTestInvoice({ business, customer, user, grandTotal: 6000, invoiceNumber: `INV-V2-${Date.now()}` });

  const payment = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: {
      direction: "RECEIVED",
      amount: 10000,
      customerId: customer._id,
      paymentMethod: "UPI",
      referenceNumber: "PAY-CONCURRENT-VALID",
    },
  });

  const results = await Promise.allSettled([
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: payment._id,
      payload: { invoiceId: invA._id, allocatedAmount: 4000 },
    }),
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: payment._id,
      payload: { invoiceId: invB._id, allocatedAmount: 5000 },
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 2, "Both valid allocations must succeed");
  assert.equal(rejected.length, 0, "No allocation should be rejected");

  const netAllocatedMinor = await netPaymentAllocations({ businessId: business._id, paymentId: payment._id });
  assert.equal(netAllocatedMinor, 900000, "Total allocated must be 9,000.00 (900,000 minor)");

  const balance = await PaymentBalance.findOne({ _id: payment._id });
  assert.equal(balance.allocatedMinor, 900000);
});

// ---------------------------------------------------------------------------
// TEST 3: Same invoice concurrent allocation
// Same invoice (balance 5,000), two concurrent requests each trying to allocate
// 4,000 from the same payment (balance 10,000).
//
// Expected: exactly one succeeds (invoice balance serialized), one fails.
// ---------------------------------------------------------------------------
test("REAL MONGO CONCURRENCY: same invoice concurrent allocation serialized by invoice gate", async () => {
  const { business, user, customer } = await setupFixtures();

  const inv = await createTestInvoice({ business, customer, user, grandTotal: 5000, invoiceNumber: `INV-SAME-${Date.now()}` });

  const payment = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: {
      direction: "RECEIVED",
      amount: 10000,
      customerId: customer._id,
      paymentMethod: "CHEQUE",
      referenceNumber: "PAY-SAME-INV",
    },
  });

  const results = await Promise.allSettled([
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: payment._id,
      payload: { invoiceId: inv._id, allocatedAmount: 4000 },
    }),
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: payment._id,
      payload: { invoiceId: inv._id, allocatedAmount: 4000 },
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one allocation must succeed on contested invoice");
  assert.equal(rejected.length, 1, "Exactly one allocation must fail");

  const updatedInv = await Invoice.findById(inv._id);
  assert.equal(updatedInv.amountPaid, 4000);
  assert.equal(updatedInv.balanceDue, 1000);

  const balance = await PaymentBalance.findOne({ _id: payment._id });
  assert.equal(balance.allocatedMinor, 400000, "Payment balance rolled back for rejected request, set to 400,000");
});

// ---------------------------------------------------------------------------
// TEST 4: Different payments to same invoice
// Invoice has balanceDue = 6,000.
// Payment 1 has 5,000, Payment 2 has 5,000.
// Request A: 4,000 from Payment 1 to Invoice.
// Request B: 4,000 from Payment 2 to Invoice.
// Total attempted: 8,000 on 6,000 invoice.
//
// Expected: exactly one succeeds, one fails because invoice balance remaining (2,000) < 4,000.
// ---------------------------------------------------------------------------
test("REAL MONGO CONCURRENCY: different payments to same invoice serialized by invoice balance", async () => {
  const { business, user, customer } = await setupFixtures();

  const inv = await createTestInvoice({ business, customer, user, grandTotal: 6000, invoiceNumber: `INV-DIFF-PAY-${Date.now()}` });

  const pay1 = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: { direction: "RECEIVED", amount: 5000, customerId: customer._id, referenceNumber: "PAY-1" },
  });

  const pay2 = await createPayment({
    businessId: business._id,
    userId: user._id,
    payload: { direction: "RECEIVED", amount: 5000, customerId: customer._id, referenceNumber: "PAY-2" },
  });

  const results = await Promise.allSettled([
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: pay1._id,
      payload: { invoiceId: inv._id, allocatedAmount: 4000 },
    }),
    allocatePayment({
      businessId: business._id,
      userId: user._id,
      paymentId: pay2._id,
      payload: { invoiceId: inv._id, allocatedAmount: 4000 },
    }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected  = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one allocation must succeed when exceeding invoice outstanding");
  assert.equal(rejected.length, 1, "Exactly one allocation must fail");
  assert.match(rejected[0].reason.message, /exceeds invoice outstanding/);

  const updatedInv = await Invoice.findById(inv._id);
  assert.equal(updatedInv.amountPaid, 4000);
  assert.equal(updatedInv.balanceDue, 2000);
});
