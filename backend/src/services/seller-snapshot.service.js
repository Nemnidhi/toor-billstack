const sellerSnapshot = business => ({
  name: business.name || "", email: business.email || business.billingEmail || "", billingEmail: business.billingEmail || "",
  phone: business.phone || "", address: business.address || "", logoUrl: business.logoUrl || "", signatureUrl: business.signatureUrl || "",
  gstTaxId: business.gstConfiguration?.gstin || business.gstTaxId || "", gstConfiguration: JSON.parse(JSON.stringify(business.gstConfiguration || {})),
  bankDetails: JSON.parse(JSON.stringify(business.bankDetails || {})), invoiceTerms: business.invoiceTerms || "",
  billingEntityCode: business.billingEntityCode || "",
});
const legacySellerSnapshot = (business, invoice) => {
  const snapshot = sellerSnapshot(business);
  const details = invoice.businessDetails?.toObject?.() || invoice.businessDetails || {};
  for (const key of ["name", "email", "phone", "address"]) if (details[key] !== undefined) snapshot[key] = details[key];
  if (details.gstNumber !== undefined) snapshot.gstTaxId = details.gstNumber;
  if (invoice.gstSnapshot?.gstin) snapshot.gstTaxId = invoice.gstSnapshot.gstin;
  return snapshot;
};
// Capture the pre-edit seller for legacy invoices; no financial values or ownership are changed.
const freezeLegacySellers = async (business, session) => {
  const Invoice = require("../models/Invoice");
  const rows = await Invoice.find({ businessId: business._id, sellerSnapshot: null }).select("businessDetails gstSnapshot.gstin").session(session);
  if (rows.length) await Invoice.collection.bulkWrite(rows.map(row => ({ updateOne: {
    filter: { _id: row._id, businessId: business._id, sellerSnapshot: null },
    update: { $set: { sellerSnapshot: legacySellerSnapshot(business, row) } }, timestamps: false,
  } })), { session });
};
module.exports = { sellerSnapshot, legacySellerSnapshot, freezeLegacySellers };
