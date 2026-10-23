const mongoose = require("mongoose");
const Business = require("../models/Business");
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const AppError = require("../utils/appError");
const policy = require("../../../shared/gst-policy.cjs");

/**
 * GSTR-1 for one month, built from what was frozen on each invoice when it was issued
 * (gstSnapshot: place of supply, per-line rate, taxable value, CGST/SGST/IGST, HSN/SAC).
 * The layout mirrors the TallyPrime / GST offline-tool Excel the CA already uses.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;
const B2CL_LIMIT = 100000; // inter-state, unregistered, invoice value above this goes to B2CL
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Place-of-supply names exactly as the GST offline tool lists them.
const POS_NAMES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "25": "Daman & Diu", "26": "Dadra & Nagar Haveli & Daman & Diu", "27": "Maharashtra",
  "28": "Andhra Pradesh(Before Division)", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala",
  "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh",
  "38": "Ladakh", "97": "Other Territory",
};

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const posLabel = (code) => {
  const key = policy.normalizeCode(code);
  return POS_NAMES[key] ? `${key}-${POS_NAMES[key]}` : "";
};

const parseMonth = (month) => {
  const match = String(month || "").match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) throw new AppError("Choose a month as YYYY-MM.", 400);
  const year = Number(match[1]);
  const mon = Number(match[2]);
  return {
    month: `${match[1]}-${match[2]}`,
    label: `${MONTHS[mon - 1]}-${year}`,
    // Calendar month in India (IST). Date-only invoice dates are stored at UTC midnight.
    start: new Date(Date.UTC(year, mon - 1, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(year, mon, 1) - IST_OFFSET_MS),
  };
};

// Natural sort so INV-2026-0009 comes before INV-2026-0010.
const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

const SAC_DESCRIPTIONS = {
  "9985": "Support services",
  "997211": "Rental of residential property",
  "997212": "Rental of non-residential property",
  "997222": "Real estate brokerage services",
  "998599": "Other support services",
  "998311": "Management consulting services",
};
const blankHsnRow = (hsn, rate) => ({ hsn, description: SAC_DESCRIPTIONS[hsn] || "", uqc: "NA", quantity: 0, totalValue: 0, rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
const isServiceCode = (hsn) => /^99/.test(String(hsn || ""));

const buildGstr1 = async ({ businessId, month }) => {
  const period = parseMonth(month);
  const business = await Business.findById(businessId).lean();
  if (!business) throw new AppError("Business not found", 404);
  if (!business.gstConfiguration?.enabled) {
    throw new AppError("GST is not enabled for this billing company, so there is no GSTR-1 to prepare.", 400);
  }
  const gstin = String(business.gstConfiguration?.gstin || business.gstTaxId || "").toUpperCase();
  const supplierState = policy.normalizeCode(business.gstConfiguration?.stateCode || gstin.slice(0, 2));

  const [invoices, creditNotes] = await Promise.all([
    Invoice.find({ businessId, invoiceDate: { $gte: period.start, $lt: period.end }, status: { $in: ["issued", "cancelled"] } })
      .populate("customerId", "name gstNumber")
      .sort({ invoiceDate: 1, invoiceNumber: 1 })
      .lean(),
    CreditNote.find({ businessId, status: "ISSUED", createdAt: { $gte: period.start, $lt: period.end } })
      .populate({ path: "invoiceId", populate: { path: "customerId", select: "name gstNumber" } })
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const issues = [];
  const issue = (level, invoiceNumber, message) => issues.push({ level, invoiceNumber, message });

  const b2b = [];
  const b2cl = [];
  const b2csMap = new Map();
  const exemp = {
    interRegistered: { nil: 0, exempt: 0, nonGst: 0 },
    intraRegistered: { nil: 0, exempt: 0, nonGst: 0 },
    interUnregistered: { nil: 0, exempt: 0, nonGst: 0 },
    intraUnregistered: { nil: 0, exempt: 0, nonGst: 0 },
  };
  const hsnB2B = new Map();
  const addB2cs = (pos, rate, amounts, sign) => {
    const key = `${pos}|${rate}`;
    const row = b2csMap.get(key) || { type: "OE", pos: posLabel(pos), rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };
    ["taxableValue", "igst", "cgst", "sgst"].forEach((k) => { row[k] = round2(row[k] + sign * Number(amounts[k] || 0)); });
    b2csMap.set(key, row);
  };
  const hsnB2C = new Map();
  const totals = { invoices: 0, invoiceValue: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };

  const issued = invoices.filter((inv) => inv.status === "issued");
  const cancelled = invoices.filter((inv) => inv.status === "cancelled");

  for (const inv of issued) {
    const snap = inv.gstSnapshot;
    const number = inv.invoiceNumber;
    const recipientGstin = String(inv.customerDetails?.gstNumber || "").trim().toUpperCase();
    const currentGstin = String(inv.customerId?.gstNumber || "").trim().toUpperCase();
    const name = inv.customerDetails?.name || inv.customerId?.name || "";

    if (!snap || !Array.isArray(snap.lines)) {
      issue("error", number, "Issued without GST details (place of supply / tax split). It is left out of GSTR-1; cancel and re-issue it, or add it manually.");
      continue;
    }
    const pos = policy.normalizeCode(snap.placeOfSupplyCode);
    if (!posLabel(pos)) issue("error", number, "Place of supply is missing or invalid.");

    const registered = Boolean(recipientGstin);
    if (registered && !policy.validGstin(recipientGstin)) issue("error", number, `Client GSTIN ${recipientGstin} looks invalid.`);
    if (!registered && currentGstin) {
      issue("warning", number, `Issued without a GSTIN, but ${name || "the client"} now has GSTIN ${currentGstin}. It is reported as B2C; issue a corrected invoice if it should be B2B.`);
    }

    const interState = pos && supplierState && pos !== supplierState;
    const invoiceValue = round2(inv.grandTotal);
    totals.invoices += 1;
    totals.invoiceValue = round2(totals.invoiceValue + invoiceValue);

    // Group taxable lines by rate; nil/exempt lines go to the exemp table.
    const byRate = new Map();
    snap.lines.forEach((line, index) => {
      const taxable = round2(line.taxableValue);
      const rate = Number(line.rate || 0);
      const classification = String(line.gstClassification || "TAXABLE").toUpperCase();
      const bucket = `${interState ? "inter" : "intra"}${registered ? "Registered" : "Unregistered"}`;
      if (classification === "EXEMPT") { exemp[bucket].exempt = round2(exemp[bucket].exempt + taxable); return; }
      if (rate === 0) { exemp[bucket].nil = round2(exemp[bucket].nil + taxable); return; }

      const hsn = String(line.hsnSac || inv.lineItems?.[index]?.hsnSac || "").trim();
      if (!hsn) issue("error", number, `Line ${index + 1} has no HSN/SAC code.`);
      const row = byRate.get(rate) || { rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };
      row.taxableValue = round2(row.taxableValue + taxable);
      row.igst = round2(row.igst + Number(line.igst || 0));
      row.cgst = round2(row.cgst + Number(line.cgst || 0));
      row.sgst = round2(row.sgst + Number(line.sgst || 0) + Number(line.utgst || 0));
      byRate.set(rate, row);

      const hsnMap = registered ? hsnB2B : hsnB2C;
      const key = `${hsn}|${rate}`;
      const h = hsnMap.get(key) || blankHsnRow(hsn, rate);
      h.taxableValue = round2(h.taxableValue + taxable);
      h.igst = round2(h.igst + Number(line.igst || 0));
      h.cgst = round2(h.cgst + Number(line.cgst || 0));
      h.sgst = round2(h.sgst + Number(line.sgst || 0) + Number(line.utgst || 0));
      h.totalValue = round2(h.taxableValue + h.igst + h.cgst + h.sgst);
      if (!isServiceCode(hsn)) { h.uqc = "OTH"; h.quantity = round2(h.quantity + Number(inv.lineItems?.[index]?.quantity || 0)); }
      hsnMap.set(key, h);

      totals.taxableValue = round2(totals.taxableValue + taxable);
      totals.igst = round2(totals.igst + Number(line.igst || 0));
      totals.cgst = round2(totals.cgst + Number(line.cgst || 0));
      totals.sgst = round2(totals.sgst + Number(line.sgst || 0) + Number(line.utgst || 0));
    });

    for (const { rate, taxableValue, igst, cgst, sgst } of byRate.values()) {
      const tax = { igst, cgst, sgst };
      if (registered) {
        b2b.push({ gstin: recipientGstin, name, invoiceNumber: number, invoiceDate: inv.invoiceDate, invoiceValue, pos: posLabel(pos), reverseCharge: "N", invoiceType: "Regular B2B", rate, taxableValue, ...tax });
      } else if (interState && invoiceValue > B2CL_LIMIT) {
        b2cl.push({ invoiceNumber: number, invoiceDate: inv.invoiceDate, invoiceValue, pos: posLabel(pos), rate, taxableValue, ...tax });
      } else {
        addB2cs(pos, rate, { taxableValue, ...tax }, 1);
      }
    }
  }

  // Credit notes: registered -> CDNR; unregistered B2CL -> CDNUR; unregistered small -> reduces B2CS.
  const cdnr = [];
  const cdnur = [];
  for (const note of creditNotes) {
    const inv = note.invoiceId;
    if (!inv?.gstSnapshot?.lines) { issue("error", note.creditNoteNumber, "Credit note's invoice has no GST details; add it manually."); continue; }
    const pos = policy.normalizeCode(inv.gstSnapshot.placeOfSupplyCode);
    const recipientGstin = String(inv.customerDetails?.gstNumber || "").trim().toUpperCase();
    const interState = pos !== supplierState;
    const byRate = new Map();
    for (const line of note.lineItems || []) {
      const sold = inv.lineItems?.[line.invoiceLineIndex];
      const gstLine = inv.gstSnapshot.lines[line.invoiceLineIndex];
      if (!sold || !gstLine) continue;
      const rate = Number(gstLine.rate || 0);
      // Credit amounts include tax; take back the taxable part in proportion.
      const share = Number(sold.itemTotal || 0) > 0 ? Number(line.amount || 0) / Number(sold.itemTotal) : 0;
      const row = byRate.get(rate) || { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 };
      row.taxableValue = round2(row.taxableValue + Number(gstLine.taxableValue || 0) * share);
      row.igst = round2(row.igst + Number(gstLine.igst || 0) * share);
      row.cgst = round2(row.cgst + Number(gstLine.cgst || 0) * share);
      row.sgst = round2(row.sgst + (Number(gstLine.sgst || 0) + Number(gstLine.utgst || 0)) * share);
      byRate.set(rate, row);
    }
    for (const [rate, amounts] of byRate) {
      const common = { noteNumber: note.creditNoteNumber, noteDate: note.createdAt, noteType: "C", pos: posLabel(pos), noteValue: round2(note.totalAmount), rate, ...amounts };
      if (recipientGstin) {
        cdnr.push({ gstin: recipientGstin, name: inv.customerDetails?.name || inv.customerId?.name || "", invoiceNumber: inv.invoiceNumber, reverseCharge: "N", noteSupplyType: "Regular B2B", ...common });
      } else if (interState && Number(inv.grandTotal) > B2CL_LIMIT) {
        cdnur.push({ urType: "B2CL", invoiceNumber: inv.invoiceNumber, ...common });
      } else {
        addB2cs(pos, rate, amounts, -1);
      }
    }
  }

  // Documents issued (table 13): every number used this month, including cancelled ones.
  const docs = [];
  const numbers = invoices.map((inv) => inv.invoiceNumber).filter(Boolean).sort(naturalCompare);
  if (numbers.length) docs.push({ nature: "Invoices for outward supply", from: numbers[0], to: numbers[numbers.length - 1], total: numbers.length, cancelled: cancelled.length });
  const noteNumbers = creditNotes.map((note) => note.creditNoteNumber).sort(naturalCompare);
  if (noteNumbers.length) docs.push({ nature: "Credit Note", from: noteNumbers[0], to: noteNumbers[noteNumbers.length - 1], total: noteNumbers.length, cancelled: 0 });

  if (!gstin || !policy.validGstin(gstin)) issue("error", "", "Your GSTIN is missing in Settings → GST & Tax.");
  if (!issued.length) issue("info", "", "No invoices were issued in this month.");

  const sortByNumber = (a, b) => naturalCompare(a.invoiceNumber || a.noteNumber, b.invoiceNumber || b.noteNumber);
  return {
    period: { month: period.month, label: period.label },
    gstin,
    businessName: business.name,
    fileName: `${gstin || "GSTIN"}_GSTR1_${period.label}.xlsx`,
    b2b: b2b.sort(sortByNumber),
    b2cl: b2cl.sort(sortByNumber),
    b2cs: [...b2csMap.values()].filter((row) => Math.abs(row.taxableValue) > 0.004).sort((a, b) => a.pos.localeCompare(b.pos) || a.rate - b.rate),
    cdnr: cdnr.sort(sortByNumber),
    cdnur: cdnur.sort(sortByNumber),
    exemp,
    hsnB2B: [...hsnB2B.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate),
    hsnB2C: [...hsnB2C.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate),
    docs,
    totals: { ...totals, cancelled: cancelled.length, creditNotes: creditNotes.length, totalTax: round2(totals.igst + totals.cgst + totals.sgst) },
    issues,
  };
};

module.exports = { buildGstr1, parseMonth, posLabel, POS_NAMES, B2CL_LIMIT, _test: { naturalCompare } };
