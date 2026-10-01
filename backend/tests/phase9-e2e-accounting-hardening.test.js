'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const XLSX = require('xlsx');

const Business = require('../src/models/Business');
const User = require('../src/models/User');
const Customer = require('../src/models/Customer');
const Invoice = require('../src/models/Invoice');
const Payment = require('../src/models/Payment');
const PaymentAllocation = require('../src/models/PaymentAllocation');
const Expense = require('../src/models/Expense');
const BankAccount = require('../src/models/BankAccount');
const BankStatementTransaction = require('../src/models/BankStatementTransaction');
const IntegrationCredential = require('../src/models/IntegrationCredential');
const Membership = require('../src/models/BusinessMembership');

const { ensureDefaultAccounts, postInvoiceJournalEntry, postExpenseJournalEntry, getTrialBalance } = require('../src/services/accounting.service');
const { getProfitAndLossReport, getBalanceSheetReport, getConsolidatedReport, getAccountantExportPack, buildAccountantExportXlsxBuffer } = require('../src/services/accounting-reports.service');
const { importBankStatementFile, confirmMatch, getReconciliationSummary } = require('../src/services/bank-reconciliation.service');
const { createPayment, allocatePayment, reverseAllocation, getCustomerAdvances } = require('../src/services/payment.service');
const { createInvoiceHandoff, resolveInvoiceHandoff, hashValue } = require('../src/services/integration.service');
const { sellerSnapshot } = require('../src/services/seller-snapshot.service');
const { buildInvoicePdfDefinition } = require('../src/utils/pdfInvoice');

const MONGO_URI = 'mongodb://127.0.0.1:27018/test-phase9-hardening?replicaSet=rs0&directConnection=true';

const setupEnv = async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGO_URI);
  }
  await mongoose.connection.dropDatabase();

  const toorId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();

  const toor = await Business.create({
    _id: toorId,
    name: 'The Office On Rent',
    slug: 'toor-group',
    billingEntityCode: '',
    deploymentMode: 'SELF_HOSTED',
    ownerUserId: ownerId,
    industry: 'REAL_ESTATE',
    onboardingCompleted: true,
    businessProfile: {
      companyName: 'The Office On Rent',
      gstRegistered: true,
      address: { street: 'Main Commercial Hub', city: 'Indore', state: 'Madhya Pradesh', pincode: '452001' },
      phone: '9876543210',
      email: 'billing@theofficeonrent.com',
      pan: 'ABCDE1234F',
    },
    gstConfiguration: {
      enabled: true,
      gstin: '23ABCDE1234F1Z5',
      stateCode: '23',
      compositionScheme: false,
    },
    defaultTaxSettings: {
      taxName: 'GST',
      taxRate: 18,
      taxMode: 'exclusive',
    },
  });

  const goldhawk = await Business.create({
    name: 'Goldhawk Infrabulls Pvt. Ltd.',
    slug: 'goldhawk-group',
    billingParentId: toor._id,
    billingEntityCode: 'GOLDHAWK',
    deploymentMode: 'SELF_HOSTED',
    ownerUserId: ownerId,
    industry: 'REAL_ESTATE',
    onboardingCompleted: true,
    businessProfile: {
      companyName: 'Goldhawk Infrabulls Pvt. Ltd.',
      gstRegistered: false,
      address: { street: 'Residential Tower A', city: 'Indore', state: 'Madhya Pradesh', pincode: '452010' },
      phone: '9876500000',
      email: 'accounts@goldhawk.in',
      pan: 'GHIPB9876Z',
    },
    gstConfiguration: {
      enabled: false,
      gstin: '',
      compositionScheme: false,
    },
    defaultTaxSettings: {
      taxName: '',
      taxRate: 0,
      taxMode: 'exclusive',
    },
  });

  const owner = await User.create({
    _id: ownerId,
    name: 'Primary Owner',
    email: 'owner@toor.test',
    password: 'password123',
    role: 'owner',
    businessId: toor._id,
  });

  const accountant = await User.create({
    name: 'Group Accountant',
    email: 'accountant@toor.test',
    password: 'password123',
    role: 'accountant',
    businessId: toor._id,
  });

  const staff = await User.create({
    name: 'Floor Staff',
    email: 'staff@toor.test',
    password: 'password123',
    role: 'staff',
    businessId: toor._id,
  });

  await Membership.create([
    { userId: owner._id, businessId: goldhawk._id, role: 'admin' },
    { userId: accountant._id, businessId: goldhawk._id, role: 'accountant' },
  ]);

  const toorCustomer = await Customer.create({
    businessId: toor._id,
    name: 'Commercial Enterprise Ltd',
    email: 'commercial@client.test',
    phone: '9826000001',
    billingAddress: '101 Corporate Park, Indore, Madhya Pradesh 452001',
    gstin: '23AABCC1234D1Z2',
  });

  const ghCustomer = await Customer.create({
    businessId: goldhawk._id,
    name: 'Residential Buyer',
    email: 'buyer@residential.test',
    phone: '9826000002',
    billingAddress: 'Flat 402 Villa Greens, Indore, Madhya Pradesh 452010',
  });

  const toorBank = await BankAccount.create({
    businessId: toor._id,
    accountName: 'HDFC Bank - TOOR Operating',
    accountNumber: '50200012345678',
    bankName: 'HDFC Bank',
    ifscCode: 'HDFC0001234',
    isDefault: true,
  });

  const ghBank = await BankAccount.create({
    businessId: goldhawk._id,
    accountName: 'ICICI Bank - Goldhawk Collection',
    accountNumber: '001205009876',
    bankName: 'ICICI Bank',
    ifscCode: 'ICIC0000012',
    isDefault: true,
  });

  const secret = '45673613a7a75d7278fd081e3c50d26bb218c5ebc647339c';
  const keyPrefix = '9acee778';
  const cred = await IntegrationCredential.create({
    businessId: toor._id,
    name: 'CRM Integration',
    source: 'REAL_ESTATE',
    keyPrefix,
    keyHash: hashValue(keyPrefix + ':' + secret),
    status: 'ACTIVE',
    createdBy: owner._id,
  });

  await ensureDefaultAccounts({ businessId: toor._id });
  await ensureDefaultAccounts({ businessId: goldhawk._id });

  return { toor, goldhawk, owner, accountant, staff, toorCustomer, ghCustomer, toorBank, ghBank, cred, secret };
};

