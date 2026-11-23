// GST on the buying side, and the monthly returns built from the books:
//  - input-credit register (expense and purchase bills with GST, reverse charge, blocked credit)
//  - GSTR-2B import and match against the bills, with an IMS decision per bill
//  - reverse charge self-invoice and payment voucher (rent from unregistered landlords)
//  - GSTR-3B tables 3.1, 4, and the cash / credit set-off with interest
//  - GSTR-1 JSON for the portal's offline tool
const XLSX = require("xlsx");
const AppError = require("../utils/appError");
const Business = require("../models/Business");
const Expense = require("../models/Expense");
const Purchase = require("../models/Purchase");
const Supplier = require("../models/Supplier");
const Gstr2bImport = require("../models/Gstr2bImport");
const { buildGstr1, parsePeriod } = require("./gstr1.service");
const { parseCsvLines, parseDateString, parseNumericAmount } = require("../utils/csv-parser");

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const idOf = (value) => (value ? String(value._id || value) : "");
const monthOf = (date) => {
  const d = new Date(date);
  // books dates are stored at IST midnight as UTC; shift so the month is the Indian one
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
};
// Bill numbers compared by their letters and digits only, with leading zeros of each number
// dropped: "HK/101", "hk-0101" and "HK 101" are the same bill.
const normalizeNumber = (value) => String(value || "").toUpperCase().split(/[^A-Z0-9]+/).map((part) => part.replace(/(^|[A-Z])0+(?=\d)/g, "$1")).join("");
const DAY = 24 * 60 * 60 * 1000;

const monthPeriod = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) throw new AppError("Month must look like 2026-10", 400);
  return parsePeriod({ month });
};

// ------------------------------------------------------------------ input-credit register

const taxesOf = (snap = {}) => ({
  taxableValue: round2(snap.taxableValue),
  igst: round2(snap.igst),
  cgst: round2(snap.cgst),
  sgst: round2(Number(snap.sgst || 0) + Number(snap.utgst || 0)),
});

// Purchases keep the tax typed on the bill lines; split it as the journal does.
const purchaseTaxes = (purchase) => {
  const breakup = purchase.gstBreakup || {};
  const billTax = round2((purchase.productsPurchased || []).reduce((sum, item) => sum + Number(item.tax || 0), 0));
  const interState = Number(breakup.igst || 0) > 0 && Number(breakup.cgst || 0) + Number(breakup.sgst || 0) === 0;
  const cgst = interState ? 0 : round2(Math.floor((billTax * 100) / 2) / 100);
  return {
    taxableValue: round2(Number(purchase.totalAmount || 0) - billTax),
    igst: interState ? billTax : 0,
    cgst,
    sgst: interState ? 0 : round2(billTax - cgst),
  };
};

const bookBills = async ({ businessId, from, to }) => {
  const dateRange = { $gte: from, $lt: to };
  const [expenses, purchases] = await Promise.all([
    Expense.find({ businessId, status: { $ne: "CANCELLED" }, gstType: { $in: ["GST_RECORDED", "REVERSE_CHARGE"] }, expenseDate: dateRange }).sort({ expenseDate: 1 }).lean(),
    Purchase.find({ businessId, gstSnapshot: { $ne: null }, purchaseDate: dateRange }).sort({ purchaseDate: 1 }).lean(),
  ]);
  const supplierIds = [...expenses.map((e) => e.supplierId), ...purchases.map((p) => p.supplierId)].filter(Boolean);
  const suppliers = new Map((await Supplier.find({ _id: { $in: supplierIds } }).select("supplierName gstNumber").lean()).map((s) => [String(s._id), s]));
  const rows = [];
  for (const e of expenses) {
    const supplier = suppliers.get(idOf(e.supplierId));
    rows.push({
      sourceType: "EXPENSE",
      sourceId: e._id,
      number: e.expenseNumber,
      date: e.expenseDate,
      supplierName: supplier?.supplierName || e.vendorName || "",
      supplierGstin: e.supplierGstin || supplier?.gstNumber || "",
      supplierInvoiceNumber: e.supplierInvoiceNumber || e.referenceNumber || "",
      supplierInvoiceDate: e.supplierInvoiceDate || null,
      reverseCharge: e.gstType === "REVERSE_CHARGE",
      selfInvoiceNumber: e.selfInvoiceNumber || "",
      itcEligible: e.itcEligible !== false,
      balanceAmount: Number(e.balanceAmount || 0),
      category: e.category,
      ...taxesOf(e.gstSnapshot || {}),
    });
  }
  for (const p of purchases) {
    const supplier = suppliers.get(idOf(p.supplierId));
    rows.push({
      sourceType: "PURCHASE",
      sourceId: p._id,
      number: p.purchaseNumber || String(p._id).slice(-6),
      date: p.purchaseDate,
      supplierName: supplier?.supplierName || "",
      supplierGstin: supplier?.gstNumber || "",
      supplierInvoiceNumber: p.supplierInvoiceNumber || "",
      supplierInvoiceDate: p.supplierInvoiceDate || null,
      reverseCharge: false,
      selfInvoiceNumber: "",
      itcEligible: p.gstBreakup?.inputTaxCreditEligible !== false,
      balanceAmount: round2(Number(p.totalAmount || 0) - Number(p.paidAmount || 0)),
      category: "Purchases",
      ...purchaseTaxes(p),
    });
  }
  return rows.sort((a, b) => new Date(a.date) - new Date(b.date));
};

