const mongoose = require("mongoose");
const XLSX = require("xlsx");
const AppError = require("../utils/appError");
const Expense = require("../models/Expense");
const Supplier = require("../models/Supplier");
const Customer = require("../models/Customer");
const Payment = require("../models/Payment");
const TdsReceivable = require("../models/TdsReceivable");
const TdsChallan = require("../models/TdsChallan");
const Tds26asImport = require("../models/Tds26asImport");
const { TDS_KINDS, TDS_RETURN_DUE, tdsKind, indianQuarterOf, quarterRange } = require("../constants/tds");
const { parseCsvLines, parseDateString, parseNumericAmount } = require("../utils/csv-parser");
const { ensureDefaultAccounts, postJournalEntry, reverseRecordPostings } = require("./accounting.service");

const paise = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100);
const rupees = (minor) => Math.round(minor) / 100;
const idOf = (value) => (value ? String(value._id || value) : "");

// "2026-27" -> { fyStart: 2026, from, to }
const fyRange = (fy) => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(fy || ""));
  if (!match) throw new AppError("Financial year must look like 2026-27", 400);
  const fyStart = Number(match[1]);
  return { fyStart, from: new Date(Date.UTC(fyStart, 3, 1)), to: new Date(Date.UTC(fyStart + 1, 2, 31, 23, 59, 59, 999)) };
};

const periodRange = ({ fy, quarter }) => {
  const { fyStart, from, to } = fyRange(fy);
  if (!quarter) return { fyStart, from, to };
  const index = Number(String(quarter).replace(/^Q/i, ""));
  if (![1, 2, 3, 4].includes(index)) throw new AppError("Quarter must be Q1 to Q4", 400);
  return { fyStart, ...quarterRange(fyStart, index) };
};

const monthKey = (date) => {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// TDS deducted in a month is due by the 7th of the next month; March's by 30 April.
const depositDueDate = (period) => {
  const [year, month] = period.split("-").map(Number);
  if (month === 3) return new Date(Date.UTC(year, 3, 30));
  return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 7));
};

const sectionLabel = (key) => {
  const kind = tdsKind(key);
  return kind ? `${kind.oldSection} / ${kind.newSection}` : key || "";
};

// ---------------------------------------------------------------- TDS customers deducted from us

const receivableRegister = async ({ businessId, fy, quarter, customerId }) => {
  const filter = { businessId };
  if (fy) filter.fy = fy;
  if (quarter) filter.quarter = String(quarter).toUpperCase();
  if (customerId) filter.customerId = customerId;
  const rows = await TdsReceivable.find(filter).sort({ deductedOn: 1 }).lean();
  const customers = new Map((await Customer.find({ _id: { $in: rows.map((r) => r.customerId).filter(Boolean) } }).select("name tan pan").lean()).map((c) => [String(c._id), c]));
  const payments = new Map((await Payment.find({ _id: { $in: rows.map((r) => r.paymentId) } }).select("referenceNumber amount paymentDate").lean()).map((p) => [String(p._id), p]));
  const match = fy ? await match26as({ businessId, fy }) : null;
  const matchByKey = new Map((match?.rows || []).map((row) => [`${row.deductorTan}|${row.quarter}`, row.status]));
  const out = rows.map((row) => {
    const customer = customers.get(idOf(row.customerId));
    const tan = row.deductorTan || customer?.tan || "";
    return {
      _id: row._id,
      paymentId: row.paymentId,
      paymentReference: payments.get(idOf(row.paymentId))?.referenceNumber || "",
      customerId: row.customerId,
      customerName: customer?.name || "",
      deductorTan: tan,
      tdsKind: row.tdsKind,
      section: sectionLabel(row.tdsKind),
      amount: row.amount,
      grossAmount: row.grossAmount,
      deductedOn: row.deductedOn,
      fy: row.fy,
      quarter: row.quarter,
      status: row.status,
      certificateNumber: row.certificateNumber || "",
      certificateReceivedAt: row.certificateReceivedAt || null,
      notes: row.notes || "",
      in26as: row.status === "REVERSED" ? "" : !tan ? "NO_TAN" : match ? matchByKey.get(`${tan}|${row.quarter}`) || "NO_IMPORT" : "",
    };
  });
  const open = out.filter((row) => row.status === "OPEN");
  return {
    rows: out,
    summary: {
      deducted: rupees(open.reduce((sum, row) => sum + paise(row.amount), 0)),
      certificatesReceived: open.filter((row) => row.certificateNumber).length,
      certificatesPending: open.filter((row) => !row.certificateNumber).length,
      entries: open.length,
    },
    match,
  };
};