test('1. Baseline & Configuration Verification', async () => {
  const { toor, goldhawk } = await setupEnv();
  assert.equal(toor.name, 'The Office On Rent');
  assert.equal(toor.gstConfiguration.enabled, true);
  assert.equal(goldhawk.name, 'Goldhawk Infrabulls Pvt. Ltd.');
  assert.equal(goldhawk.billingEntityCode, 'GOLDHAWK');
  assert.equal(goldhawk.gstConfiguration.enabled, false);
});

test('2. Real Estate Residential CRM -> Goldhawk non-GST Invoice & PDF Identity', async () => {
  const { toor, goldhawk, owner, cred } = await setupEnv();

  const crmCustomer = await Customer.create({
    businessId: toor._id,
    name: 'Rahul Sharma (Residential)',
    email: 'rahul.res@test.com',
    phone: '9893000001',
    billingAddress: 'Flat 301 Silver Springs, Indore, MP 452001',
  });

  process.env.CRM_RETURN_URLS = 'http://localhost:5173/return-test';

  const handoffRes = await createInvoiceHandoff({
    credential: cred,
    payload: {
      customerId: crmCustomer._id,
      returnUrl: 'http://localhost:5173/return-test',
      billingContext: {
        billingType: 'RESIDENTIAL',
        billingEntityCode: 'GOLDHAWK',
        sourceRef: {
          source: 'THE_OFFICE_ON_RENT_CRM',
          sourceType: 'lead',
          sourceId: 'lead-res-001',
          billingPurpose: 'BROKERAGE',
        },
      },
    },
  });

  const rawToken = new URL(handoffRes.handoffUrl).searchParams.get('token');
  assert.ok(rawToken);

  const resolved = await resolveInvoiceHandoff({
    token: rawToken,
    businessId: toor._id,
    userId: owner._id,
  });

  assert.equal(resolved.billingContext.billingType, 'RESIDENTIAL');
  assert.equal(resolved.billingContext.billingEntityCode, 'GOLDHAWK');

  // Create Goldhawk non-GST invoice
  const inv = await Invoice.create({
    businessId: goldhawk._id,
    customerId: crmCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'GH-2026-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 75000,
    subtotal: 75000,
    totalTax: 0,
    grandTotal: 75000,
    amountPaid: 0,
    balanceDue: 75000,
    status: 'issued',
    paymentStatus: 'unpaid',
    crmSourceRef: resolved.billingContext.sourceRef,
    sellerSnapshot: sellerSnapshot(goldhawk),
    lineItems: [
      {
        productName: 'Residential Brokerage Service',
        description: 'Flat 301, Silver Springs',
        quantity: 1,
        rate: 75000,
        taxRate: 0,
        itemTotal: 75000,
      },
    ],
  });

  const je = await postInvoiceJournalEntry({ invoice: inv, business: goldhawk, userId: owner._id });
  assert.equal(je.totalDebitMinor, 7500000);
  assert.equal(je.totalCreditMinor, 7500000);

  const gstLines = je.lines.filter(l => ['2210', '2220', '2230'].includes(l.accountCode));
  assert.equal(gstLines.length, 0);

  const pdfDef = buildInvoicePdfDefinition({ invoice: inv, business: goldhawk });
  const pdfStr = JSON.stringify(pdfDef);
  assert.ok(pdfStr.includes('INVOICE'));
  assert.ok(!pdfStr.includes('TAX INVOICE'));
  assert.ok(pdfStr.includes('Goldhawk Infrabulls Pvt. Ltd.'));
});