const tax = (row) => round2(row.igst + row.cgst + row.sgst);
const sumRows = (rows) => rows.reduce((t, r) => ({ taxableValue: round2(t.taxableValue + r.taxableValue), igst: round2(t.igst + r.igst), cgst: round2(t.cgst + r.cgst), sgst: round2(t.sgst + r.sgst) }), { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });

const itcRegister = async ({ businessId, month }) => {
  const period = monthPeriod(month);
  const rows = await bookBills({ businessId, from: period.start, to: period.end });
  const match = await match2b({ businessId, month, bills: rows }).catch(() => null);
  const statusById = new Map((match?.books || []).map((row) => [idOf(row.sourceId), row.status]));
  const out = rows.map((row) => ({ ...row, totalTax: tax(row), in2b: row.reverseCharge ? "RCM" : match ? statusById.get(idOf(row.sourceId)) || "NOT_IN_2B" : "NO_IMPORT" }));
  return {
    month,
    rows: out,
    totals: {
      eligible: sumRows(out.filter((r) => r.itcEligible && !r.reverseCharge)),
      reverseCharge: sumRows(out.filter((r) => r.reverseCharge)),
      blocked: sumRows(out.filter((r) => !r.itcEligible)),
    },
    has2b: Boolean(match),
  };
};

// ------------------------------------------------------------------ GSTR-2B import

const ddmmyyyy = (value) => {
  const m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(String(value || "").trim());
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : parseDateString(value);
};
const itemTotals = (doc) => {
  const items = Array.isArray(doc.items) ? doc.items : Array.isArray(doc.itms) ? doc.itms.map((i) => i.itm_det || i) : [];
  const pick = (key, alt) => (doc[key] !== undefined ? Number(doc[key]) : items.reduce((s, i) => s + Number(i[key] ?? i[alt] ?? 0), 0));
  return { taxableValue: round2(pick("txval")), igst: round2(pick("igst", "iamt")), cgst: round2(pick("cgst", "camt")), sgst: round2(pick("sgst", "samt")), cess: round2(pick("cess", "csamt")) };
};

const parse2bJson = (text) => {
  let json;
  try {
    json = JSON.parse(text);
  } catch (_e) {
    throw new AppError("This is not a GSTR-2B JSON file", 400);
  }
  const docdata = json?.data?.docdata || json?.docdata || json?.data || {};
  const rows = [];
  for (const supplier of docdata.b2b || []) {
    for (const inv of supplier.inv || []) {
      rows.push({ section: "B2B", supplierGstin: supplier.ctin, supplierName: supplier.trdnm || "", invoiceNumber: inv.inum, invoiceDate: ddmmyyyy(inv.dt || inv.idt), invoiceValue: round2(inv.val), placeOfSupply: inv.pos || "", reverseCharge: String(inv.rev || inv.rchrg || "N").toUpperCase() === "Y", itcAvailable: String(inv.itcavl || "Y").toUpperCase() !== "N", itcReason: inv.rsn || "", ...itemTotals(inv) });
    }
  }
  for (const supplier of docdata.cdnr || []) {
    for (const note of supplier.nt || []) {
      const sign = String(note.typ || note.ntty || "C").toUpperCase() === "C" ? -1 : 1;
      const t = itemTotals(note);
      rows.push({ section: "CDNR", supplierGstin: supplier.ctin, supplierName: supplier.trdnm || "", invoiceNumber: note.ntnum || note.nt_num, invoiceDate: ddmmyyyy(note.dt || note.nt_dt), noteType: sign < 0 ? "C" : "D", invoiceValue: round2(sign * Number(note.val || 0)), placeOfSupply: note.pos || "", reverseCharge: String(note.rev || "N").toUpperCase() === "Y", itcAvailable: String(note.itcavl || "Y").toUpperCase() !== "N", itcReason: note.rsn || "", taxableValue: sign * t.taxableValue, igst: sign * t.igst, cgst: sign * t.cgst, sgst: sign * t.sgst, cess: sign * t.cess });
    }
  }
  return rows;
};