const updateReceivable = async ({ businessId, id, certificateNumber, certificateReceivedAt, notes, deductorTan }) => {
  const row = await TdsReceivable.findOne({ _id: id, businessId });
  if (!row) throw new AppError("TDS entry not found", 404);
  if (certificateNumber !== undefined) row.certificateNumber = String(certificateNumber || "").trim().slice(0, 40);
  if (certificateReceivedAt !== undefined) row.certificateReceivedAt = certificateReceivedAt ? new Date(certificateReceivedAt) : null;
  if (row.certificateNumber && !row.certificateReceivedAt) row.certificateReceivedAt = new Date();
  if (notes !== undefined) row.notes = String(notes || "").trim().slice(0, 500);
  if (deductorTan !== undefined) row.deductorTan = require("../utils/tax-ids").normalizeTan(deductorTan);
  await row.save();
  return row;
};

// A 26AS / AIS TDS download. Two layouts are read:
//  - a plain table with a header row naming the deductor TAN and the tax deducted, one line per credit;
//  - the 26AS text/CSV export, where a deductor line (name, TAN, totals) is followed by its credit lines.
// Header names are matched loosely; dates DD-MMM-YYYY / DD/MM/YYYY / YYYY-MM-DD.
const HEADER_MATCHERS = {
  deductorName: /name\s*of\s*(the\s*)?deductor|deductor\s*name/i,
  deductorTan: /tan/i,
  section: /^section|section\s*(code)?$/i,
  transactionDate: /transaction\s*date|date\s*of\s*(payment|credit)|^date$/i,
  amountPaid: /amount\s*(paid|credited)|paid\s*\/\s*credited|gross\s*amount/i,
  taxDeducted: /tax\s*deducted|tds\s*(amount|deducted)|^tds$/i,
};

const findHeader = (grid) => {
  for (let i = 0; i < Math.min(grid.length, 60); i += 1) {
    const cells = grid[i].map((cell) => String(cell ?? "").trim());
    const cols = {};
    cells.forEach((cell, index) => {
      if (!cell) return;
      for (const [key, re] of Object.entries(HEADER_MATCHERS)) {
        if (cols[key] === undefined && re.test(cell)) {
          cols[key] = index;
          break;
        }
      }
    });
    if (cols.taxDeducted !== undefined && (cols.deductorTan !== undefined || cols.transactionDate !== undefined)) return { index: i, cols };
  }
  return null;
};

const TAN_IN_TEXT = /\b([A-Z]{4}[0-9]{5}[A-Z])\b/;

const parse26asGrid = (grid) => {
  const header = findHeader(grid);
  if (!header) throw new AppError("Could not find the TDS table in this file. It needs columns for the deductor TAN (or transaction date) and the tax deducted.", 400);
  const { cols } = header;
  const rows = [];
  let current = { deductorName: "", deductorTan: "" };
  for (const raw of grid.slice(header.index + 1)) {
    const cells = raw.map((cell) => (cell === null || cell === undefined ? "" : cell));
    const text = cells.map(String).join(" ");
    const tanCell = cols.deductorTan !== undefined ? String(cells[cols.deductorTan] || "").trim().toUpperCase() : "";
    const tan = TAN_IN_TEXT.test(tanCell) ? tanCell.match(TAN_IN_TEXT)[1] : "";
    const date = cols.transactionDate !== undefined ? parseDateString(cells[cols.transactionDate]) : null;
    const tax = parseNumericAmount(cells[cols.taxDeducted]);
    // a deductor line of the 26AS layout: carries a TAN but no date - remember it for the lines below
    if (tan && !date && cols.transactionDate !== undefined) {
      current = { deductorName: cols.deductorName !== undefined ? String(cells[cols.deductorName] || "").trim() : "", deductorTan: tan };
      continue;
    }
    if (!tax && !date) {
      const loose = text.toUpperCase().match(TAN_IN_TEXT);
      if (loose) current = { deductorName: text.replace(loose[1], "").replace(/\s+/g, " ").trim().slice(0, 120), deductorTan: loose[1] };
      continue;
    }
    if (!tax) continue;
    const deductorTan = tan || current.deductorTan;
    const deductorName = (cols.deductorName !== undefined && String(cells[cols.deductorName] || "").trim()) || current.deductorName;
    rows.push({
      deductorName,
      deductorTan,
      section: cols.section !== undefined ? String(cells[cols.section] || "").trim() : "",
      transactionDate: date,
      amountPaid: cols.amountPaid !== undefined ? parseNumericAmount(cells[cols.amountPaid]) : 0,
      taxDeducted: tax,
      quarter: date ? indianQuarterOf(date).quarter : "",
    });
  }
  if (!rows.length) throw new AppError("No TDS lines found under the table header", 400);
  return rows;
};

