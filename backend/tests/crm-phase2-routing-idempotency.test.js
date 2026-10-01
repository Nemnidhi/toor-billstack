const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const crmRoot = path.resolve("C:/Users/asus/Desktop/Toor/the-office-on-rent/backend");
const readCrm = (...parts) => fs.readFileSync(path.join(crmRoot, ...parts), "utf8");

const { normalizeBillingContext } = require("../src/services/integration.service");
const { buildBillingContext } = require("C:/Users/asus/Desktop/Toor/the-office-on-rent/backend/src/services/billstackCustomer.service");

// --- 1. Entity Routing & Billing Context normalization in BillStack ---

test("BillStack normalizes valid RESIDENTIAL billingContext with GOLDHAWK entity code", () => {
  const ctx = normalizeBillingContext({
    billingType: "RESIDENTIAL",
    billingEntityCode: "GOLDHAWK",
    sourceRef: {
      source: "THE_OFFICE_ON_RENT_CRM",
      sourceType: "lead",
      sourceId: "675000000000000000000001",
      billingPurpose: "BROKERAGE",
      billingPeriod: "",
    },
    prefill: {
      notes: "Property: Godrej Summit, Tower B, Unit 402",
      reference: "DealRef-999",
      lineItems: [
        { productName: "Brokerage Services - Residential", quantity: 1, rate: 50000, rateReliable: true },
      ],
    },
  });

  assert.equal(ctx.billingType, "RESIDENTIAL");
  assert.equal(ctx.billingEntityCode, "GOLDHAWK");
  assert.equal(ctx.sourceRef.source, "THE_OFFICE_ON_RENT_CRM");
  assert.equal(ctx.sourceRef.sourceType, "lead");
  assert.equal(ctx.sourceRef.sourceId, "675000000000000000000001");
  assert.equal(ctx.sourceRef.billingPurpose, "BROKERAGE");
  assert.equal(ctx.sourceRef.billingPeriod, "");
  assert.equal(ctx.prefill.lineItems.length, 1);
  assert.equal(ctx.prefill.lineItems[0].rate, 50000);
  assert.equal(ctx.prefill.lineItems[0].rateReliable, true);
});

test("BillStack normalizes valid COMMERCIAL billingContext with default TOOR entity", () => {
  const ctx = normalizeBillingContext({
    billingType: "COMMERCIAL",
    billingEntityCode: "",
    sourceRef: {
      source: "THE_OFFICE_ON_RENT_CRM",
      sourceType: "lead",
      sourceId: "675000000000000000000002",
      billingPurpose: "BROKERAGE",
    },
  });

  assert.equal(ctx.billingType, "COMMERCIAL");
  assert.equal(ctx.billingEntityCode, "");
  assert.equal(ctx.sourceRef.source, "THE_OFFICE_ON_RENT_CRM");
});

test("BillStack normalizes COWORKING billingContext with recurring billing period", () => {
  const ctx = normalizeBillingContext({
    billingType: "COWORKING",
    billingEntityCode: "",
    sourceRef: {
      source: "THE_OFFICE_ON_RENT_CRM",
      sourceType: "coworking-contract",
      sourceId: "675000000000000000000003",
      billingPurpose: "RENT",
      billingPeriod: "2026-10",
    },
  });

  assert.equal(ctx.billingType, "COWORKING");
  assert.equal(ctx.billingEntityCode, "");
  assert.equal(ctx.sourceRef.billingPeriod, "2026-10");
});

test("BillStack rejects invalid entity code and billing type combinations", () => {
  // Residential cannot be routed to TOOR ("")
  assert.equal(normalizeBillingContext({ billingType: "RESIDENTIAL", billingEntityCode: "" }), null);
  // Commercial cannot be routed to Goldhawk
  assert.equal(normalizeBillingContext({ billingType: "COMMERCIAL", billingEntityCode: "GOLDHAWK" }), null);
  // Unknown billing type returns null
  assert.equal(normalizeBillingContext({ billingType: "UNKNOWN", billingEntityCode: "" }), null);
  // Non-object returns null
  assert.equal(normalizeBillingContext("invalid"), null);
});

// --- 2. CRM Entity Routing & Context Generation ---

