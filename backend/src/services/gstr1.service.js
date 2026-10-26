const mongoose = require("mongoose");
const Business = require("../models/Business");
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNote");
const AppError = require("../utils/appError");
const policy = require("../../../shared/gst-policy.cjs");
const { resolveItemHsnSac } = require("../utils/pdfInvoice");

/**
 * GSTR-1 for a month, quarter or any date range, built from what was frozen on each invoice when it was issued
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

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, "0");
const fyText = (year) => `FY ${year}-${String(year + 1).slice(2)}`; // year = April's calendar year

const parseDay = (value) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCDate() === Number(match[3]) ? date : null;
};

/**
 * Tax period from either ?month=YYYY-MM or ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive).
 * Works out a readable title: month, quarter, half-year, financial year or custom range.
 */
const parsePeriod = ({ month, from, to } = {}) => {
  let first;
  let last;
  if (month) {
    const match = String(month).match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!match) throw new AppError("Choose a month as YYYY-MM.", 400);
    first = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    last = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0));
  } else {
    first = parseDay(from);
    last = parseDay(to);
    if (!first || !last) throw new AppError("Choose a month, quarter, year or a from/to date range.", 400);
  }
  if (last < first) throw new AppError("The end date is before the start date.", 400);
  if ((last - first) / DAY_MS > 366) throw new AppError("Choose a period of one year or less.", 400);

  const y1 = first.getUTCFullYear(); const m1 = first.getUTCMonth();
  const y2 = last.getUTCFullYear(); const m2 = last.getUTCMonth();
  const wholeMonths = first.getUTCDate() === 1 && new Date(last.getTime() + DAY_MS).getUTCDate() === 1;
  const months = (y2 - y1) * 12 + (m2 - m1) + 1;
  const fy = m1 >= 3 ? y1 : y1 - 1;
  const short = (y, m) => `${MONTHS[m]}-${y}`;
  const span = `${MONTH_NAMES[m1].slice(0, 3)} ${y1} – ${MONTH_NAMES[m2].slice(0, 3)} ${y2}`;

  let type = "custom";
  let title;
  let label;
  if (wholeMonths && months === 1) {
    type = "month"; title = `${MONTH_NAMES[m1]} ${y1}`; label = short(y1, m1);
  } else if (wholeMonths && months === 3 && (m1 - 3 + 12) % 3 === 0) {
    const q = ((m1 - 3 + 12) % 12) / 3 + 1;
    type = "quarter"; title = `Q${q} ${fyText(fy)} (${span})`; label = `Q${q}_${fyText(fy).replace(" ", "")}`;
  } else if (wholeMonths && months === 6 && (m1 === 3 || m1 === 9)) {
    const h = m1 === 3 ? 1 : 2;
    type = "half-year"; title = `H${h} ${fyText(fy)} (${span})`; label = `H${h}_${fyText(fy).replace(" ", "")}`;
  } else if (wholeMonths && months === 12 && m1 === 3) {
    type = "year"; title = `${fyText(fy)} (${span})`; label = fyText(fy).replace(" ", "");
  } else if (wholeMonths) {
    title = span; label = `${short(y1, m1)}_to_${short(y2, m2)}`;
  } else {
    const d = (x) => `${pad2(x.getUTCDate())}-${pad2(x.getUTCMonth() + 1)}-${x.getUTCFullYear()}`;
    title = `${d(first)} to ${d(last)}`; label = `${d(first)}_to_${d(last)}`;
  }
  return {
    type, title, label,
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
    month: type === "month" ? `${y1}-${pad2(m1 + 1)}` : "",
    // Days in India (IST). Date-only invoice dates are stored at UTC midnight.
    start: new Date(first.getTime() - IST_OFFSET_MS),
    end: new Date(last.getTime() + DAY_MS - IST_OFFSET_MS),
  };
};
const parseMonth = (month) => parsePeriod({ month });

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

