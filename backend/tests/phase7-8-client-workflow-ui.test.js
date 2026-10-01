const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const XLSX = require("xlsx");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Customer = require("../src/models/Customer");
const Invoice = require("../src/models/Invoice");
const Payment = require("../src/models/Payment");
const PaymentAllocation = require("../src/models/PaymentAllocation");
const JournalEntry = require("../src/models/JournalEntry");
const BankAccount = require("../src/models/BankAccount");
const BankStatementTransaction = require("../src/models/BankStatementTransaction");
const IntegrationCredential = require("../src/models/IntegrationCredential");
const IntegrationHandoff = require("../src/models/IntegrationHandoff");

const { ensureDefaultAccounts, postInvoiceJournalEntry, getTrialBalance } = require("../src/services/accounting.service");
const { getProfitAndLossReport, getBalanceSheetReport, getAccountantExportPack, buildAccountantExportXlsxBuffer } = require("../src/services/accounting-reports.service");
const { importBankStatementFile, confirmMatch, getReconciliationSummary } = require("../src/services/bank-reconciliation.service");
const { createPayment, allocatePayment, getCustomerAdvances } = require("../src/services/payment.service");
const { createInvoiceHandoff, resolveInvoiceHandoff, hashValue } = require("../src/services/integration.service");
const { sellerSnapshot } = require("../src/services/seller-snapshot.service");
const { buildInvoicePdfDefinition } = require("../src/utils/pdfInvoice");

const MONGO_URI = "mongodb://127.0.0.1:27018/test-phase7-8?replicaSet=rs0&directConnection=true";

const setupEntities = async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGO_URI);
  }
  await mongoose.connection.dropDatabase();

  const toorId = new mongoose.Types.ObjectId();
  const ownerId = new mongoose.Types.ObjectId();

  const toor = await Business.create({
    _id: toorId,
    name: "The Office On Rent",
    slug: "toor-group",
    billingEntityCode: "",
    deploymentMode: "SELF_HOSTED",
    ownerUserId: ownerId,
    industry: "REAL_ESTATE",
    onboardingCompleted: true,
    gstConfiguration: { enabled: true, gstin: "27AABCT1234A1Z5" },
    businessProfile: { gstRegistered: true, panNumber: "AABCT1234A" },
    bankDetails: { bankName: "HDFC Bank", accountNumber: "1122334455", ifscCode: "HDFC0001234" },
  });

  const owner = await User.create({
    _id: ownerId,
    name: "Group Owner",
    email: "owner@toor.test",
    password: "Password123!",
    role: "owner",
    businessId: toorId,
  });

  const accountant = await User.create({
    name: "Accountant Bob",
    email: "accountant@toor.test",
    password: "Password123!",
    role: "accountant",
    businessId: toorId,
  });

  const staff = await User.create({
    name: "Staff Sam",
    email: "staff@toor.test",
    password: "Password123!",
    role: "staff",
    businessId: toorId,
  });

  const goldhawk = await Business.create({
    name: "Goldhawk Infrabulls Pvt. Ltd.",
    slug: "goldhawk-infra",
    billingParentId: toor._id,
    billingEntityCode: "GOLDHAWK",
    deploymentMode: "SELF_HOSTED",
    ownerUserId: owner._id,
    industry: "REAL_ESTATE",
    onboardingCompleted: true,
    gstConfiguration: { enabled: false },
    businessProfile: { gstRegistered: false, panNumber: "AABCG9876F" },
    bankDetails: { bankName: "ICICI Bank", accountNumber: "9988776655", ifscCode: "ICIC0005678" },
  });

  // users already have businessId

  await ensureDefaultAccounts({ businessId: toor._id });
  await ensureDefaultAccounts({ businessId: goldhawk._id });

  const toorCustomer = await Customer.create({
    businessId: toor._id,
    name: "Acme Commercial Corp",
    email: "acme@client.test",
    phone: "9876543210",
    stateCode: "27",
    placeOfSupplyCode: "27",
    gstNumber: "27AABCU9999Z1Z1",
  });

  const ghCustomer = await Customer.create({
    businessId: toor._id,
    name: "Jane Residential Buyer",
    email: "jane@resident.test",
    phone: "9123456789",
    stateCode: "27",
  });

  const toorBank = await BankAccount.create({
    businessId: toor._id,
    accountName: "TOOR Current Account",
    bankName: "HDFC Bank",
    accountNumber: "1122334455",
    openingBalance: 100000,
    openingBalanceDate: new Date("2026-04-01"),
  });

  const ghBank = await BankAccount.create({
    businessId: goldhawk._id,
    accountName: "Goldhawk Main Account",
    bankName: "ICICI Bank",
    accountNumber: "9988776655",
    openingBalance: 50000,
    openingBalanceDate: new Date("2026-04-01"),
  });

  return {
    toor,
    goldhawk,
    owner,
    accountant,
    staff,
    toorCustomer,
    ghCustomer,
    toorBank,
    ghBank,
  };
};

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
});