test("CRM routes RESIDENTIAL lead to Goldhawk with brokerage prefill", async () => {
  const lead = {
    _id: "675000000000000000000010",
    name: "Aman Verma",
    phone: "9876543210",
    requirements: { inventoryType: "RESIDENTIAL" },
    brokerageReceived: 75000,
    dealPayment: { paymentReference: "PAY-RES-101" },
  };

  const context = await buildBillingContext("company-123", "lead", lead);
  assert.equal(context.billingType, "RESIDENTIAL");
  assert.equal(context.billingEntityCode, "GOLDHAWK");
  assert.equal(context.sourceRef.source, "THE_OFFICE_ON_RENT_CRM");
  assert.equal(context.sourceRef.sourceType, "lead");
  assert.equal(context.sourceRef.sourceId, "675000000000000000000010");
  assert.equal(context.sourceRef.billingPurpose, "BROKERAGE");
  assert.equal(context.prefill.reference, "PAY-RES-101");
  assert.equal(context.prefill.lineItems[0].rate, 75000);
  assert.equal(context.prefill.lineItems[0].rateReliable, true);
});

test("CRM routes COMMERCIAL lead to The Office On Rent", async () => {
  const lead = {
    _id: "675000000000000000000020",
    name: "Tech Corp",
    phone: "9876543211",
    requirements: { inventoryType: "COMMERCIAL" },
    brokerageReceived: 120000,
  };

  const context = await buildBillingContext("company-123", "lead", lead);
  assert.equal(context.billingType, "COMMERCIAL");
  assert.equal(context.billingEntityCode, "");
  assert.equal(context.sourceRef.sourceType, "lead");
  assert.equal(context.prefill.lineItems[0].productName, "Brokerage Services - Commercial");
  assert.equal(context.prefill.lineItems[0].rate, 120000);
});

test("CRM leaves rate as 0 (unreliable) when brokerage is not confirmed in CRM", async () => {
  const lead = {
    _id: "675000000000000000000030",
    name: "Pending Lead",
    phone: "9876543212",
    requirements: { inventoryType: "COMMERCIAL" },
    brokerageReceived: null, // Not yet confirmed
  };

  const context = await buildBillingContext("company-123", "lead", lead);
  assert.equal(context.prefill.lineItems[0].rate, 0);
  assert.equal(context.prefill.lineItems[0].rateReliable, false);
});

// --- 3. Duplicate Protection & Idempotency Model / Index Assertions ---