// Builds a gstSnapshot-like object from an invoice that was issued without one.
const rebuildSnapshot = (inv, gstinForState, supplierState) => {
  const items = inv.lineItems || [];
  if (!items.length) return null;
  const fromGstin = policy.validGstin(gstinForState) ? gstinForState.slice(0, 2) : "";
  const fromCustomer = String(inv.customerId?.stateCode || "").trim() ? policy.normalizeCode(inv.customerId.stateCode) : "";
  const pos = fromGstin || (policy.validState(fromCustomer) ? fromCustomer : "") || supplierState;
  const inter = pos !== supplierState;
  const lines = items.map((item) => {
    const rate = Number(item.taxRate || 0);
    const taxable = round2(item.taxableAmount ?? Number(item.quantity || 0) * Number(item.rate || 0) - Number(item.discount || 0));
    const tax = round2(item.tax ?? (taxable * rate) / 100);
    const half = round2(tax / 2);
    return { taxableValue: taxable, rate, hsnSac: item.hsnSac, gstClassification: item.gstClassification || "TAXABLE", igst: inter ? tax : 0, cgst: inter ? 0 : half, sgst: inter ? 0 : round2(tax - half), utgst: 0 };
  });
  return { placeOfSupplyCode: pos, lines, assumedPos: !fromGstin && !policy.validState(fromCustomer) };
};