const import26as = async ({ businessId, userId, fy, csvText, fileBase64, fileName }) => {
  fyRange(fy);
  let grid;
  if (fileBase64) {
    const book = XLSX.read(Buffer.from(fileBase64, "base64"), { type: "buffer", cellDates: true });
    const sheet = book.Sheets[book.SheetNames[0]];
    grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  } else if (csvText) {
    const text = String(csvText);
    // 26AS text export is caret-separated
    grid = text.includes("^") && !text.includes(",") ? text.split(/\r?\n/).filter(Boolean).map((line) => line.split("^")) : parseCsvLines(text);
  } else {
    throw new AppError("Upload the 26AS / AIS file", 400);
  }
  const rows = parse26asGrid(grid).filter((row) => !row.transactionDate || indianQuarterOf(row.transactionDate).fy === fy);
  const doc = await Tds26asImport.create({ businessId, fy, fileName: String(fileName || "").slice(0, 200), rows, importedBy: userId });
  return { importId: doc._id, rows: rows.length, totalTax: rupees(rows.reduce((sum, row) => sum + paise(row.taxDeducted), 0)) };
};

// Our TDS receivable rows against the latest 26AS import, per deductor TAN and quarter.
const match26as = async ({ businessId, fy }) => {
  const latest = await Tds26asImport.findOne({ businessId, fy }).sort({ createdAt: -1 }).lean();
  if (!latest) return null;
  const ours = await TdsReceivable.find({ businessId, fy, status: "OPEN" }).lean();
  const customers = new Map((await Customer.find({ _id: { $in: ours.map((r) => r.customerId).filter(Boolean) } }).select("name tan").lean()).map((c) => [String(c._id), c]));
  const groups = new Map();
  const group = (tan, quarter) => {
    const key = `${tan}|${quarter}`;
    if (!groups.has(key)) groups.set(key, { deductorTan: tan, quarter, deductorName: "", booksMinor: 0, statementMinor: 0, booksEntries: 0, statementEntries: 0 });
    return groups.get(key);
  };
  for (const row of ours) {
    const customer = customers.get(idOf(row.customerId));
    const tan = row.deductorTan || customer?.tan || "";
    const g = group(tan || "(no TAN)", row.quarter);
    g.deductorName = g.deductorName || customer?.name || "";
    g.booksMinor += paise(row.amount);
    g.booksEntries += 1;
  }
  for (const row of latest.rows || []) {
    const g = group(row.deductorTan || "(no TAN)", row.quarter || "");
    g.deductorName = g.deductorName || row.deductorName || "";
    g.statementMinor += paise(row.taxDeducted);
    g.statementEntries += 1;
  }
  const rows = [...groups.values()].map((g) => {
    const difference = g.statementMinor - g.booksMinor;
    let status = "MATCHED";
    if (g.deductorTan === "(no TAN)" && g.booksMinor) status = "NO_TAN";
    else if (!g.statementMinor) status = "MISSING_IN_26AS";
    else if (!g.booksMinor) status = "NOT_IN_BOOKS";
    else if (Math.abs(difference) > 100) status = difference < 0 ? "SHORT_IN_26AS" : "MORE_IN_26AS";
    return { deductorTan: g.deductorTan, deductorName: g.deductorName, quarter: g.quarter, inBooks: rupees(g.booksMinor), in26as: rupees(g.statementMinor), difference: rupees(difference), booksEntries: g.booksEntries, statementEntries: g.statementEntries, status };
  });
  rows.sort((a, b) => a.quarter.localeCompare(b.quarter) || a.deductorName.localeCompare(b.deductorName));
  return {
    importId: latest._id,
    fileName: latest.fileName,
    importedAt: latest.createdAt,
    rows,
    totals: {
      inBooks: rupees(rows.reduce((s, r) => s + paise(r.inBooks), 0)),
      in26as: rupees(rows.reduce((s, r) => s + paise(r.in26as), 0)),
      problems: rows.filter((r) => r.status !== "MATCHED").length,
    },
  };
};