// The 2B Excel: sheet "B2B", a two-row header starting with "GSTIN of supplier".
const B2B_COLUMNS = {
  supplierGstin: /gstin\s*of\s*supplier/i,
  supplierName: /trade|legal\s*name/i,
  invoiceNumber: /invoice\s*(number|no)/i,
  invoiceDate: /invoice\s*date/i,
  invoiceValue: /invoice\s*value/i,
  placeOfSupply: /place\s*of\s*supply/i,
  reverseCharge: /reverse\s*charge/i,
  taxableValue: /taxable\s*value/i,
  igst: /integrated\s*tax/i,
  cgst: /central\s*tax/i,
  sgst: /state.*tax/i,
  cess: /^cess/i,
  itcAvailable: /itc\s*availab/i,
};
const parse2bGrid = (grid) => {
  const start = grid.findIndex((r) => r.some((c) => /gstin\s*of\s*supplier/i.test(String(c))));
  if (start < 0) throw new AppError("Could not find the B2B table (a 'GSTIN of supplier' column) in this file", 400);
  const width = Math.max(grid[start].length, (grid[start + 1] || []).length);
  const header = Array.from({ length: width }, (_, i) => `${grid[start][i] || ""} ${(grid[start + 1] || [])[i] || ""}`.trim());
  const cols = {};
  header.forEach((text, i) => {
    for (const [key, re] of Object.entries(B2B_COLUMNS)) if (cols[key] === undefined && re.test(text)) { cols[key] = i; break; }
  });
  if (cols.invoiceNumber === undefined) throw new AppError("The B2B table has no invoice number column", 400);
  const rows = [];
  for (const r of grid.slice(start + 1)) {
    const gstin = String(r[cols.supplierGstin] || "").trim().toUpperCase();
    if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) continue;
    const get = (key) => (cols[key] === undefined ? "" : r[cols[key]]);
    rows.push({
      section: "B2B",
      supplierGstin: gstin,
      supplierName: String(get("supplierName") || "").trim(),
      invoiceNumber: String(get("invoiceNumber") || "").trim(),
      invoiceDate: get("invoiceDate") instanceof Date ? get("invoiceDate") : ddmmyyyy(get("invoiceDate")),
      invoiceValue: parseNumericAmount(get("invoiceValue")),
      placeOfSupply: String(get("placeOfSupply") || ""),
      reverseCharge: /^y/i.test(String(get("reverseCharge") || "")),
      taxableValue: parseNumericAmount(get("taxableValue")),
      igst: parseNumericAmount(get("igst")),
      cgst: parseNumericAmount(get("cgst")),
      sgst: parseNumericAmount(get("sgst")),
      cess: parseNumericAmount(get("cess")),
      itcAvailable: !/^n/i.test(String(get("itcAvailable") || "Yes")),
    });
  }
  return rows;
};

const import2b = async ({ businessId, userId, month, jsonText, csvText, fileBase64, fileName }) => {
  monthPeriod(month);
  let rows;
  let format = "JSON";
  if (jsonText) rows = parse2bJson(jsonText);
  else if (fileBase64) {
    const book = XLSX.read(Buffer.from(fileBase64, "base64"), { type: "buffer", cellDates: true });
    const name = book.SheetNames.find((n) => /^b2b$/i.test(n.trim())) || book.SheetNames.find((n) => /b2b/i.test(n)) || book.SheetNames[0];
    rows = parse2bGrid(XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: "" }));
    format = "XLSX";
  } else if (csvText) {
    rows = parse2bGrid(parseCsvLines(String(csvText)));
    format = "CSV";
  } else throw new AppError("Upload the GSTR-2B JSON or Excel file", 400);
  if (!rows.length) throw new AppError("No supplier bills found in this GSTR-2B file", 400);
  // keep IMS decisions already taken on the same bills in an earlier import of this period
  const previous = await Gstr2bImport.findOne({ businessId, period: month }).sort({ createdAt: -1 }).lean();
  const decided = new Map((previous?.rows || []).filter((r) => r.imsAction !== "PENDING").map((r) => [`${r.supplierGstin}|${normalizeNumber(r.invoiceNumber)}`, r]));
  for (const row of rows) {
    const old = decided.get(`${row.supplierGstin}|${normalizeNumber(row.invoiceNumber)}`);
    if (old) { row.imsAction = old.imsAction; row.imsNote = old.imsNote; }
  }
  const doc = await Gstr2bImport.create({ businessId, period: month, fileName: String(fileName || "").slice(0, 200), format, rows, importedBy: userId });
  const totals = rows.reduce((t, r) => ({ igst: t.igst + r.igst, cgst: t.cgst + r.cgst, sgst: t.sgst + r.sgst }), { igst: 0, cgst: 0, sgst: 0 });
  return { importId: doc._id, rows: rows.length, totalTax: round2(totals.igst + totals.cgst + totals.sgst) };
};

