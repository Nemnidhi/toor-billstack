const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTaxDocument } = require("../src/utils/tax-document");
const { sellerSnapshot, legacySellerSnapshot } = require("../src/services/seller-snapshot.service");
const { resolveEntityUser } = require("../src/services/billing-entity.service");
const Membership = require("../src/models/BusinessMembership");
const { buildInvoicePdfDefinition } = require("../src/utils/pdfInvoice");
const gst = { enabled: true, gstin: "23CGZPB7175E1Z5", stateCode: "23" };
const lineItems = [{ productName: "Brokerage", quantity: 1, rate: 10000, taxRate: 18 }];
test("TOOR keeps GST while Goldhawk ignores positive submitted tax and stale enabled settings", () => {
  const business = { gstConfiguration: gst, defaultTaxSettings: { taxMode: "exclusive" } };
  const input = { business, counterparty: { stateCode: "23" }, lineItems };
  assert.equal(buildTaxDocument(input).totals.totalTax, 1800);
  const result = buildTaxDocument({ ...input, business: { ...business, billingEntityCode: "GOLDHAWK" } });
  assert.equal(result.totals.totalTax, 0); assert.equal(result.totals.grandTotal, 10000); assert.equal(result.gstSnapshot, null);
  assert.equal(lineItems[0].taxRate, 18);
});
test("seller snapshot is independent of mutable company bank and GST fields", () => {
  const business = { name: "Original seller", bankDetails: { bankName: "Original bank" }, gstConfiguration: { ...gst } };
  const snapshot = sellerSnapshot(business);
  business.name = "Changed seller"; business.bankDetails.bankName = "Changed bank";
  assert.equal(snapshot.name, "Original seller"); assert.equal(snapshot.bankDetails.bankName, "Original bank");
  const invoice = { sellerSnapshot: snapshot, lineItems: [], grandTotal: 100, businessDetails: { name: "New name" } };
  const pdf = JSON.stringify(buildInvoicePdfDefinition({ invoice, business }));
  assert.ok(pdf.includes("Original seller")); assert.ok(!pdf.includes("Changed seller"));
});
test("legacy freeze preserves existing seller identity rather than substituting current profile", () => {
  const snapshot = legacySellerSnapshot({ name: "Current", logoUrl: "/uploads/logos/retained.png" }, { businessDetails: { name: "Historical", address: "Historical address" } });
  assert.equal(snapshot.name, "Historical"); assert.equal(snapshot.address, "Historical address"); assert.equal(snapshot.logoUrl, "/uploads/logos/retained.png");
});
test("home roles survive; cross-entity roles require an explicit membership and do not inherit HR access", async () => {
  const identity = { _id: "aaaaaaaaaaaaaaaaaaaaaaaa", businessId: "bbbbbbbbbbbbbbbbbbbbbbbb", role: "owner", permissions: { canManageHR: true } };
  assert.equal(await resolveEntityUser(identity), identity);
  await assert.rejects(resolveEntityUser(identity, "invalid"), /Invalid billing entity/);
  const original = Membership.findOne;
  try {
    Membership.findOne = async () => null;
    await assert.rejects(resolveEntityUser(identity, "cccccccccccccccccccccccc"), /access denied/);
    Membership.findOne = async () => ({ businessId: "cccccccccccccccccccccccc", role: "accountant" });
    const scoped = await resolveEntityUser(identity, "cccccccccccccccccccccccc");
    assert.equal(scoped.role, "accountant"); assert.equal(scoped.permissions.canManageHR, false);
    assert.equal(identity.role, "owner"); assert.equal(identity.businessId, "bbbbbbbbbbbbbbbbbbbbbbbb");
  } finally { Membership.findOne = original; }
});

test("seller captures GSTIN stored in GST configuration and prefers legacy invoice tax evidence", () => {
  assert.equal(sellerSnapshot({ gstConfiguration: gst }).gstTaxId, gst.gstin);
  assert.equal(legacySellerSnapshot({ gstTaxId: "current" }, { businessDetails: { gstNumber: "" }, gstSnapshot: { gstin: "historical" } }).gstTaxId, "historical");
});