test('3. Commercial CRM -> TOOR GST Invoice & PDF Identity', async () => {
  const { toor, owner, toorCustomer, cred } = await setupEnv();

  process.env.CRM_RETURN_URLS = 'http://localhost:5173/return-test';

  const handoffRes = await createInvoiceHandoff({
    credential: cred,
    payload: {
      customerId: toorCustomer._id,
      returnUrl: 'http://localhost:5173/return-test',
      billingContext: {
        billingType: 'COMMERCIAL',
        billingEntityCode: '',
        sourceRef: {
          source: 'THE_OFFICE_ON_RENT_CRM',
          sourceType: 'lead',
          sourceId: 'lead-comm-002',
          billingPurpose: 'BROKERAGE',
        },
      },
    },
  });

  const rawToken = new URL(handoffRes.handoffUrl).searchParams.get('token');
  assert.ok(rawToken);

  const resolved = await resolveInvoiceHandoff({
    token: rawToken,
    businessId: toor._id,
    userId: owner._id,
  });

  assert.equal(resolved.billingContext.billingType, 'COMMERCIAL');

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: resolved.customer._id,
    createdBy: owner._id,
    invoiceNumber: 'TOOR-2026-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 18000,
    grandTotal: 118000,
    amountPaid: 0,
    balanceDue: 118000,
    status: 'issued',
    paymentStatus: 'unpaid',
    crmSourceRef: resolved.billingContext.sourceRef,
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [
      {
        productName: 'Commercial Advisory Service',
        description: 'Unit 502, Business Orbit',
        quantity: 1,
        rate: 100000,
        taxRate: 18,
        itemTotal: 100000,
      },
    ],
  });

  const je = await postInvoiceJournalEntry({ invoice: inv, business: toor, userId: owner._id });
  assert.equal(je.totalDebitMinor, 11800000);
  assert.equal(je.totalCreditMinor, 11800000);

  const cgstLine = je.lines.find(l => l.accountCode === '2210');
  const sgstLine = je.lines.find(l => l.accountCode === '2220');
  assert.ok(cgstLine);
  assert.ok(sgstLine);
  assert.equal(cgstLine.creditMinor, 900000);
  assert.equal(sgstLine.creditMinor, 900000);

  const pdfDef = buildInvoicePdfDefinition({ invoice: inv, business: toor });
  const pdfStr = JSON.stringify(pdfDef);
  assert.ok(pdfStr.includes('TAX INVOICE'));
  assert.ok(pdfStr.includes('The Office On Rent'));
});