// Every bill in the latest 2B of the month, matched to our bills by supplier GSTIN and bill
// number (letters and digits only, leading zeros ignored), tax compared to within a rupee.
// Our bills of the month that no 2B of the year has are NOT_IN_2B (the supplier has not filed).
const match2b = async ({ businessId, month, bills }) => {
  const latest = await Gstr2bImport.findOne({ businessId, period: month }).sort({ createdAt: -1 }).lean();
  if (!latest) return null;
  const period = monthPeriod(month);
  const yearStart = new Date(Date.UTC(period.start.getUTCMonth() >= 3 ? period.start.getUTCFullYear() - 1 : period.start.getUTCFullYear() - 2, 3, 1));
  const candidates = (await bookBills({ businessId, from: yearStart, to: new Date(period.end.getTime() + 62 * DAY) })).filter((b) => !b.reverseCharge);
  const byKey = new Map();
  for (const bill of candidates) {
    const key = `${String(bill.supplierGstin).toUpperCase()}|${normalizeNumber(bill.supplierInvoiceNumber)}`;
    if (bill.supplierGstin && normalizeNumber(bill.supplierInvoiceNumber)) byKey.set(key, bill);
  }
  const matchedIds = new Set();
  const statement = latest.rows.map((row) => {
    const bill = byKey.get(`${row.supplierGstin}|${normalizeNumber(row.invoiceNumber)}`);
    let status = "NOT_IN_BOOKS";
    if (bill) {
      matchedIds.add(idOf(bill.sourceId));
      const close = ["igst", "cgst", "sgst"].every((k) => Math.abs(Math.abs(Number(row[k] || 0)) - Number(bill[k] || 0)) <= 1);
      status = close ? "MATCHED" : "VALUE_MISMATCH";
    }
    return { ...row, status, bill: bill ? { sourceType: bill.sourceType, sourceId: bill.sourceId, number: bill.number, igst: bill.igst, cgst: bill.cgst, sgst: bill.sgst } : null };
  });
  // other months' 2B imports of the year, to tell "filed in another month" from "not filed"
  const others = await Gstr2bImport.find({ businessId, _id: { $ne: latest._id } }).sort({ createdAt: -1 }).lean();
  const elsewhere = new Map();
  for (const imp of others) for (const r of imp.rows) {
    const key = `${r.supplierGstin}|${normalizeNumber(r.invoiceNumber)}`;
    if (!elsewhere.has(key)) elsewhere.set(key, imp.period);
  }
  const monthBills = bills || candidates.filter((b) => b.date >= period.start && b.date < period.end);
  const books = monthBills.filter((b) => !b.reverseCharge).map((bill) => {
    const key = `${String(bill.supplierGstin).toUpperCase()}|${normalizeNumber(bill.supplierInvoiceNumber)}`;
    const own = statement.find((r) => r.bill && idOf(r.bill.sourceId) === idOf(bill.sourceId));
    let status = own ? own.status : elsewhere.has(key) ? "IN_OTHER_MONTH" : !bill.supplierGstin ? "NO_SUPPLIER_GSTIN" : !normalizeNumber(bill.supplierInvoiceNumber) ? "NO_BILL_NUMBER" : "NOT_IN_2B";
    return { sourceType: bill.sourceType, sourceId: bill.sourceId, number: bill.number, supplierName: bill.supplierName, supplierGstin: bill.supplierGstin, supplierInvoiceNumber: bill.supplierInvoiceNumber, totalTax: tax(bill), status, otherMonth: elsewhere.get(key) || "" };
  });
  const usable = statement.filter((r) => r.itcAvailable && !r.reverseCharge && r.imsAction !== "REJECTED");
  return {
    importId: latest._id,
    fileName: latest.fileName,
    importedAt: latest.createdAt,
    statement,
    books,
    totals: {
      in2b: sumRows(statement),
      claimable: sumRows(usable),
      rejected: sumRows(statement.filter((r) => r.imsAction === "REJECTED")),
      problems: statement.filter((r) => r.status !== "MATCHED").length + books.filter((b) => !["MATCHED", "VALUE_MISMATCH"].includes(b.status)).length,
    },
  };
};