// ---------------------------------------------------------------- TDS we deduct from suppliers

const tdsBills = async ({ businessId, from, to, extra = {} }) =>
  Expense.find({ businessId, status: { $ne: "CANCELLED" }, tdsAmount: { $gt: 0 }, expenseDate: { $gte: from, $lte: to }, ...extra }).sort({ expenseDate: 1 }).lean();

const suppliersById = async (ids) =>
  new Map((await Supplier.find({ _id: { $in: ids.filter(Boolean) } }).select("supplierName pan tdsKind tdsRate").lean()).map((s) => [String(s._id), s]));

const payableRegister = async ({ businessId, fy, now = new Date() }) => {
  const { from, to } = fyRange(fy);
  const bills = await tdsBills({ businessId, from, to });
  const suppliers = await suppliersById(bills.map((b) => b.supplierId));
  const challans = new Map((await TdsChallan.find({ businessId, _id: { $in: bills.map((b) => b.tdsChallanId).filter(Boolean) } }).lean()).map((c) => [String(c._id), c]));
  const rows = bills.map((bill) => {
    const supplier = suppliers.get(idOf(bill.supplierId));
    const challan = challans.get(idOf(bill.tdsChallanId));
    const period = monthKey(bill.expenseDate);
    return {
      expenseId: bill._id,
      expenseNumber: bill.expenseNumber,
      expenseDate: bill.expenseDate,
      period,
      quarter: indianQuarterOf(bill.expenseDate).quarter,
      payeeName: supplier?.supplierName || bill.vendorName || "",
      payeePan: supplier?.pan || "",
      supplierId: bill.supplierId || null,
      tdsKind: bill.tdsKind,
      section: sectionLabel(bill.tdsKind),
      amountBeforeTax: bill.amountBeforeTax,
      tdsRate: bill.tdsRate,
      tdsAmount: bill.tdsAmount,
      challanId: challan?._id || null,
      challanDate: challan?.challanDate || null,
      challanSerial: challan?.challanSerial || "",
      bsrCode: challan?.bsrCode || "",
      dueDate: depositDueDate(period),
    };
  });
  const months = new Map();
  for (const row of rows) {
    const m = months.get(row.period) || { period: row.period, dueDate: row.dueDate, deductedMinor: 0, depositedMinor: 0, bills: 0, byKind: {} };
    m.deductedMinor += paise(row.tdsAmount);
    if (row.challanId) m.depositedMinor += paise(row.tdsAmount);
    m.byKind[row.tdsKind] = rupees(paise(m.byKind[row.tdsKind] || 0) + paise(row.tdsAmount));
    m.bills += 1;
    months.set(row.period, m);
  }
  const monthRows = [...months.values()].map((m) => {
    const pendingMinor = m.deductedMinor - m.depositedMinor;
    return { period: m.period, dueDate: m.dueDate, deducted: rupees(m.deductedMinor), deposited: rupees(m.depositedMinor), pending: rupees(pendingMinor), bills: m.bills, byKind: m.byKind, overdue: pendingMinor > 0 && now > m.dueDate };
  });
  return {
    rows,
    months: monthRows,
    summary: {
      deducted: rupees(rows.reduce((s, r) => s + paise(r.tdsAmount), 0)),
      pending: rupees(monthRows.reduce((s, m) => s + paise(m.pending), 0)),
      overdueMonths: monthRows.filter((m) => m.overdue).length,
    },
    limits: await limitWatch({ businessId, fy }),
  };
};