const buildGstr1 = async ({ businessId, month, from, to }) => {
  const period = parsePeriod({ month, from, to });
  const business = await Business.findById(businessId).lean();
  if (!business) throw new AppError("Business not found", 404);
  if (!business.gstConfiguration?.enabled) {
    throw new AppError("GST is not turned on for this company. Turn it on and add your GSTIN in Settings → GST & Tax to prepare GSTR-1.", 400);
  }
  const gstin = String(business.gstConfiguration?.gstin || business.gstTaxId || "").toUpperCase();
  const supplierState = policy.normalizeCode(business.gstConfiguration?.stateCode || gstin.slice(0, 2));

  const [invoices, creditNotes] = await Promise.all([
    Invoice.find({ businessId, invoiceDate: { $gte: period.start, $lt: period.end }, status: { $in: ["issued", "cancelled"] } })
      .populate("customerId", "name gstNumber stateCode")
      .sort({ invoiceDate: 1, invoiceNumber: 1 })
      .lean(),
    CreditNote.find({ businessId, status: "ISSUED", createdAt: { $gte: period.start, $lt: period.end } })
      .populate({ path: "invoiceId", populate: { path: "customerId", select: "name gstNumber" } })
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const issues = [];
  const rebuilt = [];
  const inferredSac = [];
  const inferredCodes = [];
  const isToor = business.billingEntityCode === "TOOR" || /office on rent/i.test(business.name || "");
  const sacContext = (inv) => ({ isToorEntity: isToor, billingEntityCode: business.billingEntityCode, billingPurpose: inv.crmSourceRef?.billingPurpose || "" });
  const assumedPos = [];
  const issue = (level, invoiceNumber, message) => issues.push({ level, invoiceNumber, message });

  const b2b = [];
  const register = []; // every issued invoice, one row per tax rate, with the GSTR-1 table it goes to
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
    const number = inv.invoiceNumber;
    const recipientGstin = String(inv.customerDetails?.gstNumber || "").trim().toUpperCase();
    const currentGstin = String(inv.customerId?.gstNumber || "").trim().toUpperCase();
    const name = inv.customerDetails?.name || inv.customerId?.name || "";

    let snap = inv.gstSnapshot;
    if (!snap || !Array.isArray(snap.lines)) {
      // Issued while GST was switched off in settings: the invoice still carries tax per line,
      // so rebuild the split from it instead of dropping the invoice.
      snap = rebuildSnapshot(inv, recipientGstin || currentGstin, supplierState);
      if (!snap) { issue("error", number, "Has no line items with tax; add it manually."); continue; }
      rebuilt.push(number);
      if (snap.assumedPos) assumedPos.push(number);
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
    const nilRow = { taxableValue: 0, exempt: false };
    snap.lines.forEach((line, index) => {
      const taxable = round2(line.taxableValue);
      const rate = Number(line.rate || 0);
      const classification = String(line.gstClassification || "TAXABLE").toUpperCase();
      const bucket = `${interState ? "inter" : "intra"}${registered ? "Registered" : "Unregistered"}`;
      if (classification === "EXEMPT" || rate === 0) {
        if (classification === "EXEMPT") { exemp[bucket].exempt = round2(exemp[bucket].exempt + taxable); nilRow.exempt = true; }
        else exemp[bucket].nil = round2(exemp[bucket].nil + taxable);
        nilRow.taxableValue = round2(nilRow.taxableValue + taxable);
        nilRow.hasLines = true;
        return;
      }

      let hsn = String(line.hsnSac || inv.lineItems?.[index]?.hsnSac || "").trim();
      if (!hsn) {
        // Same SAC the invoice PDF prints for this line.
        hsn = resolveItemHsnSac(inv.lineItems?.[index] || {}, sacContext(inv));
        if (hsn) { inferredSac.push(number); inferredCodes.push(hsn); }
        else issue("error", number, `Line ${index + 1} has no HSN/SAC code.`);
      }
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

    // Register lists every issued invoice: nil-rated / exempt part goes under Table 8.
    if (nilRow.hasLines) {
      register.push({ table: "8", gstin: recipientGstin, name, invoiceNumber: number, invoiceDate: inv.invoiceDate, invoiceValue, pos: posLabel(pos), rate: 0, taxableValue: nilRow.taxableValue, igst: 0, cgst: 0, sgst: 0, nature: nilRow.exempt ? "Exempt" : "Nil rated" });
    }
    for (const { rate, taxableValue, igst, cgst, sgst } of byRate.values()) {
      const tax = { igst, cgst, sgst };
      const table = registered ? "4A" : interState && invoiceValue > B2CL_LIMIT ? "5" : "7";
      register.push({ table, gstin: recipientGstin, name, invoiceNumber: number, invoiceDate: inv.invoiceDate, invoiceValue, pos: posLabel(pos), rate, taxableValue, ...tax });
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

  if (rebuilt.length) {
    issue("warning", "", `${rebuilt.length} invoice${rebuilt.length === 1 ? " was" : "s were"} issued while GST was off in Settings (${rebuilt.join(", ")}). Their tax is taken from the invoice lines; please check them once.`);
  }
  if (assumedPos.length) {
    issue("warning", "", `Client state is not saved for ${assumedPos.join(", ")}, so place of supply is taken as your own state (CGST + SGST). Add the client's state or GSTIN if it is different.`);
  }
  if (!gstin || !policy.validGstin(gstin)) issue("error", "", "Your GSTIN is missing in Settings → GST & Tax.");
  if (!issued.length) issue("info", "", "No invoices were issued in this period.");
  if (!["month", "quarter"].includes(period.type)) {
    issue("info", "", "GSTR-1 is filed monthly or quarterly (QRMP). Use this period for review or reconciliation, and file month- or quarter-wise.");
  }
  if (inferredSac.length) {
    issue("info", "", `SAC was not saved on some lines of ${[...new Set(inferredSac)].join(", ")}; the code printed on the invoice (${[...new Set(inferredCodes)].join(", ")}) is used.`);
  }

  const sortByNumber = (a, b) => naturalCompare(a.invoiceNumber || a.noteNumber, b.invoiceNumber || b.noteNumber);
  return {
    period: { type: period.type, title: period.title, label: period.label, from: period.from, to: period.to, month: period.month },
    gstin,
    businessName: business.name,
    fileName: `${gstin || "GSTIN"}_GSTR1_${period.label}.xlsx`,
    register: register.sort(sortByNumber),
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

module.exports = { buildGstr1, parseMonth, parsePeriod, posLabel, POS_NAMES, B2CL_LIMIT, _test: { naturalCompare } };