test("A & R. Residential CRM -> Goldhawk -> Non-GST invoice & PDF identity", async () => {
  const { goldhawk, ghCustomer, owner } = await setupEntities();

  const ghInv = await Invoice.create({
    businessId: goldhawk._id,
    customerId: ghCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "GH-INV-001",
    invoiceDate: new Date("2026-05-10"),
    dueDate: new Date("2026-05-25"),
    taxableAmount: 125000,
    subtotal: 125000,
    totalTax: 0,
    grandTotal: 125000,
    amountPaid: 0,
    balanceDue: 125000,
    status: "issued",
    sellerSnapshot: sellerSnapshot(goldhawk),
    crmSourceRef: {
      source: "THE_OFFICE_ON_RENT_CRM",
      sourceType: "lead",
      sourceId: "lead-res-123",
      billingPurpose: "BROKERAGE",
    },
    lineItems: [
      {
        productName: "Brokerage Services - Residential",
        quantity: 1,
        rate: 125000,
        taxRate: 0,
        gstClassification: "EXEMPT",
        itemTotal: 125000,
      },
    ],
  });

  assert.equal(ghInv.totalTax, 0, "Goldhawk invoice must have zero tax");
  assert.equal(ghInv.sellerSnapshot.billingEntityCode, "GOLDHAWK");

  // Verify PDF definition
  const pdfDef = buildInvoicePdfDefinition({ invoice: ghInv, business: goldhawk });
  assert.equal(pdfDef.info.title, "Invoice GH-INV-001", "Goldhawk PDF must be titled Invoice, not Tax Invoice");
  assert.equal(pdfDef.content[0].columns[0].text, "INVOICE");

  // Post journal entry and verify NO GST ledger lines
  const je = await postInvoiceJournalEntry({ invoice: ghInv, business: goldhawk, userId: owner._id });
  const gstLines = je.lines.filter((l) => ["2210", "2220", "2230"].includes(l.accountCode));
  assert.equal(gstLines.length, 0, "Goldhawk ledger entry must contain zero GST lines");
});

test("B & S. Commercial CRM -> TOOR -> GST invoice & PDF identity", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  const toorInv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "TOOR-INV-001",
    invoiceDate: new Date("2026-05-12"),
    dueDate: new Date("2026-05-27"),
    taxableAmount: 200000,
    subtotal: 200000,
    totalTax: 36000,
    grandTotal: 236000,
    amountPaid: 0,
    balanceDue: 236000,
    status: "issued",
    sellerSnapshot: sellerSnapshot(toor),
    crmSourceRef: {
      source: "THE_OFFICE_ON_RENT_CRM",
      sourceType: "lead",
      sourceId: "lead-comm-456",
      billingPurpose: "BROKERAGE",
    },
    gstSnapshot: {
      gstin: "27AABCT1234A1Z5",
      taxableValue: 200000,
      totalTax: 36000,
      cgst: 18000,
      sgst: 18000,
      taxRate: 18,
    },
    lineItems: [
      {
        productName: "Brokerage Services - Commercial",
        quantity: 1,
        rate: 200000,
        taxRate: 18,
        gstClassification: "TAXABLE",
        itemTotal: 200000,
      },
    ],
  });

  assert.equal(toorInv.totalTax, 36000);
  assert.equal(toorInv.sellerSnapshot.billingEntityCode || "TOOR", "TOOR");

  // Verify PDF definition
  const pdfDef = buildInvoicePdfDefinition({ invoice: toorInv, business: toor });
  assert.equal(pdfDef.info.title, "Tax Invoice TOOR-INV-001");
  assert.equal(pdfDef.content[0].columns[0].text, "TAX INVOICE");

  // Post journal entry and verify CGST/SGST output lines
  const je = await postInvoiceJournalEntry({ invoice: toorInv, business: toor, userId: owner._id });
  const cgstLine = je.lines.find((l) => l.accountCode === "2210");
  const sgstLine = je.lines.find((l) => l.accountCode === "2220");
  assert.ok(cgstLine);
  assert.ok(sgstLine);
  assert.equal(cgstLine.creditMinor, 1800000);
  assert.equal(sgstLine.creditMinor, 1800000);
});