// Suppliers whose bills this year crossed a TDS limit while some of their bills carry no TDS.
const limitWatch = async ({ businessId, fy }) => {
  const { from, to } = fyRange(fy);
  const suppliers = await Supplier.find({ businessId, tdsKind: { $ne: "" } }).select("supplierName pan tdsKind").lean();
  if (!suppliers.length) return [];
  const bills = await Expense.find({ businessId, status: { $ne: "CANCELLED" }, supplierId: { $in: suppliers.map((s) => s._id) }, expenseDate: { $gte: from, $lte: to } })
    .select("supplierId expenseDate amountBeforeTax tdsAmount expenseNumber")
    .lean();
  const out = [];
  for (const supplier of suppliers) {
    const kind = tdsKind(supplier.tdsKind);
    if (!kind) continue;
    const own = bills.filter((b) => idOf(b.supplierId) === idOf(supplier._id));
    const untaxed = own.filter((b) => !(b.tdsAmount > 0));
    if (!untaxed.length) continue;
    const yearTotal = own.reduce((s, b) => s + Number(b.amountBeforeTax || 0), 0);
    const reasons = [];
    if (kind.limit.perYear && yearTotal > kind.limit.perYear) reasons.push(`₹${Math.round(yearTotal).toLocaleString("en-IN")} this year, above the ₹${kind.limit.perYear.toLocaleString("en-IN")} yearly limit`);
    if (kind.limit.perPayment) {
      const big = untaxed.filter((b) => Number(b.amountBeforeTax || 0) > kind.limit.perPayment);
      if (big.length) reasons.push(`${big.length} bill(s) above ₹${kind.limit.perPayment.toLocaleString("en-IN")} each without TDS`);
    }
    if (kind.limit.perMonth) {
      const byMonth = new Map();
      for (const b of own) byMonth.set(monthKey(b.expenseDate), (byMonth.get(monthKey(b.expenseDate)) || 0) + Number(b.amountBeforeTax || 0));
      const over = [...byMonth.entries()].filter(([, v]) => v > kind.limit.perMonth).map(([k]) => k);
      if (over.length) reasons.push(`above ₹${kind.limit.perMonth.toLocaleString("en-IN")} a month in ${over.join(", ")}`);
    }
    if (reasons.length) out.push({ supplierId: supplier._id, supplierName: supplier.supplierName, tdsKind: supplier.tdsKind, section: sectionLabel(supplier.tdsKind), billsWithoutTds: untaxed.map((b) => b.expenseNumber), reasons });
  }
  return out;
};

const listChallans = async ({ businessId, fy }) => {
  const filter = { businessId };
  if (fy) {
    const { from, to } = fyRange(fy);
    filter.challanDate = { $gte: from, $lte: new Date(to.getTime() + 62 * 86400000) }; // March's deposit is in April / May
  }
  return TdsChallan.find(filter).sort({ challanDate: -1 }).lean();
};