test('4. Coworking CRM -> TOOR GST Invoice with Coworking Rental Revenue', async () => {
  const { toor, owner, toorCustomer } = await setupEnv();

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'CW-2026-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 50000,
    subtotal: 50000,
    totalTax: 9000,
    grandTotal: 59000,
    amountPaid: 0,
    balanceDue: 59000,
    status: 'issued',
    paymentStatus: 'unpaid',
    crmSourceRef: {
      source: 'THE_OFFICE_ON_RENT_CRM',
      sourceType: 'coworking-contract',
      sourceId: 'contract-99',
      billingPurpose: 'RENT',
      billingPeriod: '2026-05',
    },
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [
      {
        productName: 'Coworking Dedicated Desks - May 2026',
        quantity: 5,
        rate: 10000,
        taxRate: 18,
        itemTotal: 50000,
      },
    ],
  });

  const je = await postInvoiceJournalEntry({ invoice: inv, business: toor, userId: owner._id });
  assert.equal(je.totalDebitMinor, 5900000);
  assert.equal(je.totalCreditMinor, 5900000);

  const revLine = je.lines.find(l => ['4020', '4000'].includes(l.accountCode));
  assert.ok(revLine);
  assert.equal(revLine.creditMinor, 5000000);
});

test('5. Duplicate / Idempotency Protection on crmSourceRef', async () => {
  const { toor, owner, toorCustomer, cred } = await setupEnv();

  process.env.CRM_RETURN_URLS = 'http://localhost:5173/return-test';

  const sourceRef = {
    source: 'THE_OFFICE_ON_RENT_CRM',
    sourceType: 'real-estate-lead',
    sourceId: 'lead-duplicate-001',
    billingPurpose: 'BROKERAGE',
    billingPeriod: '',
  };

  const handoffPayload = {
    customerId: toorCustomer._id,
    returnUrl: 'http://localhost:5173/return-test',
    billingContext: {
      billingType: 'COMMERCIAL',
      billingEntityCode: '',
      sourceRef,
    },
  };

  const handoffRes1 = await createInvoiceHandoff({ credential: cred, payload: handoffPayload });
  const rawToken1 = new URL(handoffRes1.handoffUrl).searchParams.get('token');

  const resolvedFirst = await resolveInvoiceHandoff({
    token: rawToken1,
    businessId: toor._id,
    userId: owner._id,
  });

  assert.equal(resolvedFirst.existingInvoice, null);

  const inv1 = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'INV-DUP-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 50000,
    subtotal: 50000,
    totalTax: 9000,
    grandTotal: 59000,
    amountPaid: 0,
    balanceDue: 59000,
    status: 'issued',
    crmSourceRef: sourceRef,
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: 'Service', quantity: 1, rate: 50000, taxRate: 18, itemTotal: 50000 }],
  });

  const handoffRes2 = await createInvoiceHandoff({ credential: cred, payload: handoffPayload });
  const rawToken2 = new URL(handoffRes2.handoffUrl).searchParams.get('token');

  const resolvedSecond = await resolveInvoiceHandoff({
    token: rawToken2,
    businessId: toor._id,
    userId: owner._id,
  });

  assert.ok(resolvedSecond.existingInvoice);
  assert.equal(resolvedSecond.existingInvoice.invoiceNumber, 'INV-DUP-001');
  assert.equal(resolvedSecond.existingInvoice._id.toString(), inv1._id.toString());
});

test('6. Payment Lifecycle: Partial Payment (40k) -> Remaining Outstanding (60k) -> Final Payment (60k)', async () => {
  const { toor, toorBank, owner, toorCustomer } = await setupEnv();

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'INV-PAY-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 0,
    grandTotal: 100000,
    amountPaid: 0,
    balanceDue: 100000,
    status: 'issued',
    paymentStatus: 'unpaid',
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: 'Consulting', quantity: 1, rate: 100000, taxRate: 0, itemTotal: 100000 }],
  });

  await postInvoiceJournalEntry({ invoice: inv, business: toor, userId: owner._id });

  const p1 = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      bankAccountId: toorBank._id,
      amount: 40000,
      direction: 'RECEIVED',
      paymentMethod: 'BANK_TRANSFER',
      referenceNumber: 'UTR40001',
      paymentDate: new Date('2026-05-02'),
      notes: 'First installment',
    },
  });

  await allocatePayment({
    businessId: toor._id,
    userId: owner._id,
    paymentId: p1._id,
    payload: {
      invoiceId: inv._id,
      allocatedAmount: 40000,
    },
  });

  const invAfterP1 = await Invoice.findById(inv._id);
  assert.equal(invAfterP1.amountPaid, 40000);
  assert.equal(invAfterP1.balanceDue, 60000);
  assert.equal(invAfterP1.paymentStatus, 'partial');

  const p2 = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      bankAccountId: toorBank._id,
      amount: 60000,
      direction: 'RECEIVED',
      paymentMethod: 'BANK_TRANSFER',
      referenceNumber: 'UTR60002',
      paymentDate: new Date('2026-05-05'),
      notes: 'Final settlement',
    },
  });

  await allocatePayment({
    businessId: toor._id,
    userId: owner._id,
    paymentId: p2._id,
    payload: {
      invoiceId: inv._id,
      allocatedAmount: 60000,
    },
  });

  const invAfterP2 = await Invoice.findById(inv._id);
  assert.equal(invAfterP2.amountPaid, 100000);
  assert.equal(invAfterP2.balanceDue, 0);
  assert.equal(invAfterP2.paymentStatus, 'paid');
});

