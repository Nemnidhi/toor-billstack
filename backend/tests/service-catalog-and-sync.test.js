const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractCanonicalServiceName,
} = require("../src/services/service-catalog.service");
const {
  normalizeCustomerSyncPayload,
  normalizeBillingContext,
} = require("../src/services/integration.service");
const {
  normalizeLineItems,
} = require("../src/services/quote.service");

const credential = { businessId: "507f1f77bcf86cd799439011", source: "THE_OFFICE_ON_RENT_CRM" };

test("Service Catalog: canonical name extraction cleans titles and detects service types", () => {
  assert.equal(
    extractCanonicalServiceName("Coworking Space Rental (2026-10)"),
    "Coworking Space Rental"
  );
  assert.equal(
    extractCanonicalServiceName("Brokerage Services - Commercial - Deal 123"),
    "Brokerage Services - Commercial"
  );
  assert.equal(
    extractCanonicalServiceName("Brokerage Services - Residential"),
    "Brokerage Services - Residential"
  );
  assert.equal(
    extractCanonicalServiceName("Coworking Booking - CB-1002"),
    "Coworking Booking"
  );
  assert.equal(
    extractCanonicalServiceName("Some Custom Item", "Coworking Space Rental"),
    "Coworking Space Rental"
  );
});

test("Customer Sync Normalization: extracts plain email from angle-bracket formats and preserves company priority", () => {
  const payload = {
    externalId: "crm:client:123",
    name: "NOWFLOATS TECHNOLOGIES LIMITED",
    email: "nowfloats business support <bizsupport@nowfloats.com>",
    phone: "8143283203",
    gstNumber: "36AAECN0044J1ZN",
    stateCode: "36",
    placeOfSupplyCode: "36",
  };

  const normalized = normalizeCustomerSyncPayload(payload, credential);
  assert.equal(normalized.email, "bizsupport@nowfloats.com");
  assert.equal(normalized.name, "NOWFLOATS TECHNOLOGIES LIMITED");
  assert.equal(normalized.phone, "8143283203");
  assert.equal(normalized.gstNumber, "36AAECN0044J1ZN");
});

test("Customer Sync Normalization: mailto prefix is cleanly stripped", () => {
  const payload = {
    externalId: "crm:client:456",
    name: "Acme Corp",
    email: "mailto:support@acme.com",
    phone: "+91 99999 88888",
  };

  const normalized = normalizeCustomerSyncPayload(payload, credential);
  assert.equal(normalized.email, "support@acme.com");
  assert.equal(normalized.phone, "919999988888");
});

test("Customer Sync Normalization: invalid email still throws 400 when unparseable string is passed", () => {
  assert.throws(
    () =>
      normalizeCustomerSyncPayload(
        { externalId: "1", name: "Client", email: "bad-email-no-domain" },
        credential
      ),
    /email/
  );
});

test("Handoff Billing Context: retains serviceName, hsnSac, description, and taxRate", () => {
  const context = {
    billingType: "COWORKING",
    prefill: {
      notes: "Contract CT-101",
      reference: "CT-101",
      lineItems: [
        {
          productName: "Coworking Space Rental (2026-10)",
          serviceName: "Coworking Space Rental",
          quantity: 2,
          rate: 15000,
          rateReliable: true,
          hsnSac: "997212",
          description: "Private Cabin C-04",
          taxRate: 18,
        },
      ],
    },
  };

  const normalized = normalizeBillingContext(context);
  assert.equal(normalized.billingType, "COWORKING");
  assert.equal(normalized.prefill.lineItems.length, 1);
  const item = normalized.prefill.lineItems[0];
  assert.equal(item.serviceName, "Coworking Space Rental");
  assert.equal(item.hsnSac, "997212");
  assert.equal(item.rate, 15000);
  assert.equal(item.rateReliable, true);
  assert.equal(item.taxRate, 18);
  assert.equal(item.description, "Private Cabin C-04");
});

test("Quote Line Items: supports custom/manual items with productId null and isManual true", async () => {
  const rawItems = [
    {
      productId: null,
      productName: "Custom Consulting Service",
      hsnSac: "998311",
      quantity: 1,
      rate: 25000,
      taxRate: 18,
      discountType: "percent",
      discountValue: 0,
    },
  ];

  const normalized = await normalizeLineItems({
    businessId: "507f1f77bcf86cd799439011",
    rawItems,
  });

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].productId, null);
  assert.equal(normalized[0].productName, "Custom Consulting Service");
  assert.equal(normalized[0].isManual, true);
  assert.equal(normalized[0].rate, 25000);
  assert.equal(normalized[0].taxRate, 18);
  assert.equal(normalized[0].hsnSac, "998311");
});