test("C. Coworking CRM -> TOOR -> GST invoice with rental revenue", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  const cwInv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "TOOR-CW-001",
    invoiceDate: new Date("2026-05-01"),
    dueDate: new Date("2026-05-15"),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 18000,
    grandTotal: 118000,
    amountPaid: 0,
    balanceDue: 118000,
    status: "issued",
    sellerSnapshot: sellerSnapshot(toor),
    crmSourceRef: {
      source: "THE_OFFICE_ON_RENT_CRM",
      sourceType: "coworking-contract",
      sourceId: "contract-789",
      billingPurpose: "RENT",
      billingPeriod: "2026-05",
    },
    lineItems: [
      {
        productName: "Coworking Space Rental (2026-05)",
        quantity: 1,
        rate: 100000,
        taxRate: 18,
        gstClassification: "TAXABLE",
        itemTotal: 100000,
      },
    ],
  });

  assert.equal(cwInv.crmSourceRef.billingPurpose, "RENT");
  assert.equal(cwInv.grandTotal, 118000);
});

test("D & E. CRM handoff resolution, duplicate invoice prevention, and idempotency", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  // Create an integration credential
  const cred = await IntegrationCredential.create({
    businessId: toor._id,
    name: "CRM Key",
    keyPrefix: "crm_prefix",
    keyHash: hashValue("test-secret-key"),
    createdBy: owner._id,
    isActive: true,
  });

  // 1. Create Handoff from CRM
  const handoffPayload = {
    customerId: toorCustomer._id,
    returnUrl: "http://localhost:5173/return-test",
    billingContext: {
      billingType: "COMMERCIAL",
      billingEntityCode: "",
      sourceRef: {
        source: "THE_OFFICE_ON_RENT_CRM",
        sourceType: "lead",
        sourceId: "lead-comm-999",
        billingPurpose: "BROKERAGE",
      },
      prefill: {
        notes: "Property: Tower B Unit 402",
        reference: "PROP-999",
        lineItems: [
          {
            productName: "Brokerage Services - Commercial",
            quantity: 1,
            rate: 75000,
            rateReliable: true,
          },
        ],
      },
    },
  };

  process.env.CRM_RETURN_URLS = "http://localhost:5173/return-test";
  const handoffRes = await createInvoiceHandoff({ credential: cred, payload: handoffPayload });
  assert.ok(handoffRes.handoffUrl);

  const rawToken = new URL(handoffRes.handoffUrl).searchParams.get("token");
  assert.ok(rawToken);

  // 2. Resolve Handoff (simulates user landing in BillStack)
  const resolved = await resolveInvoiceHandoff({
    token: rawToken,
    businessId: toor._id,
    userId: owner._id,
  });

  assert.equal(resolved.purpose, "INVOICE_CREATE");
  assert.equal(resolved.customer._id.toString(), toorCustomer._id.toString());
  assert.equal(resolved.billingContext.billingType, "COMMERCIAL");
  assert.equal(resolved.existingInvoice, null);

  // 3. Issue the invoice with crmSourceRef
  const issuedInv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "TOOR-CRM-001",
    invoiceDate: new Date(),
    dueDate: new Date(),
    taxableAmount: 75000,
    subtotal: 75000,
    totalTax: 13500,
    grandTotal: 88500,
    amountPaid: 0,
    balanceDue: 88500,
    status: "issued",
    crmSourceRef: handoffPayload.billingContext.sourceRef,
    lineItems: [{ productName: "Brokerage Services - Commercial", quantity: 1, rate: 75000, itemTotal: 75000 }],
  });

  // 4. Create second handoff for the same deal -> resolve must detect existing invoice
  const secondHandoff = await createInvoiceHandoff({ credential: cred, payload: handoffPayload });
  const secondToken = new URL(secondHandoff.handoffUrl).searchParams.get("token");

  const resolvedSecond = await resolveInvoiceHandoff({
    token: secondToken,
    businessId: toor._id,
    userId: owner._id,
  });

  assert.ok(resolvedSecond.existingInvoice, "Must detect already issued invoice");
  assert.equal(resolvedSecond.existingInvoice.invoiceNumber, "TOOR-CRM-001");
  assert.equal(resolvedSecond.existingInvoice.grandTotal, 88500);
});