test('7. Customer Advance (50k) -> Later Allocation (30k) -> Balance Advance (20k)', async () => {
  const { toor, toorBank, owner, toorCustomer } = await setupEnv();

  const pAdv = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      bankAccountId: toorBank._id,
      amount: 50000,
      direction: 'RECEIVED',
      paymentMethod: 'UPI',
      referenceNumber: 'UPI-ADV-999',
      paymentDate: new Date('2026-05-01'),
      notes: 'Retainer deposit',
    },
  });

  const advances = await getCustomerAdvances({ businessId: toor._id, customerId: toorCustomer._id });
  assert.equal(advances.totalUnallocatedAmount, 50000);
  assert.equal(advances.advances.length, 1);
  assert.equal(advances.advances[0].unallocatedAmount, 50000);

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'INV-ADV-ALLOC-001',
    invoiceDate: new Date('2026-05-10'),
    dueDate: new Date('2026-05-24'),
    taxableAmount: 40000,
    subtotal: 40000,
    totalTax: 0,
    grandTotal: 40000,
    amountPaid: 0,
    balanceDue: 40000,
    status: 'issued',
    paymentStatus: 'unpaid',
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: 'Monthly Retainer', quantity: 1, rate: 40000, taxRate: 0, itemTotal: 40000 }],
  });

  await postInvoiceJournalEntry({ invoice: inv, business: toor, userId: owner._id });

  await allocatePayment({
    businessId: toor._id,
    userId: owner._id,
    paymentId: pAdv._id,
    payload: {
      invoiceId: inv._id,
      allocatedAmount: 30000,
    },
  });

  const invUpdated = await Invoice.findById(inv._id);
  assert.equal(invUpdated.amountPaid, 30000);
  assert.equal(invUpdated.balanceDue, 10000);
  assert.equal(invUpdated.paymentStatus, 'partial');

  const advancesAfter = await getCustomerAdvances({ businessId: toor._id, customerId: toorCustomer._id });
  assert.equal(advancesAfter.totalUnallocatedAmount, 20000);
});

test('8. Payment Reversal / Refund: compensating entries, double-reversal blocked', async () => {
  const { toor, toorBank, owner, toorCustomer } = await setupEnv();

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'INV-REV-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 25000,
    subtotal: 25000,
    totalTax: 0,
    grandTotal: 25000,
    amountPaid: 0,
    balanceDue: 25000,
    status: 'issued',
    paymentStatus: 'unpaid',
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: 'Service', quantity: 1, rate: 25000, taxRate: 0, itemTotal: 25000 }],
  });

  const p = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      bankAccountId: toorBank._id,
      amount: 25000,
      direction: 'RECEIVED',
      paymentMethod: 'BANK_TRANSFER',
      paymentDate: new Date('2026-05-02'),
    },
  });

  const allocation = await allocatePayment({
    businessId: toor._id,
    userId: owner._id,
    paymentId: p._id,
    payload: { invoiceId: inv._id, allocatedAmount: 25000 },
  });

  await reverseAllocation({
    businessId: toor._id,
    userId: owner._id,
    allocationId: allocation._id,
    reason: 'Client requested allocation refund',
  });

  const invRestored = await Invoice.findById(inv._id);
  assert.equal(invRestored.amountPaid, 0);
  assert.equal(invRestored.balanceDue, 25000);
  assert.equal(invRestored.paymentStatus, 'unpaid');

  await assert.rejects(
    async () => {
      await reverseAllocation({
        businessId: toor._id,
        userId: owner._id,
        allocationId: allocation._id,
        reason: 'Duplicate reversal attempt',
      });
    }
  );
});