const setImsAction = async ({ businessId, month, rowId, action, note }) => {
  if (!["PENDING", "ACCEPTED", "REJECTED"].includes(action)) throw new AppError("Action must be ACCEPTED, REJECTED or PENDING", 400);
  const latest = await Gstr2bImport.findOne({ businessId, period: month }).sort({ createdAt: -1 });
  if (!latest) throw new AppError("No GSTR-2B imported for this month", 404);
  const row = latest.rows.id(rowId);
  if (!row) throw new AppError("Bill not found in this GSTR-2B", 404);
  row.imsAction = action;
  if (note !== undefined) row.imsNote = String(note || "").slice(0, 300);
  await latest.save();
  return row;
};

// ------------------------------------------------------------------ reverse charge documents

const amountInWords = (value) => {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`);
  const three = (n) => `${n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? " " : ""}` : ""}${n % 100 ? two(n % 100) : ""}`;
  let n = Math.round(Number(value || 0));
  if (!n) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return parts.join(" ");
};

// Self-invoice (s.31(3)(f)) and payment voucher (s.31(3)(g), rule 52) for one reverse-charge bill.
const rcmDocuments = async ({ businessId, expenseId }) => {
  const expense = await Expense.findOne({ _id: expenseId, businessId }).lean();
  if (!expense) throw new AppError("Expense not found", 404);
  if (expense.gstType !== "REVERSE_CHARGE") throw new AppError("This bill is not under reverse charge", 400);
  const business = await Business.findById(businessId).lean();
  const supplier = expense.supplierId ? await Supplier.findById(expense.supplierId).lean() : null;
  const snap = expense.gstSnapshot || {};
  const t = taxesOf(snap);
  const totalTax = round2(t.igst + t.cgst + t.sgst);
  const recipient = {
    name: business?.name || "",
    gstin: business?.gstConfiguration?.gstin || business?.gstTaxId || "",
    address: business?.address || business?.businessAddress || "",
    stateCode: business?.gstConfiguration?.stateCode || "",
  };
  const supplierBlock = { name: supplier?.supplierName || expense.vendorName || "", address: supplier?.address || "", pan: supplier?.pan || "", gstin: "Unregistered" };
  const line = { description: expense.description || expense.category, sac: expense.category === "Rent" ? "997212" : "", taxableValue: t.taxableValue, rate: snap.rate || expense.gstRate || 18, ...t };
  return {
    selfInvoice: {
      title: "Self invoice (supplies received from an unregistered person, reverse charge)",
      number: expense.selfInvoiceNumber,
      date: expense.expenseDate,
      recipient,
      supplier: supplierBlock,
      placeOfSupply: recipient.stateCode,
      lines: [line],
      totalTax,
      totalInWords: `Rupees ${amountInWords(totalTax)} only (tax payable on reverse charge)`,
      reverseCharge: "Yes",
      reference: expense.expenseNumber,
    },
    paymentVoucher: {
      title: "Payment voucher (reverse charge)",
      number: expense.selfInvoiceNumber ? expense.selfInvoiceNumber.replace(/^RCM\//, "PV/") : "",
      date: expense.paidAmount > 0 ? expense.updatedAt || expense.expenseDate : null,
      paid: expense.paymentStatus !== "UNPAID",
      recipient,
      supplier: supplierBlock,
      amountPaid: round2(expense.paidAmount),
      amountInWords: `Rupees ${amountInWords(expense.paidAmount)} only`,
      tax: t,
      totalTax,
      rate: line.rate,
      reference: expense.expenseNumber,
    },
  };
};

// ------------------------------------------------------------------ GSTR-3B

const add = (a, b, sign = 1) => ({ taxableValue: round2(a.taxableValue + sign * Number(b.taxableValue || 0)), igst: round2(a.igst + sign * Number(b.igst || 0)), cgst: round2(a.cgst + sign * Number(b.cgst || 0)), sgst: round2(a.sgst + sign * Number(b.sgst || 0)) });
const zero = () => ({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });

// Use credit as section 49 / rule 88A orders it: IGST credit first against IGST, then CGST and
// SGST; CGST credit against CGST then IGST; SGST credit against SGST then IGST (never CGST<->SGST).
const setOff = (liability, credit) => {
  const due = { ...liability };
  const left = { ...credit };
  const used = { igst: { igst: 0, cgst: 0, sgst: 0 }, cgst: { igst: 0, cgst: 0 }, sgst: { igst: 0, sgst: 0 } };
  const use = (from, to) => {
    const amount = round2(Math.min(left[from], due[to]));
    if (amount <= 0) return;
    left[from] = round2(left[from] - amount);
    due[to] = round2(due[to] - amount);
    used[from][to] = round2(used[from][to] + amount);
  };
  use("igst", "igst");
  // IGST left over: CGST and SGST in any order; we fill CGST first, then SGST
  use("igst", "cgst");
  use("igst", "sgst");
  use("cgst", "cgst");
  use("cgst", "igst");
  use("sgst", "sgst");
  use("sgst", "igst");
  return { cash: { igst: due.igst, cgst: due.cgst, sgst: due.sgst }, used, creditLeft: left };
};

const dueDateOf = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 20));
};