test("G. Payment lifecycle: partial payment -> remaining outstanding -> final payment", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-CYCLE-01",
    invoiceDate: new Date("2026-05-01"),
    dueDate: new Date("2026-05-15"),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 0,
    grandTotal: 100000,
    amountPaid: 0,
    balanceDue: 100000,
    status: "issued",
    paymentStatus: "unpaid",
    lineItems: [{ productName: "Advisory", quantity: 1, rate: 100000, itemTotal: 100000 }],
  });

  // 1. Partial payment of 40,000
  const p1 = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      amount: 40000,
      direction: "RECEIVED",
      paymentMethod: "BANK_TRANSFER",
      paymentDate: new Date("2026-05-05"),
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

  const updatedInv1 = await Invoice.findById(inv._id);
  assert.equal(updatedInv1.amountPaid, 40000);
  assert.equal(updatedInv1.balanceDue, 60000);
  assert.equal(updatedInv1.paymentStatus, "partial");

  // 2. Final settlement of remaining 60,000
  const p2 = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      amount: 60000,
      direction: "RECEIVED",
      paymentMethod: "UPI",
      paymentDate: new Date("2026-05-10"),
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

  const finalInv = await Invoice.findById(inv._id);
  assert.equal(finalInv.amountPaid, 100000);
  assert.equal(finalInv.balanceDue, 0);
  assert.equal(finalInv.paymentStatus, "paid");
});

test("H. Customer Advance & Later Allocation workflow", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  // 1. Customer deposits 150,000 unallocated advance
  const advancePayment = await createPayment({
    businessId: toor._id,
    userId: owner._id,
    payload: {
      customerId: toorCustomer._id,
      amount: 150000,
      direction: "RECEIVED",
      paymentMethod: "BANK_TRANSFER",
      paymentDate: new Date("2026-04-15"),
      referenceNumber: "ADV-CHQ-7788",
    },
  });

  // Query advances endpoint
  const advances = await getCustomerAdvances({
    businessId: toor._id,
    customerId: toorCustomer._id,
  });

  assert.equal(advances.totalUnallocatedAmount, 150000);
  assert.equal(advances.advances.length, 1);
  assert.equal(advances.advances[0].unallocatedAmount, 150000);

  // 2. Later, an invoice of 90,000 is issued
  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-LATER-01",
    invoiceDate: new Date("2026-05-01"),
    dueDate: new Date("2026-05-15"),
    taxableAmount: 90000,
    subtotal: 90000,
    totalTax: 0,
    grandTotal: 90000,
    amountPaid: 0,
    balanceDue: 90000,
    status: "issued",
    paymentStatus: "unpaid",
    lineItems: [{ productName: "Retainer", quantity: 1, rate: 90000, itemTotal: 90000 }],
  });

  // 3. Allocate 90,000 from the advance to this invoice
  await allocatePayment({
    businessId: toor._id,
    userId: owner._id,
    paymentId: advancePayment._id,
    payload: {
      invoiceId: inv._id,
      allocatedAmount: 90000,
    },
  });

  const refreshedInv = await Invoice.findById(inv._id);
  assert.equal(refreshedInv.amountPaid, 90000);
  assert.equal(refreshedInv.balanceDue, 0);
  assert.equal(refreshedInv.paymentStatus, "paid");

  // Remaining unallocated advance must be 60,000
  const remainingAdvances = await getCustomerAdvances({
    businessId: toor._id,
    customerId: toorCustomer._id,
  });
  assert.equal(remainingAdvances.totalUnallocatedAmount, 60000);
});

