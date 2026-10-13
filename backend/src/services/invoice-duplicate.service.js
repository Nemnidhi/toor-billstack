const mongoose = require("mongoose");
const Invoice = require("../models/Invoice");

/**
 * Possible-duplicate detection for every new invoice (manual or from the CRM).
 *
 * An invoice is a likely repeat when an existing, non-cancelled invoice exists for the
 * SAME customer in the SAME billing month and it either bills one of the same items
 * (case/spacing-insensitive description) or has the same total. Monthly rent billed
 * twice is the case this protects against; different items (e.g. a one-off meeting room
 * charge) in the same month are not flagged.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;

const itemKey = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Billing month as YYYY-MM. Prefers the CRM billing period, otherwise the invoice date in IST. */
const billingMonth = ({ invoiceDate, crmSourceRef } = {}) => {
  const fromCrm = String(crmSourceRef?.billingPeriod || "").match(/^(\d{4})-(\d{2})/);
  if (fromCrm) return `${fromCrm[1]}-${fromCrm[2]}`;
  const date = invoiceDate ? new Date(invoiceDate) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** UTC range covering a YYYY-MM month in IST. */
const monthRange = (month) => {
  const [year, mon] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, mon - 1, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(year, mon, 1) - IST_OFFSET_MS);
  return { start, end };
};

const findPossibleDuplicateInvoices = async ({
  businessId,
  customerId,
  invoiceDate,
  crmSourceRef = null,
  lineItems = [],
  grandTotal = null,
  excludeInvoiceId = null,
  session = null,
}) => {
  if (!businessId || !customerId || !mongoose.Types.ObjectId.isValid(String(customerId))) return [];
  const month = billingMonth({ invoiceDate, crmSourceRef });
  if (!month) return [];
  const { start, end } = monthRange(month);

  const filter = {
    businessId,
    customerId,
    status: { $nin: ["cancelled", "draft"] },
    $or: [
      { invoiceDate: { $gte: start, $lt: end } },
      // CRM invoices remember the period they were billed for, whatever their invoice date.
      { "crmSourceRef.billingPeriod": { $regex: `^${month}` } },
    ],
  };
  if (excludeInvoiceId) filter._id = { $ne: excludeInvoiceId };

  const query = Invoice.find(filter)
    .select("_id invoiceNumber invoiceDate grandTotal status paymentStatus lineItems.productName crmSourceRef.billingPeriod")
    .sort({ invoiceDate: -1, createdAt: -1 })
    .limit(20)
    .lean();
  if (session) query.session(session);
  const candidates = await query;

  const wanted = new Set(lineItems.map((item) => itemKey(item.productName || item.description || item.name)).filter(Boolean));
  const total = grandTotal === null || grandTotal === undefined || grandTotal === "" ? null : Number(grandTotal);

  return candidates
    .map((invoice) => {
      const sharedItems = (invoice.lineItems || [])
        .map((item) => item.productName)
        .filter((name) => wanted.has(itemKey(name)));
      const sameTotal = total !== null && Number.isFinite(total) && total > 0 && Math.abs(Number(invoice.grandTotal || 0) - total) < 1;
      if (!sharedItems.length && !sameTotal) return null;
      return {
        _id: invoice._id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        grandTotal: invoice.grandTotal,
        status: invoice.status,
        paymentStatus: invoice.paymentStatus,
        billingMonth: month,
        reason: sharedItems.length ? `Same item: ${[...new Set(sharedItems)].slice(0, 2).join(", ")}` : "Same total amount",
      };
    })
    .filter(Boolean);
};

module.exports = { findPossibleDuplicateInvoices, billingMonth, itemKey };