const gstr3b = async ({ businessId, month, filingDate }) => {
  const period = monthPeriod(month);
  const outward = await buildGstr1({ businessId, month });
  // 3.1(a): outward taxable supplies, less credit notes
  let a = zero();
  for (const r of [...outward.b2b, ...outward.b2cl, ...outward.b2cs]) a = add(a, r);
  for (const r of [...outward.cdnr, ...outward.cdnur]) a = add(a, r, -1);
  const ex = Object.values(outward.exemp || {});
  const c = { nilExempt: round2(ex.reduce((s, r) => s + Number(r.nil || 0) + Number(r.exempt || 0), 0)) };
  const e = { nonGst: round2(ex.reduce((s, r) => s + Number(r.nonGst || 0), 0)) };

  const bills = await bookBills({ businessId, from: period.start, to: period.end });
  const rcmBills = bills.filter((b) => b.reverseCharge);
  const d = sumRows(rcmBills);
  const booksItc = sumRows(bills.filter((b) => !b.reverseCharge && b.itcEligible));
  const rcmItc = sumRows(rcmBills.filter((b) => b.itcEligible));
  const blocked = sumRows(bills.filter((b) => !b.itcEligible));

  const match = await match2b({ businessId, month, bills });
  const otherItc = match ? match.totals.claimable : booksItc;
  const notes = [];
  if (!match) notes.push("No GSTR-2B imported for this month: 4A(5) shows the credit in your books. Claim only what appears in GSTR-2B (rule 36(4)); import it to check.");
  else if (Math.abs(match.totals.claimable.igst + match.totals.claimable.cgst + match.totals.claimable.sgst - (booksItc.igst + booksItc.cgst + booksItc.sgst)) > 1) {
    notes.push("Credit in GSTR-2B differs from your books. 4A(5) uses GSTR-2B (accepted and pending bills); see the GSTR-2B match for the bills that differ.");
  }

  const strangers = match ? match.statement.filter((r) => r.status === "NOT_IN_BOOKS" && r.imsAction === "PENDING" && r.itcAvailable) : [];
  if (strangers.length) notes.push(`${strangers.length} bill(s) in GSTR-2B are not in your books and have no IMS decision; the portal counts them as accepted. Reject them on the IMS if they are not yours, or enter the bills.`);

  // 4B(2): credit on bills still unpaid 180 days after the bill date must be reversed (rule 37)
  const yearBack = new Date(period.end.getTime() - 400 * DAY);
  const old = (await bookBills({ businessId, from: yearBack, to: period.end })).filter((b) => b.itcEligible && b.balanceAmount > 0 && (period.end - new Date(b.supplierInvoiceDate || b.date)) / DAY > 180);
  const rule37 = old.map((b) => ({ number: b.number, supplierName: b.supplierName, date: b.supplierInvoiceDate || b.date, balanceAmount: b.balanceAmount, tax: tax(b), share: round2(tax(b) * Math.min(1, b.balanceAmount / Math.max(b.taxableValue + tax(b), 1))) }));
  const reversal = { igst: 0, cgst: 0, sgst: 0, taxableValue: 0 };
  if (rule37.length) notes.push(`${rule37.length} bill(s) are unpaid 180 days after the bill date; the credit on the unpaid part should be reversed in 4B(2) and taken back when paid (rule 37). The amount is shown for review, not filled in.`);

  const itcAvailable = add(add(rcmItc, otherItc), zero());
  const netItc = add(itcAvailable, reversal, -1);
  const liability = { igst: a.igst, cgst: a.cgst, sgst: a.sgst };
  const so = setOff(liability, { igst: netItc.igst, cgst: netItc.cgst, sgst: netItc.sgst });
  // reverse charge tax is paid in cash only, never from credit
  const cash = { igst: round2(so.cash.igst + d.igst), cgst: round2(so.cash.cgst + d.cgst), sgst: round2(so.cash.sgst + d.sgst) };
  const cashTotal = round2(cash.igst + cash.cgst + cash.sgst);

  const due = dueDateOf(month);
  let interest = null;
  if (filingDate) {
    const filed = new Date(filingDate);
    const daysLate = Math.max(0, Math.ceil((filed - due) / DAY));
    interest = { daysLate, rate: 18, amount: round2((cashTotal * 0.18 * daysLate) / 365), lateFeePerDay: cashTotal > 0 || a.igst + a.cgst + a.sgst > 0 ? 50 : 20, lateFee: round2(Math.min(daysLate * (cashTotal > 0 ? 50 : 20), 10000)) };
  }

  return {
    month,
    gstin: outward.gstin,
    dueDate: due,
    table31: {
      a: { label: "(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", ...a },
      b: { label: "(b) Outward taxable supplies (zero rated)", ...zero() },
      c: { label: "(c) Other outward supplies (nil rated, exempted)", taxableValue: c.nilExempt, igst: 0, cgst: 0, sgst: 0 },
      d: { label: "(d) Inward supplies (liable to reverse charge)", ...d },
      e: { label: "(e) Non-GST outward supplies", taxableValue: e.nonGst, igst: 0, cgst: 0, sgst: 0 },
    },
    table4: {
      a3: { label: "4A(3) Inward supplies liable to reverse charge", ...rcmItc },
      a5: { label: "4A(5) All other ITC", ...otherItc, source: match ? "GSTR-2B" : "books" },
      booksItc,
      b2: { label: "4B(2) Others (rule 37: unpaid after 180 days) - review", ...reversal, bills: rule37 },
      d: { label: "4D ITC not available: blocked credit (s.17(5)), kept in cost", ...blocked },
      net: { label: "4C Net ITC available (A - B)", ...netItc },
    },
    payment: { liability, creditUsed: so.used, cashFromCredit: so.cash, reverseChargeCash: { igst: d.igst, cgst: d.cgst, sgst: d.sgst }, cash, cashTotal, creditLeft: so.creditLeft },
    interest,
    notes: [...notes, ...outward.issues.filter((i) => i.level === "error").map((i) => `GSTR-1: ${i.invoiceNumber ? `${i.invoiceNumber}: ` : ""}${i.message}`)],
    rcmBills: rcmBills.map((b) => ({ number: b.number, selfInvoiceNumber: b.selfInvoiceNumber, supplierName: b.supplierName, taxableValue: b.taxableValue, tax: tax(b) })),
  };
};