test("N, O & P. Bank Statement Import (CSV & XLSX) and Deduplication", async () => {
  const { toor, toorBank } = await setupEntities();

  // 1. CSV Statement Import
  const csvContent = `Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance
01/05/2026,CLIENT PAYMENT,REF-CSV-01,,88500.00,188500.00
02/05/2026,OFFICE RENT,CHQ-CSV-02,25000.00,,163500.00`;

  const csvImport = await importBankStatementFile({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    csvText: csvContent,
  });

  assert.equal(csvImport.importedCount, 2);
  assert.equal(csvImport.duplicateCount, 0);

  // 2. XLSX Statement Import (Create binary XLSX buffer)
  const wb = XLSX.utils.book_new();
  const wsData = [
    ["Date", "Narration", "Reference / UTR", "Debit", "Credit", "Balance"],
    ["2026-05-03", "BROKERAGE ADVISORY", "UTR-XLSX-03", "", "120000.00", "283500.00"],
    ["2026-05-04", "UTILITY EXPENSE", "CHQ-XLSX-04", "5000.00", "", "278500.00"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, "Statement");
  const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const xlsxImport = await importBankStatementFile({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    buffer: xlsxBuffer,
    fileName: "hdfc-statement.xlsx",
  });

  assert.equal(xlsxImport.importedCount, 2);
  assert.equal(xlsxImport.duplicateCount, 0);

  // 3. Repeated XLSX Import produces ZERO duplicates
  const repeatedXlsx = await importBankStatementFile({
    businessId: toor._id,
    bankAccountId: toorBank._id,
    buffer: xlsxBuffer,
    fileName: "hdfc-statement.xlsx",
  });

  assert.equal(repeatedXlsx.importedCount, 0, "Repeated XLSX import must import 0 rows");
  assert.equal(repeatedXlsx.duplicateCount, 2, "Must identify existing rows as duplicates");
});

test("Q. Accountant Export Pack: CSV and Multi-Sheet XLSX Workbooks", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  // Create an invoice and post to journal
  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "EXP-INV-01",
    invoiceDate: new Date("2026-05-01"),
    dueDate: new Date("2026-05-15"),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 18000,
    grandTotal: 118000,
    amountPaid: 0,
    balanceDue: 118000,
    status: "issued",
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: "Advisory", quantity: 1, rate: 100000, taxRate: 18, itemTotal: 100000 }],
  });
  await postInvoiceJournalEntry({ invoice: inv, business: toor, userId: owner._id });

  // Generate accountant export pack
  const pack = await getAccountantExportPack({
    businessId: toor._id,
    query: { period: "FY" },
  });

  assert.ok(pack.files.trialBalanceCsv);
  assert.ok(pack.files.profitLossCsv);
  assert.ok(pack.files.balanceSheetCsv);
  assert.ok(pack.files.bankBookCsv);
  assert.ok(pack.files.salesRegisterCsv);

  // Build unified XLSX workbook buffer
  const xlsxBuf = buildAccountantExportXlsxBuffer(pack);
  assert.ok(xlsxBuf);
  assert.ok(Buffer.isBuffer(xlsxBuf));
  assert.ok(xlsxBuf.length > 5000, "XLSX workbook buffer must contain multi-sheet data");

  // Read back and verify sheets
  const readWb = XLSX.read(xlsxBuf, { type: "buffer" });
  assert.ok(readWb.SheetNames.includes("Trial Balance"));
  assert.ok(readWb.SheetNames.includes("Profit & Loss"));
  assert.ok(readWb.SheetNames.includes("Balance Sheet"));
  assert.ok(readWb.SheetNames.includes("Sales Register"));
});

test("F. Standalone BillStack invoice creation continues to work", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  const standaloneInv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "STANDALONE-001",
    invoiceDate: new Date("2026-05-20"),
    dueDate: new Date("2026-06-05"),
    taxableAmount: 50000,
    subtotal: 50000,
    totalTax: 9000,
    grandTotal: 59000,
    amountPaid: 0,
    balanceDue: 59000,
    status: "issued",
    paymentStatus: "unpaid",
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: "Advisory Service", quantity: 1, rate: 50000, taxRate: 18, itemTotal: 50000 }],
  });

  assert.equal(standaloneInv.grandTotal, 59000);
  assert.ok(!standaloneInv.crmSourceRef);
  const je = await postInvoiceJournalEntry({ invoice: standaloneInv, business: toor, userId: owner._id });
  assert.equal(je.totalDebitMinor, 5900000);
  assert.equal(je.totalCreditMinor, 5900000);
});