test("Invoice model defines crmSourceRef schema with immutable fields", () => {
  const invoiceModelCode = read("src", "models", "Invoice.js");
  assert.match(invoiceModelCode, /crmSourceRef:\s*\{/);
  assert.match(invoiceModelCode, /source:\s*\{\s*type:\s*String/);
  assert.match(invoiceModelCode, /sourceType:\s*\{\s*type:\s*String/);
  assert.match(invoiceModelCode, /sourceId:\s*\{\s*type:\s*String/);
  assert.match(invoiceModelCode, /billingPurpose:\s*\{\s*type:\s*String/);
  assert.match(invoiceModelCode, /billingPeriod:\s*\{\s*type:\s*String/);
});

test("Invoice model enforces unique compound index on crmSourceRef", () => {
  const invoiceModelCode = read("src", "models", "Invoice.js");
  assert.match(invoiceModelCode, /crmSourceRef\.source/);
  assert.match(invoiceModelCode, /crmSourceRef\.sourceType/);
  assert.match(invoiceModelCode, /crmSourceRef\.sourceId/);
  assert.match(invoiceModelCode, /crmSourceRef\.billingPurpose/);
  assert.match(invoiceModelCode, /crmSourceRef\.billingPeriod/);
  assert.match(invoiceModelCode, /unique:\s*true/);
  assert.match(invoiceModelCode, /partialFilterExpression:\s*\{\s*"crmSourceRef\.sourceId":\s*\{\s*\$type:\s*"string"/);
});

test("IntegrationHandoff model defines immutable billingContext schema", () => {
  const handoffModelCode = read("src", "models", "IntegrationHandoff.js");
  assert.match(handoffModelCode, /billingContext:\s*\{/);
  assert.match(handoffModelCode, /billingType:\s*\{\s*type:\s*String,\s*enum:\s*\["RESIDENTIAL",\s*"COMMERCIAL",\s*"COWORKING"\]/);
  assert.match(handoffModelCode, /billingEntityCode:\s*\{\s*type:\s*String,\s*enum:\s*\["",\s*"GOLDHAWK"\]/);
  assert.match(handoffModelCode, /sourceRef:\s*\{/);
  assert.match(handoffModelCode, /prefill:\s*\{/);
});

// --- 4. Server-Side Protection in Controllers ---

test("createInvoice checks existing invoice for identical CRM source and rejects with 409", () => {
  const invoiceCtrl = read("src", "controllers", "invoice.controller.js");
  assert.match(invoiceCtrl, /const existingInvoice = await Invoice\.findOne\(/);
  assert.match(invoiceCtrl, /crmSourceRef\.source/);
  assert.match(invoiceCtrl, /crmSourceRef\.sourceId/);
  assert.match(invoiceCtrl, /already exists for this CRM billable source.*409/);
});

test("createInvoice handles database duplicate key error E11000 safely as 409", () => {
  const invoiceCtrl = read("src", "controllers", "invoice.controller.js");
  assert.match(invoiceCtrl, /error\?\.code === 11000.*crmSourceRef/);
  assert.match(invoiceCtrl, /An invoice has already been issued for this CRM billable source.*409/);
});

test("consumeInvoiceHandoff automatically switches entity to Goldhawk for RESIDENTIAL context", () => {
  const intCtrl = read("src", "controllers", "integration.controller.js");
  assert.match(intCtrl, /handoff\.billingContext\?\.billingEntityCode === "GOLDHAWK"/);
  assert.match(intCtrl, /billingParentId: handoff\.businessId,\s*billingEntityCode: "GOLDHAWK"/);
  assert.match(intCtrl, /resolveEntityUser\(req\.identityUser, targetBusinessId\)/);
  assert.match(intCtrl, /buildAuthPayload/);
});

test("Customer controller allows child billing entity to access parent customers", () => {
  const customerCtrl = read("src", "controllers", "customer.controller.js");
  assert.match(customerCtrl, /currentBusiness\?\.billingParentId/);
  assert.match(customerCtrl, /allowedBusinessIds\.push\(currentBusiness\.billingParentId\)/);
  assert.match(customerCtrl, /businessId:\s*\{\s*\$in:\s*allowedBusinessIds\s*\}/);
});

// --- 5. Frontend Prefill & Duplicate Awareness ---

test("InvoiceHandoffPage stores billingContext and existingInvoice in sessionStorage", () => {
  const handoffPage = read("..", "frontend", "src", "features", "integrations", "InvoiceHandoffPage.jsx");
  assert.match(handoffPage, /sessionStorage\.setItem\("billstack-invoice-billing-context", JSON\.stringify\(context\.billingContext\)\)/);
  assert.match(handoffPage, /sessionStorage\.setItem\("billstack-invoice-existing-invoice", JSON\.stringify\(context\.existingInvoice\)\)/);
});

test("InvoicesPage consumes billingContext, prefills form fields and crmSourceRef", () => {
  const invoicesPage = read("..", "frontend", "src", "features", "dashboard", "pages", "InvoicesPage.jsx");
  assert.match(invoicesPage, /sessionStorage\.getItem\("billstack-invoice-billing-context"\)/);
  assert.match(invoicesPage, /initialForm\.crmSourceRef = billingCtx\.sourceRef/);
  assert.match(invoicesPage, /initialForm\.notes = billingCtx\.prefill\.notes/);
  assert.match(invoicesPage, /initialForm\.lineItems = billingCtx\.prefill\.lineItems\.map/);
  assert.match(invoicesPage, /crmSourceRef: form\.crmSourceRef \|\| undefined/);
});

test("InvoicesPage displays notice when an invoice already exists for the handoff source", () => {
  const invoicesPage = read("..", "frontend", "src", "features", "dashboard", "pages", "InvoicesPage.jsx");
  assert.match(invoicesPage, /billstack-invoice-existing-invoice/);
  assert.match(invoicesPage, /An invoice \(.*\) has already been issued for this CRM record/);
});

// --- 6. CRM Backend Handoff Wire Consistency ---

test("CRM createInvoiceHandoff transmits billingContext to BillStack endpoint", () => {
  const crmService = readCrm("src", "services", "billstack.service.js");
  assert.match(crmService, /createInvoiceHandoff\(companyId, customerId, billingContext = null\)/);
  assert.match(crmService, /if \(billingContext\) payload\.billingContext = billingContext/);
  assert.match(crmService, /post\(companyId, '\/api\/integrations\/handoffs\/invoice', payload\)/);
});

test("CRM billstack.controller builds billingContext on handoff action", () => {
  const crmCtrl = readCrm("src", "controllers", "billstack.controller.js");
  assert.match(crmCtrl, /buildBillingContext\(companyId, type, customer\.entity\)/);
  assert.match(crmCtrl, /createInvoiceHandoff\(companyId, customerId, billingContext\)/);
});