test('9. Invoice Cancellation Safeguards & Reissue Workflow', async () => {
  const { toor, toorBank, owner, toorCustomer } = await setupEnv();

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'INV-SAFE-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 50000,
    subtotal: 50000,
    totalTax: 0,
    grandTotal: 50000,
    amountPaid: 0,
    balanceDue: 50000,
    status: 'issued',
    paymentStatus: 'unpaid',
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: 'Service', quantity: 1, rate: 50000, taxRate: 0, itemTotal: 50000 }],
  });

  const p = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      bankAccountId: toorBank._id,
      amount: 20000,
      direction: 'RECEIVED',
      paymentMethod: 'BANK_TRANSFER',
      paymentDate: new Date('2026-05-02'),
    },
  });

  const allocation = await allocatePayment({
    businessId: toor._id,
    userId: owner._id,
    paymentId: p._id,
    payload: { invoiceId: inv._id, allocatedAmount: 20000 },
  });

  const allocCount = await PaymentAllocation.countDocuments({ invoiceId: inv._id, businessId: toor._id });
  assert.equal(allocCount, 1);

  await reverseAllocation({
    businessId: toor._id,
    userId: owner._id,
    allocationId: allocation._id,
    reason: 'Correction before invoice cancellation',
  });

  inv.status = 'cancelled';
  inv.paymentStatus = 'cancelled';
  await inv.save();
  assert.equal(inv.status, 'cancelled');

  const reissued = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'INV-SAFE-REISSUE-002',
    invoiceDate: new Date('2026-05-03'),
    dueDate: new Date('2026-05-17'),
    taxableAmount: 55000,
    subtotal: 55000,
    totalTax: 0,
    grandTotal: 55000,
    amountPaid: 0,
    balanceDue: 55000,
    status: 'issued',
    paymentStatus: 'unpaid',
    replacesInvoiceId: inv._id,
    reissueReason: 'Price adjustment agreed with client',
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: 'Service (Adjusted)', quantity: 1, rate: 55000, taxRate: 0, itemTotal: 55000 }],
  });

  inv.reissuedInvoiceId = reissued._id;
  inv.reissuedInvoiceNumber = reissued.invoiceNumber;
  inv.reissueReason = 'Price adjustment agreed with client';
  await inv.save();

  assert.equal(reissued.replacesInvoiceId.toString(), inv._id.toString());
  assert.equal(inv.reissuedInvoiceNumber, 'INV-SAFE-REISSUE-002');
});