const recordChallan = async ({ businessId, userId, payload }) => {
  const expenseIds = [...new Set((payload.expenseIds || []).map(String))].filter((id) => mongoose.isValidObjectId(id));
  if (!expenseIds.length) throw new AppError("Pick the bills whose TDS this challan deposits", 400);
  const challanDate = parseDateString(payload.challanDate) || (payload.challanDate ? new Date(payload.challanDate) : null);
  if (!challanDate || Number.isNaN(challanDate.getTime())) throw new AppError("Challan date is required", 400);
  const interestMinor = paise(payload.interestAmount);
  const feeMinor = paise(payload.feeAmount);
  if (interestMinor < 0 || feeMinor < 0) throw new AppError("Interest and fee cannot be negative", 400);
  const session = await mongoose.startSession();
  let challan;
  try {
    await session.withTransaction(async () => {
      const bills = await Expense.find({ _id: { $in: expenseIds }, businessId }).session(session);
      if (bills.length !== expenseIds.length) throw new AppError("Some bills were not found in this company", 404);
      for (const bill of bills) {
        if (bill.status === "CANCELLED") throw new AppError(`Bill ${bill.expenseNumber} is cancelled`, 400);
        if (!(bill.tdsAmount > 0)) throw new AppError(`Bill ${bill.expenseNumber} has no TDS`, 400);
        if (bill.tdsChallanId) throw new AppError(`The TDS on bill ${bill.expenseNumber} is already in a challan`, 409);
      }
      const periods = [...new Set(bills.map((b) => monthKey(b.expenseDate)))];
      const taxMinor = bills.reduce((s, b) => s + paise(b.tdsAmount), 0);
      if (payload.taxAmount !== undefined && payload.taxAmount !== "" && paise(payload.taxAmount) !== taxMinor) {
        throw new AppError(`The bills picked carry ₹${rupees(taxMinor)} of TDS, not ₹${payload.taxAmount}`, 400);
      }
      [challan] = await TdsChallan.create(
        [{
          businessId,
          period: periods.sort()[periods.length - 1],
          challanDate,
          taxAmount: rupees(taxMinor),
          interestAmount: rupees(interestMinor),
          feeAmount: rupees(feeMinor),
          bsrCode: String(payload.bsrCode || "").trim().slice(0, 7),
          challanSerial: String(payload.challanSerial || "").trim().slice(0, 10),
          cin: String(payload.cin || "").trim().slice(0, 40),
          paymentMethod: String(payload.paymentMethod || "BANK_TRANSFER").toUpperCase(),
          expenseIds: bills.map((b) => b._id),
          notes: String(payload.notes || "").trim().slice(0, 500),
          createdBy: userId,
        }],
        { session }
      );
      await Expense.updateMany({ _id: { $in: bills.map((b) => b._id) }, businessId }, { $set: { tdsChallanId: challan._id } }, { session });
      const accounts = await ensureDefaultAccounts({ businessId, session });
      const bank = accounts.get(challan.paymentMethod === "CASH" ? "1010" : "1020");
      const line = (acc, debitMinor, creditMinor, description) => ({ accountId: acc._id, accountCode: acc.code, accountName: acc.name, debitMinor, creditMinor, description });
      const lines = [line(accounts.get("2310"), taxMinor, 0, `TDS deposited for ${periods.join(", ")}`)];
      if (interestMinor + feeMinor > 0) lines.push(line(accounts.get("5180"), interestMinor + feeMinor, 0, "Interest / late fee on TDS"));
      lines.push(line(bank, 0, taxMinor + interestMinor + feeMinor, `TDS challan ${challan.challanSerial || challan._id}`));
      await postJournalEntry({
        businessId,
        userId,
        entryDate: challanDate,
        sourceType: "TDS_CHALLAN",
        sourceId: challan._id,
        sourceKey: `TDS_CHALLAN:${challan._id}:POSTED`,
        description: `TDS challan ${challan.challanSerial || ""} (${periods.join(", ")})`.trim(),
        lines,
        session,
      });
    });
  } finally {
    await session.endSession();
  }
  return challan;
};

const cancelChallan = async ({ businessId, userId, id, reason }) => {
  const session = await mongoose.startSession();
  let challan;
  try {
    await session.withTransaction(async () => {
      challan = await TdsChallan.findOne({ _id: id, businessId }).session(session);
      if (!challan) throw new AppError("Challan not found", 404);
      if (challan.status === "CANCELLED") return;
      challan.status = "CANCELLED";
      if (reason) challan.notes = `${challan.notes ? `${challan.notes} | ` : ""}Cancelled: ${String(reason).slice(0, 200)}`;
      await challan.save({ session });
      await Expense.updateMany({ businessId, tdsChallanId: challan._id }, { $set: { tdsChallanId: null } }, { session });
      await reverseRecordPostings({ businessId, keyType: "TDS_CHALLAN", recordId: challan._id, cancelKey: `TDS_CHALLAN:${challan._id}:CANCELLED`, label: "TDS challan cancelled", userId, entryDate: new Date(), session });
    });
  } finally {
    await session.endSession();
  }
  return challan;
};

// ---------------------------------------------------------------- returns and certificates

const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const ddmmyyyy = (date) => {
  if (!date) return "";
  const d = new Date(date);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};