// ------------------------------------------------------------------ GSTR-1 JSON

const fmtDate = (value) => {
  const d = new Date(new Date(value).getTime() + 330 * 60 * 1000);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
};
const posCode = (label) => String(label || "").slice(0, 2);
const itm = (r, num) => ({ num, itm_det: { txval: round2(r.taxableValue), rt: Number(r.rate || 0), iamt: round2(r.igst), camt: round2(r.cgst), samt: round2(r.sgst), csamt: 0 } });

// The portal's GSTR-1 JSON (as the offline tool reads it). Built from the same data as the
// GSTR-1 workbook; check it in the offline tool before uploading.
const docBlocks = (docs) => {
  const block = (doc_num, doc_typ, re) => {
    const rows = docs.filter((x) => re.test(x.nature));
    return rows.length ? { doc_num, doc_typ, docs: rows.map((x, i) => ({ num: i + 1, from: x.from, to: x.to, totnum: x.total, cancel: x.cancelled, net_issue: x.total - x.cancelled })) } : null;
  };
  return [block(1, "Invoices for outward supply", /invoice/i), block(5, "Credit Note", /credit/i)].filter(Boolean);
};

const gstr1Json = async ({ businessId, month }) => {
  const data = await buildGstr1({ businessId, month });
  const [y, m] = month.split("-");
  const groupInvoices = (rows, keyOf) => {
    const map = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      if (!map.has(key)) map.set(key, { head: r, items: [] });
      map.get(key).items.push(r);
    }
    return [...map.values()];
  };
  const b2bByParty = new Map();
  for (const { head, items } of groupInvoices(data.b2b, (r) => `${r.gstin}|${r.invoiceNumber}`)) {
    if (!b2bByParty.has(head.gstin)) b2bByParty.set(head.gstin, []);
    b2bByParty.get(head.gstin).push({ inum: head.invoiceNumber, idt: fmtDate(head.invoiceDate), val: round2(head.invoiceValue), pos: posCode(head.pos), rchrg: head.reverseCharge || "N", inv_typ: "R", itms: items.map((r, i) => itm(r, i + 1)) });
  }
  const cdnrByParty = new Map();
  for (const { head, items } of groupInvoices(data.cdnr, (r) => `${r.gstin}|${r.noteNumber}`)) {
    if (!cdnrByParty.has(head.gstin)) cdnrByParty.set(head.gstin, []);
    cdnrByParty.get(head.gstin).push({ ntty: head.noteType || "C", nt_num: head.noteNumber, nt_dt: fmtDate(head.noteDate), val: round2(head.noteValue), pos: posCode(head.pos), rchrg: "N", inv_typ: "R", itms: items.map((r, i) => itm(r, i + 1)) });
  }
  const b2clByPos = new Map();
  for (const { head, items } of groupInvoices(data.b2cl, (r) => r.invoiceNumber)) {
    const pos = posCode(head.pos);
    if (!b2clByPos.has(pos)) b2clByPos.set(pos, []);
    b2clByPos.get(pos).push({ inum: head.invoiceNumber, idt: fmtDate(head.invoiceDate), val: round2(head.invoiceValue), itms: items.map((r, i) => itm(r, i + 1)) });
  }
  const own = String(data.gstin || "").slice(0, 2);
  const hsnRow = (r, i) => ({ num: i + 1, hsn_sc: r.hsn, desc: r.description || "", uqc: r.uqc || "NA", qty: round2(r.quantity), txval: round2(r.taxableValue), iamt: round2(r.igst), camt: round2(r.cgst), samt: round2(r.sgst), csamt: 0, rt: Number(r.rate || 0) });
  const ex = data.exemp || {};
  const nil = [
    // INTR = inter-state, INTRA = intra-state
    ["INTRB2B", ex.interRegistered], ["INTRAB2B", ex.intraRegistered], ["INTRB2C", ex.interUnregistered], ["INTRAB2C", ex.intraUnregistered],
  ].filter(([, v]) => v && (v.nil || v.exempt || v.nonGst)).map(([sply_ty, v]) => ({ sply_ty, nil_amt: round2(v.nil), expt_amt: round2(v.exempt), ngsup_amt: round2(v.nonGst) }));
  const json = {
    gstin: data.gstin,
    fp: `${m}${y}`,
    version: "GST3.2.1",
    hash: "hash",
    b2b: [...b2bByParty.entries()].map(([ctin, inv]) => ({ ctin, inv })),
    b2cl: [...b2clByPos.entries()].map(([pos, inv]) => ({ pos, inv })),
    b2cs: data.b2cs.map((r) => ({ sply_ty: posCode(r.pos) === own ? "INTRA" : "INTER", pos: posCode(r.pos), typ: "OE", txval: round2(r.taxableValue), rt: Number(r.rate || 0), iamt: round2(r.igst), camt: round2(r.cgst), samt: round2(r.sgst), csamt: 0 })),
    cdnr: [...cdnrByParty.entries()].map(([ctin, nt]) => ({ ctin, nt })),
    cdnur: data.cdnur.map((r) => ({ typ: r.urType || "B2CL", ntty: r.noteType || "C", nt_num: r.noteNumber, nt_dt: fmtDate(r.noteDate), val: round2(r.noteValue), pos: posCode(r.pos), itms: [itm(r, 1)] })),
    nil: nil.length ? { inv: nil } : undefined,
    hsn: { hsn_b2b: data.hsnB2B.map(hsnRow), hsn_b2c: data.hsnB2C.map(hsnRow) },
    doc_issue: data.docs.length ? { doc_det: docBlocks(data.docs) } : undefined,
  };
  for (const key of Object.keys(json)) if (json[key] === undefined || (Array.isArray(json[key]) && !json[key].length)) delete json[key];
  const { checkGstr1Json } = require("../utils/gstr1-json-check");
  return { json, fileName: `${data.gstin || "GSTIN"}_GSTR1_${m}${y}.json`, issues: data.issues, checks: checkGstr1Json(json) };
};

module.exports = { bookBills, gstr1Json, gstr3b, import2b, itcRegister, match2b, parse2bGrid, parse2bJson, rcmDocuments, setImsAction, setOff, amountInWords, monthOf };