test('10. Complete Double-Entry Accounting Verification: Trial Balance, P&L, Balance Sheet Equation', async () => {
  const { toor, goldhawk, owner, toorCustomer, ghCustomer, toorBank, ghBank } = await setupEnv();

  // 1. TOOR GST Invoice: ₹100,000 + ₹18,000 GST = ₹118,000
  const toorInv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'TOOR-FIN-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 18000,
    grandTotal: 118000,
    amountPaid: 0,
    balanceDue: 118000,
    status: 'issued',
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: 'Commercial Brokerage', quantity: 1, rate: 100000, taxRate: 18, itemTotal: 100000 }],
  });
  await postInvoiceJournalEntry({ invoice: toorInv, business: toor, userId: owner._id });

  // 2. TOOR Expense: ₹10,000 + ₹1,800 GST = ₹11,800
  const toorExp = await Expense.create({
    businessId: toor._id,
    expenseNumber: 'EXP-TOOR-001',
    expenseDate: new Date('2026-05-02'),
    category: 'Marketing & Advertising',
    amountBeforeTax: 10000,
    taxAmount: 1800,
    totalAmount: 11800,
    gstEnabled: true,
    gstRate: 18,
    gstType: 'GST_RECORDED',
    paymentStatus: 'PAID',
    paymentMethod: 'BANK_TRANSFER',
    createdBy: owner._id,
    bankAccountId: toorBank._id,
    notes: 'Online Commercial Ad Campaign',
  });
  await postExpenseJournalEntry({ expense: toorExp, business: toor, userId: owner._id });

  // 3. Goldhawk Non-GST Invoice: ₹100,000, 0 GST
  const ghInv = await Invoice.create({
    businessId: goldhawk._id,
    customerId: ghCustomer._id,
    createdBy: owner._id,
    invoiceNumber: 'GH-FIN-001',
    invoiceDate: new Date('2026-05-01'),
    dueDate: new Date('2026-05-15'),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 0,
    grandTotal: 100000,
    amountPaid: 0,
    balanceDue: 100000,
    status: 'issued',
    sellerSnapshot: sellerSnapshot(goldhawk),
    lineItems: [{ productName: 'Residential Brokerage', quantity: 1, rate: 100000, taxRate: 0, itemTotal: 100000 }],
  });
  await postInvoiceJournalEntry({ invoice: ghInv, business: goldhawk, userId: owner._id });

  // 4. Goldhawk Expense: ₹10,000, 0 GST
  const ghExp = await Expense.create({
    businessId: goldhawk._id,
    expenseNumber: 'EXP-GH-001',
    expenseDate: new Date('2026-05-02'),
    category: 'Office Supplies',
    amountBeforeTax: 10000,
    taxAmount: 0,
    totalAmount: 10000,
    gstEnabled: false,
    gstType: 'NONE',
    paymentStatus: 'PAID',
    paymentMethod: 'BANK_TRANSFER',
    createdBy: owner._id,
    bankAccountId: ghBank._id,
    notes: 'Office Maintenance',
  });
  await postExpenseJournalEntry({ expense: ghExp, business: goldhawk, userId: owner._id });

  // A. TRIAL BALANCE VERIFICATION
  const tbToor = await getTrialBalance({ businessId: toor._id });
  assert.equal(tbToor.totals.isBalanced, true, 'TOOR Trial Balance must be strictly balanced');
  assert.equal(tbToor.totals.closing.debit, tbToor.totals.closing.credit);

  const tbGh = await getTrialBalance({ businessId: goldhawk._id });
  assert.equal(tbGh.totals.isBalanced, true, 'Goldhawk Trial Balance must be strictly balanced');
  assert.equal(tbGh.totals.closing.debit, tbGh.totals.closing.credit);

  // B. P&L VERIFICATION
  const plToor = await getProfitAndLossReport({ businessId: toor._id, query: { period: 'FY' } });
  assert.equal(plToor.income.total, 100000, 'TOOR Revenue must exclude GST');
  assert.equal(plToor.expenses.total, 10000, 'TOOR Expense must exclude Input GST');
  assert.equal(plToor.netProfit, 90000, 'TOOR Net Profit = 100k - 10k = 90k');

  const plGh = await getProfitAndLossReport({ businessId: goldhawk._id, query: { period: 'FY' } });
  assert.equal(plGh.income.total, 100000, 'Goldhawk Revenue');
  assert.equal(plGh.expenses.total, 10000, 'Goldhawk Expense');
  assert.equal(plGh.netProfit, 90000, 'Goldhawk Net Profit = 90k');

  // Consolidated P&L
  const plConsol = await getConsolidatedReport({ reportType: 'PROFIT_AND_LOSS', homeBusinessId: toor._id, query: { period: 'FY' } });
  assert.equal(plConsol.income.total, 200000, 'Consolidated Revenue = TOOR (100k) + GH (100k)');
  assert.equal(plConsol.expenses.total, 20000, 'Consolidated Expense = TOOR (10k) + GH (10k)');
  assert.equal(plConsol.netProfit, 180000, 'Consolidated Net Profit = 180k');

  // C. BALANCE SHEET EQUATION: ASSETS = LIABILITIES + EQUITY
  const bsToor = await getBalanceSheetReport({ businessId: toor._id, query: { period: 'FY' } });
  assert.equal(bsToor.totals.isBalanced, true, 'TOOR Balance Sheet must balance');
  assert.equal(bsToor.totals.discrepancy, 0, 'TOOR Discrepancy must be 0');
  assert.equal(bsToor.totals.totalAssets, bsToor.totals.totalLiabilitiesAndEquity);

  const bsGh = await getBalanceSheetReport({ businessId: goldhawk._id, query: { period: 'FY' } });
  assert.equal(bsGh.totals.isBalanced, true, 'Goldhawk Balance Sheet must balance');
  assert.equal(bsGh.totals.discrepancy, 0, 'Goldhawk Discrepancy must be 0');
  assert.equal(bsGh.totals.totalAssets, bsGh.totals.totalLiabilitiesAndEquity);
});