// Deductee lines for the quarterly TDS statement (Form 140, formerly 26Q), in the order the
// return preparation utility asks for them. The CA / RPU builds the actual .fvu file.
const form140Rows = async ({ businessId, fy, quarter }) => {
  if (!quarter) throw new AppError("Pick a quarter", 400);
  const { from, to } = periodRange({ fy, quarter });
  const bills = await tdsBills({ businessId, from, to });
  const suppliers = await suppliersById(bills.map((b) => b.supplierId));
  const challans = new Map((await TdsChallan.find({ businessId, _id: { $in: bills.map((b) => b.tdsChallanId).filter(Boolean) } }).lean()).map((c) => [String(c._id), c]));
  return bills.map((bill, index) => {
    const supplier = suppliers.get(idOf(bill.supplierId));
    const challan = challans.get(idOf(bill.tdsChallanId));
    const kind = tdsKind(bill.tdsKind);
    const pan = supplier?.pan || "";
    return {
      serial: index + 1,
      oldSection: kind?.oldSection || "",
      newSection: kind?.newSection || "",
      nature: kind?.label || bill.tdsKind,
      deducteePan: pan || "PANNOTAVBL",
      deducteeName: supplier?.supplierName || bill.vendorName || "",
      paymentDate: ddmmyyyy(bill.expenseDate),
      deductionDate: ddmmyyyy(bill.expenseDate),
      amountPaid: bill.amountBeforeTax,
      rate: bill.tdsRate,
      tdsDeducted: bill.tdsAmount,
      tdsDeposited: challan && challan.status !== "CANCELLED" ? bill.tdsAmount : 0,
      bsrCode: challan?.bsrCode || "",
      challanDate: ddmmyyyy(challan?.challanDate),
      challanSerial: challan?.challanSerial || "",
      remark: !pan ? "C - higher rate, no PAN" : kind && bill.tdsRate < kind.rate ? "A - lower deduction certificate" : "",
      reference: bill.expenseNumber,
    };
  });
};

const FORM140_COLUMNS = [
  ["serial", "Sr"], ["oldSection", "Section (old)"], ["newSection", "Section (2025 Act)"], ["nature", "Nature of payment"],
  ["deducteePan", "Deductee PAN"], ["deducteeName", "Deductee name"], ["paymentDate", "Date of payment / credit"],
  ["deductionDate", "Date of deduction"], ["amountPaid", "Amount paid / credited"], ["rate", "Rate %"],
  ["tdsDeducted", "TDS deducted"], ["tdsDeposited", "TDS deposited"], ["bsrCode", "BSR code"],
  ["challanDate", "Challan date"], ["challanSerial", "Challan serial"], ["remark", "Reason for lower / higher deduction"], ["reference", "Our bill no."],
];

const form140Csv = async ({ businessId, fy, quarter }) => {
  const rows = await form140Rows({ businessId, fy, quarter });
  const lines = [FORM140_COLUMNS.map(([, label]) => csvCell(label)).join(",")];
  for (const row of rows) lines.push(FORM140_COLUMNS.map(([key]) => csvCell(row[key])).join(","));
  return { csv: `${lines.join("\r\n")}\r\n`, rows: rows.length, dueDate: TDS_RETURN_DUE[String(quarter).toUpperCase()] || "" };
};

// Form 131 (formerly 16A) register: per deductee and quarter, what the certificate will show.
// The certificate itself is downloaded from TRACES after the quarterly statement is filed.
const form131Register = async ({ businessId, fy, quarter }) => {
  const rows = await form140Rows({ businessId, fy, quarter });
  const byPayee = new Map();
  for (const row of rows) {
    const key = `${row.deducteePan}|${row.deducteeName}`;
    const p = byPayee.get(key) || { deducteePan: row.deducteePan, deducteeName: row.deducteeName, sections: new Set(), paidMinor: 0, deductedMinor: 0, depositedMinor: 0, lines: [] };
    p.sections.add(row.oldSection);
    p.paidMinor += paise(row.amountPaid);
    p.deductedMinor += paise(row.tdsDeducted);
    p.depositedMinor += paise(row.tdsDeposited);
    p.lines.push(row);
    byPayee.set(key, p);
  }
  return [...byPayee.values()].map((p) => ({
    deducteePan: p.deducteePan,
    deducteeName: p.deducteeName,
    sections: [...p.sections].join(", "),
    amountPaid: rupees(p.paidMinor),
    tdsDeducted: rupees(p.deductedMinor),
    tdsDeposited: rupees(p.depositedMinor),
    allDeposited: p.depositedMinor === p.deductedMinor,
    lines: p.lines,
  }));
};

const meta = () => ({ kinds: TDS_KINDS, returnDue: TDS_RETURN_DUE, currentPeriod: indianQuarterOf(new Date()) });

module.exports = {
  cancelChallan,
  depositDueDate,
  form131Register,
  form140Csv,
  form140Rows,
  import26as,
  limitWatch,
  listChallans,
  match26as,
  meta,
  parse26asGrid,
  payableRegister,
  receivableRegister,
  recordChallan,
  updateReceivable,
};
