/* eslint-disable no-console */
/**
 * Fill in GST details on invoices that were issued while GST was switched off in Settings,
 * as if GST had been on when they were issued.
 *
 *   node src/scripts/backfill-gst-snapshots.js          # preview only (default)
 *   node src/scripts/backfill-gst-snapshots.js --apply  # write the GST details
 *
 * Only touches issued invoices that have no GST snapshot, in GST-enabled companies (never
 * Goldhawk). Amounts are NOT changed: the tax split is built from each invoice's own lines,
 * and an invoice whose rebuilt tax differs from its saved tax by more than ₹1 is skipped and
 * listed. Empty SAC codes are filled with the code the invoice PDF prints (9985 for offices).
 */
require("../config/load-env")();
const mongoose = require("mongoose");
const Business = require("../models/Business");
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const policy = require("../../../shared/gst-policy.cjs");
const { buildGstSnapshot } = require("../utils/gst");
const { resolveItemHsnSac } = require("../utils/pdfInvoice");

const APPLY = process.argv.includes("--apply");

const placeOfSupply = (gstin, customer, supplierState) => {
  if (policy.validGstin(gstin)) return gstin.slice(0, 2);
  for (const code of [customer?.placeOfSupplyCode, customer?.stateCode]) {
    if (String(code || "").trim() && policy.validState(code)) return policy.normalizeCode(code);
  }
  return supplierState;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(APPLY ? "MODE: APPLY (changes will be written)\n" : "MODE: PREVIEW (no changes; re-run with --apply)\n");

  const businesses = await Business.find({ "gstConfiguration.enabled": true, billingEntityCode: { $ne: "GOLDHAWK" } }).lean();
  let fixed = 0;
  let skipped = 0;
  for (const business of businesses) {
    const invoices = await Invoice.find({ businessId: business._id, status: "issued", $or: [{ gstSnapshot: null }, { gstSnapshot: { $exists: false } }] }).sort({ invoiceDate: 1 }).lean();
    if (!invoices.length) continue;
    console.log(`${business.name} (${business.gstConfiguration?.gstin || "no GSTIN"}): ${invoices.length} invoice(s) without GST details`);
    const supplierState = policy.normalizeCode(business.gstConfiguration?.stateCode || String(business.gstConfiguration?.gstin || "").slice(0, 2));
    const isToor = business.billingEntityCode === "TOOR" || /office on rent/i.test(business.name || "");

    for (const invoice of invoices) {
      const customer = invoice.customerId ? await Customer.findById(invoice.customerId).select("gstNumber stateCode placeOfSupplyCode").lean() : null;
      const gstin = String(invoice.customerDetails?.gstNumber || "").trim().toUpperCase();
      const pos = placeOfSupply(gstin, customer, supplierState);
      const lineItems = (invoice.lineItems || []).map((line) => ({
        ...line,
        hsnSac: String(line.hsnSac || "").trim() || resolveItemHsnSac(line, { isToorEntity: isToor, billingEntityCode: business.billingEntityCode, billingPurpose: invoice.crmSourceRef?.billingPurpose || "" }),
      }));
      let snapshot;
      try {
        snapshot = buildGstSnapshot({ business, counterparty: { gstNumber: gstin }, lineItems, placeOfSupplyCode: pos });
      } catch (error) {
        skipped += 1;
        console.log(`  skip   ${invoice.invoiceNumber}: ${error.message}`);
        continue;
      }
      const savedTax = Number(invoice.totalTax || 0);
      if (Math.abs(snapshot.totalTax - savedTax) > 1) {
        skipped += 1;
        console.log(`  skip   ${invoice.invoiceNumber}: rebuilt tax ₹${snapshot.totalTax} does not match saved tax ₹${savedTax}`);
        continue;
      }
      const split = !snapshot.totalTax ? `no tax (₹${snapshot.taxableValue} at 0% / ₹0 invoice)` : snapshot.igst ? `IGST ${snapshot.igst}` : `CGST ${snapshot.cgst} + SGST ${snapshot.sgst + snapshot.utgst}`;
      console.log(`  fix    ${invoice.invoiceNumber}: place of supply ${pos}-${policy.states[pos] || "?"}, ${split}${pos === supplierState && !policy.validGstin(gstin) && !customer?.stateCode ? " (client state not saved, own state used)" : ""}`);
      fixed += 1;
      if (APPLY) {
        await Invoice.updateOne({ _id: invoice._id, gstSnapshot: invoice.gstSnapshot ?? null }, {
          $set: {
            gstSnapshot: snapshot,
            gstBreakup: { cgst: snapshot.cgst, sgst: snapshot.sgst, utgst: snapshot.utgst, igst: snapshot.igst, taxableValue: snapshot.taxableValue, hsnSacSummary: snapshot.hsnSacSummary },
            lineItems,
          },
        });
      }
    }
  }
  console.log(`\n${APPLY ? "Updated" : "Would update"}: ${fixed}   Skipped: ${skipped}`);
  if (!APPLY && fixed) console.log("Apply with: cd /home/billstack/apps/toor-billstack/backend && node src/scripts/backfill-gst-snapshots.js --apply");
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