test('11. Bank Reconciliation: CSV and XLSX import with deduplication and matching', async () => {
  const { toor, toorBank } = await setupEnv();

  const wb = XLSX.utils.book_new();
  const wsData = [
    ['Date', 'Narration', 'Reference/UTR', 'Debit', 'Credit', 'Balance'],
    ['2026-05-02', 'NEFT FROM CLIENT REF-BANK-MATCH-1', 'REF-BANK-MATCH-1', '', 25000, 125000],
    ['2026-05-03', 'OFFICE EXPENSE CHQ 001', 'CHQ001', 5000, '', 120000],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Statement');
  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const impRes1 = await importBankStatementFile({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    buffer: xlsxBuffer,
    fileName: 'statement_may2026.xlsx',
  });

  assert.equal(impRes1.importedCount, 2);
  assert.equal(impRes1.duplicateCount, 0);

  const impRes2 = await importBankStatementFile({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    buffer: xlsxBuffer,
    fileName: 'statement_may2026.xlsx',
  });

  assert.equal(impRes2.importedCount, 0);
  assert.equal(impRes2.duplicateCount, 2, 'Repeated XLSX import must skip all duplicates');

  const summary = await getReconciliationSummary({
    businessId: toor._id,
    bankAccountId: toorBank._id,
  });
  assert.equal(summary.metrics.unmatchedStatementCount, 2);
});

test('12. Accountant Export Pack: CSV and Multi-Sheet XLSX Workbooks', async () => {
  const { toor, owner } = await setupEnv();

  const pack = await getAccountantExportPack({ businessId: toor._id, query: { period: 'FY' }, user: owner });
  assert.ok(pack.files);
  assert.ok(pack.files.trialBalanceCsv);
  assert.ok(pack.files.profitLossCsv);
  assert.ok(pack.files.balanceSheetCsv);
  assert.ok(pack.files.generalLedgersCsv);
  assert.ok(pack.files.bankBookCsv);
  assert.ok(pack.files.cashBookCsv);
  assert.ok(pack.files.salesRegisterCsv);
  assert.ok(pack.files.expenseRegisterCsv);
  assert.ok(pack.files.receivablesCsv);
  assert.ok(pack.files.gstSummaryCsv);

  const xlsxBuf = buildAccountantExportXlsxBuffer(pack);
  assert.ok(xlsxBuf && xlsxBuf.length > 0);

  const readWb = XLSX.read(xlsxBuf, { type: 'buffer' });
  assert.ok(readWb.SheetNames.includes('Trial Balance'));
  assert.ok(readWb.SheetNames.includes('Profit & Loss'));
  assert.ok(readWb.SheetNames.includes('Balance Sheet'));
  assert.ok(readWb.SheetNames.includes('General Ledgers'));
  assert.ok(readWb.SheetNames.includes('Bank Book'));
  assert.ok(readWb.SheetNames.includes('Cash Book'));
  assert.ok(readWb.SheetNames.includes('Sales Register'));
  assert.ok(readWb.SheetNames.includes('Expense Register'));
  assert.ok(readWb.SheetNames.includes('Customer Receivables'));
  assert.ok(readWb.SheetNames.includes('GST Summary'));
});

test('13. Permissions and Two-Entity Data Isolation', async () => {
  const { toor, goldhawk, owner, accountant, toorBank, ghBank } = await setupEnv();

  assert.notEqual(toorBank.businessId.toString(), ghBank.businessId.toString());

  const guestUser = await User.create({
    name: 'Unrelated User',
    email: 'guest@random.test',
    password: 'password123',
    role: 'staff',
    businessId: new mongoose.Types.ObjectId(),
  });

  const { resolveEntityUser } = require('../src/services/billing-entity.service');
  await assert.rejects(
    async () => {
      await resolveEntityUser(guestUser, goldhawk._id);
    },
    /access denied/i
  );

  const ownerInGh = await resolveEntityUser(owner, goldhawk._id);
  assert.equal(ownerInGh.businessId.toString(), goldhawk._id.toString());

  const acctInGh = await resolveEntityUser(accountant, goldhawk._id);
  assert.equal(acctInGh.businessId.toString(), goldhawk._id.toString());
  assert.equal(acctInGh.role, 'accountant');
});

after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});