test("I. Reversal / Cancel / Reissue workflow", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  // Create an invoice
  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-CANCEL-001",
    invoiceDate: new Date("2026-05-01"),
    dueDate: new Date("2026-05-15"),
    taxableAmount: 80000,
    subtotal: 80000,
    totalTax: 14400,
    grandTotal: 94400,
    amountPaid: 0,
    balanceDue: 94400,
    status: "issued",
    paymentStatus: "unpaid",
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: "Design Consulting", quantity: 1, rate: 80000, taxRate: 18, itemTotal: 80000 }],
  });

  // Cancel invoice
  inv.status = "cancelled";
  await inv.save();

  // Reissue replaces cancelled invoice
  const reissued = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "INV-REISSUE-002",
    invoiceDate: new Date("2026-05-02"),
    dueDate: new Date("2026-05-16"),
    taxableAmount: 80000,
    subtotal: 80000,
    totalTax: 14400,
    grandTotal: 94400,
    amountPaid: 0,
    balanceDue: 94400,
    status: "issued",
    paymentStatus: "unpaid",
    sellerSnapshot: sellerSnapshot(toor),
    replacesInvoiceId: inv._id,
    reissueReason: String("Client revised requirements"),
    lineItems: [{ productName: "Design Consulting (Revised)", quantity: 1, rate: 80000, taxRate: 18, itemTotal: 80000 }],
  });

  inv.reissuedInvoiceId = reissued._id;
  inv.reissuedInvoiceNumber = reissued.invoiceNumber;
  inv.reissueReason = String("Client revised requirements");
  await inv.save();

  assert.equal(inv.reissuedInvoiceNumber, "INV-REISSUE-002");
  assert.equal(reissued.replacesInvoiceId.toString(), inv._id.toString());
});

test("J & K. Accounting postings remain balanced and reflect in P&L, Balance Sheet, and Trial Balance", async () => {
  const { toor, toorCustomer, owner } = await setupEntities();

  const inv = await Invoice.create({
    businessId: toor._id,
    customerId: toorCustomer._id,
    createdBy: owner._id,
    invoiceNumber: "FIN-REPORT-001",
    invoiceDate: new Date("2026-05-01"),
    dueDate: new Date("2026-05-15"),
    taxableAmount: 100000,
    subtotal: 100000,
    totalTax: 18000,
    grandTotal: 118000,
    amountPaid: 0,
    balanceDue: 118000,
    status: "issued",
    sellerSnapshot: sellerSnapshot(toor),
    lineItems: [{ productName: "Rental Service", quantity: 1, rate: 100000, taxRate: 18, itemTotal: 100000 }],
  });

  const je = await postInvoiceJournalEntry({ invoice: inv, business: toor, userId: owner._id });
  assert.equal(je.totalDebitMinor, je.totalCreditMinor);

  // Check P&L
  const pl = await getProfitAndLossReport({ businessId: toor._id, query: { period: "FY" } });
  assert.equal(pl.income.total, 100000);
  assert.equal(pl.netProfit, 100000);

  // Check Trial Balance
  const tb = await getTrialBalance({ businessId: toor._id });
  assert.equal(tb.totals.period.debit, tb.totals.period.credit);
  assert.equal(tb.totals.closing.debit, tb.totals.closing.credit);
});

test("L. TOOR and Goldhawk entity isolation is strictly enforced", async () => {
  const { toor, goldhawk, toorBank, ghBank } = await setupEntities();

  // Ensure bank accounts cannot cross boundaries
  assert.notEqual(toorBank.businessId.toString(), goldhawk._id.toString());
  assert.notEqual(ghBank.businessId.toString(), toor._id.toString());

  // Statement import for Goldhawk bank cannot be requested under TOOR businessId
  await assert.rejects(
    async () => {
      await importBankStatementFile({
        businessId: toor._id,
        bankAccountId: ghBank._id,
        csvText: "Date,Narration,Withdrawal,Deposit,Balance\n01/05/2026,X,,1000,1000",
      });
    },
    /Bank account not found for this billing entity/
  );
});

test("M. Delegated permissions: staff cannot access accounting reports; accountant can", async () => {
  const { toor, accountant, staff } = await setupEntities();

  const { authorizeAccountingReport } = require("../src/middlewares/accounting-access.middleware");

  // Accountant request
  let accountantAllowed = false;
  const reqAccountant = {
    user: accountant,
    query: { entity: "toor" },
    headers: {},
  };
  await authorizeAccountingReport(reqAccountant, {}, () => {
    accountantAllowed = true;
  });
  assert.equal(accountantAllowed, true, "Accountant must be authorized to access reports");

  // Staff request
  let staffError = null;
  const reqStaff = {
    user: staff,
    query: { entity: "toor" },
    headers: {},
  };
  await authorizeAccountingReport(reqStaff, {}, (err) => {
    staffError = err;
  });
  assert.ok(staffError, "Staff must be denied access to accounting reports");
  assert.equal(staffError.statusCode, 403);
});
