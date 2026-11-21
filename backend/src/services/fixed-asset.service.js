// Fixed asset register and depreciation (phase 5).
// Companies Act, Schedule II: straight line over the useful life, 5% residual value, by the day.
// Fit-out in rented premises is written off over the lease if that is shorter, with no residual.
// The year's depreciation is posted on 31 March: Dr 5200 Depreciation, Cr 1590 Accumulated.
// Income-tax (s.32): written-down value by block (rate); assets put to use for less than 180
// days in the year get half the rate. The tax block is a report; it is not posted.
const mongoose = require("mongoose");
const AppError = require("../utils/appError");
const FixedAsset = require("../models/FixedAsset");
const Expense = require("../models/Expense");
const Purchase = require("../models/Purchase");
const JournalEntry = require("../models/JournalEntry");
const accounting = require("./accounting.service");
const { expenseAccountCodeFor } = require("../constants/expenses");
const { fyLabel } = require("../utils/invoice");

// Built defaults for the CA to confirm (status doc D17): Schedule II lives and Income-tax block rates.
const ASSET_CLASSES = {
  FURNITURE: { label: "Furniture & fittings", life: 10, itRate: 10 },
  FIT_OUT: { label: "Fit-out / leasehold improvements", life: 10, itRate: 10, residual: 0 },
  ELECTRICAL: { label: "Electrical installations & fittings", life: 10, itRate: 10 },
  OFFICE_EQUIPMENT: { label: "Office equipment (AC, printers, appliances)", life: 5, itRate: 15 },
  COMPUTERS: { label: "Computers (laptops, desktops)", life: 3, itRate: 40 },
  SERVERS_NETWORK: { label: "Servers & networks", life: 6, itRate: 40 },
  SOFTWARE: { label: "Software (licences)", life: 3, itRate: 40 },
  VEHICLE: { label: "Motor vehicles", life: 8, itRate: 15 },
  PLANT: { label: "Plant & machinery (general)", life: 15, itRate: 15 },
};
const IT_BLOCK_NAMES = { 10: "Furniture & fittings / building (10%)", 15: "Plant & machinery, vehicles (15%)", 40: "Computers & software (40%)" };

const DAY = 86400000;
const IST = 330 * 60 * 1000;
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const dayNo = (date) => Math.floor((new Date(date).getTime() + IST) / DAY); // IST calendar day number
const fromDayNo = (n) => new Date(n * DAY - IST + 12 * 3600 * 1000); // noon IST of that day
const fyBounds = (fy) => {
  if (!/^\d{2}-\d{2}$/.test(String(fy || ""))) throw new AppError("Choose a financial year like 25-26", 400);
  const y = 2000 + Number(fy.slice(0, 2));
  return { fy, start: dayNo(new Date(`${y}-04-01T00:00:00+05:30`)), end: dayNo(new Date(`${y + 1}-03-31T00:00:00+05:30`)), endDate: new Date(`${y + 1}-03-31T12:00:00+05:30`) };
};
const nextFy = (fy) => `${String(Number(fy.slice(0, 2)) + 1).padStart(2, "0")}-${String(Number(fy.slice(3)) + 1).padStart(2, "0")}`;
const cashOrBank = (mode) => (mode === "CASH" ? "1010" : "1020");

const withTransaction = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    await session.endSession();
  }
};

// ------------------------------------------------------------------ depreciation maths

const baseDay = (a) => dayNo(a.source === "OPENING" && a.openingDate ? a.openingDate : a.putToUseDate);
const lifeEndDay = (a) => {
  const put = new Date(a.putToUseDate);
  const end = new Date(put);
  end.setUTCFullYear(end.getUTCFullYear() + Math.floor(a.usefulLifeYears));
  let day = dayNo(end) + Math.round((a.usefulLifeYears % 1) * 365) - 1;
  if (a.leaseEndDate) day = Math.min(day, dayNo(a.leaseEndDate));
  return day;
};
const depreciableOf = (a) => round2(a.cost * (1 - Number(a.residualPercent ?? 5) / 100));
const postedTotal = (a, beforeFy = null) => round2((a.depreciation || []).filter((d) => !beforeFy || d.fy < beforeFy).reduce((s, d) => s + d.amount, 0));
const accumulatedOf = (a, beforeFy = null) => round2(Number(a.openingAccumulated || 0) + postedTotal(a, beforeFy));

// Companies Act depreciation for days [fromDay, toDay] (inclusive), straight line from the base
// day (put to use, or the opening day) to the end of life, capped at what is left to write off.
const depreciationFor = (a, fromDay, toDay) => {
  const start = Math.max(fromDay, baseDay(a));
  const disposalDay = a.disposal?.date ? dayNo(a.disposal.date) : Infinity;
  const end = Math.min(toDay, lifeEndDay(a), disposalDay);
  if (end < start) return 0;
  const totalDays = lifeEndDay(a) - baseDay(a) + 1;
  if (totalDays <= 0) return 0;
  const toWriteOff = depreciableOf(a) - Number(a.openingAccumulated || 0);
  const perDay = toWriteOff / totalDays;
  const left = round2(depreciableOf(a) - accumulatedOf(a));
  return Math.max(0, Math.min(left, round2(perDay * (end - start + 1))));
};

// ------------------------------------------------------------------ create / cancel

const nextAssetNumber = async ({ businessId, session }) => {
  const last = await FixedAsset.findOne({ businessId }).sort({ assetNumber: -1 }).session(session).lean();
  const n = last ? Number(String(last.assetNumber).replace(/\D/g, "")) + 1 : 1;
  return `FA-${String(n).padStart(4, "0")}`;
};

const postFor = async ({ asset, key, date, rows, description, userId, session }) => {
  const accounts = await accounting.ensureDefaultAccounts({ businessId: asset.businessId, session });
  const lines = rows.filter(([, dr, cr]) => dr > 0.004 || cr > 0.004).map(([code, dr, cr]) => accounting.postingLine(accounts.get(code), accounting.paise(dr), accounting.paise(cr), description, asset.centre || ""));
  return accounting.postJournalEntry({ businessId: asset.businessId, userId, entryDate: date, sourceType: "FIXED_ASSET", sourceId: asset._id, sourceKey: key, description, lines, session });
};

const createAsset = async ({ businessId, userId, payload = {} }) => {
  const cls = ASSET_CLASSES[payload.assetClass];
  if (!cls) throw new AppError("Choose the kind of asset", 400);
  const name = String(payload.name || "").trim();
  if (!name) throw new AppError("Name the asset", 400);
  const source = String(payload.source || "").toUpperCase();
  if (!["BILL", "PAID", "PAYABLE", "OPENING"].includes(source)) throw new AppError("Choose how the asset was paid for", 400);
  return withTransaction(async (session) => {
    let billDate = null;
    let cost = round2(payload.cost);
    let creditCode = null;
    let expenseId = null;
    let purchaseId = null;
    let supplierId = payload.supplierId || null;
    let billNumber = String(payload.billNumber || "").trim();
    if (source === "BILL") {
      if (payload.expenseId) {
        const exp = await Expense.findOne({ _id: payload.expenseId, businessId }).session(session);
        if (!exp || exp.status === "CANCELLED") throw new AppError("Bill not found", 404);
        const already = await FixedAsset.findOne({ businessId, expenseId: exp._id, status: { $ne: "CANCELLED" } }).session(session).lean();
        if (already) throw new AppError(`This bill is already in the register as ${already.assetNumber}`, 409);
        const billCost = round2(Number(exp.amountBeforeTax || 0) + (exp.itcEligible === false && exp.gstType === "GST_RECORDED" ? Number(exp.taxAmount || 0) : 0));
        cost = cost || billCost;
        if (cost > billCost + 0.004) throw new AppError(`The asset cost cannot be more than the bill (${billCost})`, 400);
        creditCode = expenseAccountCodeFor(exp.category);
        expenseId = exp._id; supplierId = supplierId || exp.supplierId; billNumber = billNumber || exp.supplierInvoiceNumber || exp.expenseNumber;
        billDate = exp.expenseDate;
      } else if (payload.purchaseId) {
        const pur = await Purchase.findOne({ _id: payload.purchaseId, businessId }).session(session);
        if (!pur) throw new AppError("Purchase not found", 404);
        cost = cost || round2(Number(pur.gstBreakup?.taxableValue || pur.totalAmount || 0));
        creditCode = "5100";
        purchaseId = pur._id; supplierId = supplierId || pur.supplierId; billNumber = billNumber || pur.supplierInvoiceNumber || "";
        billDate = pur.purchaseDate;
      } else throw new AppError("Pick the bill the asset was bought on", 400);
    }
    if (!(cost > 0)) throw new AppError("Enter the cost of the asset", 400);
    const purchaseDate = new Date(payload.purchaseDate || billDate || payload.putToUseDate || Date.now());
    const putToUseDate = new Date(payload.putToUseDate || purchaseDate);
    if (Number.isNaN(purchaseDate.getTime()) || Number.isNaN(putToUseDate.getTime())) throw new AppError("Enter valid dates", 400);
    if (dayNo(putToUseDate) < dayNo(purchaseDate)) throw new AppError("An asset cannot be put to use before it is bought", 400);
    const openingAccumulated = source === "OPENING" ? round2(payload.openingAccumulated || 0) : 0;
    if (openingAccumulated > cost) throw new AppError("Depreciation to date cannot be more than the cost", 400);
    const openingDate = source === "OPENING" ? new Date(payload.openingDate || Date.now()) : null;

    const assetNumber = await nextAssetNumber({ businessId, session });
    const [asset] = await FixedAsset.create([{
      businessId, assetNumber, name, assetClass: payload.assetClass,
      centre: String(payload.centre || "").trim(), location: String(payload.location || "").trim(), quantity: Number(payload.quantity || 1),
      supplierId, billNumber, purchaseDate, putToUseDate, cost, source, expenseId, purchaseId,
      paidMode: source === "PAID" ? (payload.paidMode === "CASH" ? "CASH" : "BANK") : "",
      usefulLifeYears: Number(payload.usefulLifeYears || cls.life),
      residualPercent: payload.residualPercent !== undefined && payload.residualPercent !== "" ? Number(payload.residualPercent) : cls.residual ?? 5,
      leaseEndDate: payload.leaseEndDate ? new Date(payload.leaseEndDate) : null,
      itRate: Number(payload.itRate || cls.itRate),
      openingDate, openingAccumulated,
      openingItWdv: source === "OPENING" && payload.openingItWdv !== undefined && payload.openingItWdv !== "" ? round2(payload.openingItWdv) : null,
      note: String(payload.note || "").trim(), createdBy: userId,
    }], { session });

    const description = `Fixed asset ${assetNumber}: ${name}`;
    const date = source === "OPENING" ? openingDate : purchaseDate;
    const rows = source === "OPENING"
      ? [["1510", cost, 0], ["1590", 0, openingAccumulated], ["3010", 0, round2(cost - openingAccumulated)]]
      : [["1510", cost, 0], [source === "BILL" ? creditCode : source === "PAID" ? cashOrBank(asset.paidMode) : "2010", 0, cost]];
    await postFor({ asset, key: `FIXED_ASSET:${asset._id}:CAPITALISED`, date, rows, description, userId, session });
    return asset.toObject();
  });
};

const cancelAsset = async ({ businessId, userId, assetId }) =>
  withTransaction(async (session) => {
    const asset = await FixedAsset.findOne({ _id: assetId, businessId }).session(session);
    if (!asset) throw new AppError("Asset not found", 404);
    if (asset.status === "CANCELLED") return asset.toObject();
    if (asset.depreciation.length || asset.status !== "IN_USE") throw new AppError("Depreciation is already charged on this asset; sell or discard it instead", 409);
    asset.status = "CANCELLED";
    await asset.save({ session });
    await accounting.reverseRecordPostings({ businessId, keyType: "FIXED_ASSET", recordId: asset._id, cancelKey: `FIXED_ASSET_CANCEL:${asset._id}`, label: `Fixed asset ${asset.assetNumber} cancelled`, userId, entryDate: asset.source === "OPENING" ? asset.openingDate : asset.purchaseDate, session });
    return asset.toObject();
  });

// ------------------------------------------------------------------ year-end run

const pendingYears = (asset, uptoFy) => {
  const out = [];
  let fy = fyLabel(fromDayNo(baseDay(asset)));
  while (fy <= uptoFy) {
    if (!asset.depreciation.some((d) => d.fy === fy)) out.push(fy);
    fy = nextFy(fy);
  }
  return out;
};

const runDepreciation = async ({ businessId, userId, fy, today = new Date() }) => {
  const b = fyBounds(fy);
  if (b.end >= dayNo(today)) throw new AppError(`FY ${fy} is not over yet; depreciation is charged after 31 March`, 400);
  return withTransaction(async (session) => {
    const assets = await FixedAsset.find({ businessId, status: { $ne: "CANCELLED" } }).session(session);
    const lines = [];
    const charged = [];
    for (const asset of assets) {
      if (baseDay(asset) > b.end) continue;
      if (asset.depreciation.some((d) => d.fy === fy)) continue;
      if (asset.disposal?.date && dayNo(asset.disposal.date) < b.start) continue;
      const missing = pendingYears(asset, fy).filter((y) => y < fy);
      if (missing.length) throw new AppError(`Charge FY ${missing[0]} first (${asset.assetNumber} has no depreciation for it)`, 409);
      const amount = depreciationFor(asset, b.start, b.end);
      asset.depreciation.push({ fy, amount, from: fromDayNo(Math.max(b.start, baseDay(asset))), to: b.endDate, sourceKey: "" });
      charged.push({ asset, amount });
    }
    if (!charged.length) return { fy, posted: false, total: 0, assets: [] };
    const total = round2(charged.reduce((s, c) => s + c.amount, 0));
    const run = (await JournalEntry.countDocuments({ businessId, sourceKey: { $regex: `^DEPRECIATION:${businessId}:${fy}:` } }).session(session)) + 1;
    const key = `DEPRECIATION:${businessId}:${fy}:${run}`;
    if (total > 0) {
      const accounts = await accounting.ensureDefaultAccounts({ businessId, session });
      const byCentre = new Map();
      for (const c of charged) byCentre.set(c.asset.centre || "", round2((byCentre.get(c.asset.centre || "") || 0) + c.amount));
      for (const [centre, amount] of byCentre) if (amount > 0) lines.push(accounting.postingLine(accounts.get("5200"), accounting.paise(amount), 0, `Depreciation FY ${fy}`, centre));
      lines.push(accounting.postingLine(accounts.get("1590"), 0, accounting.paise(total), `Depreciation FY ${fy}`));
      await accounting.postJournalEntry({ businessId, userId, entryDate: b.endDate, sourceType: "DEPRECIATION", sourceId: null, sourceKey: key, description: `Depreciation for FY ${fy} (Companies Act, straight line)`, lines, session });
    }
    for (const c of charged) {
      c.asset.depreciation[c.asset.depreciation.length - 1].sourceKey = key;
      await c.asset.save({ session });
    }
    return { fy, posted: total > 0, total, sourceKey: key, assets: charged.map((c) => ({ assetNumber: c.asset.assetNumber, name: c.asset.name, amount: c.amount })) };
  });
};

// ------------------------------------------------------------------ disposal

const disposeAsset = async ({ businessId, userId, assetId, payload = {} }) =>
  withTransaction(async (session) => {
    const asset = await FixedAsset.findOne({ _id: assetId, businessId }).session(session);
    if (!asset) throw new AppError("Asset not found", 404);
    if (asset.status !== "IN_USE") throw new AppError("This asset is not in use", 409);
    const date = new Date(payload.date || Date.now());
    if (Number.isNaN(date.getTime()) || dayNo(date) < baseDay(asset)) throw new AppError("Enter the date it was sold or discarded (after it was put to use)", 400);
    const amount = round2(payload.amount || 0);
    if (amount < 0) throw new AppError("Enter what it was sold for (0 if discarded)", 400);
    const fy = fyLabel(date);
    const missing = pendingYears(asset, fy).filter((y) => y < fy);
    if (missing.length) throw new AppError(`Charge depreciation for FY ${missing[0]} first`, 409);
    asset.disposal = { date, amount, mode: amount > 0 ? (payload.mode === "CASH" ? "CASH" : "BANK") : "", note: String(payload.note || "").trim(), gainOrLoss: 0 };
    const b = fyBounds(fy);
    if (!asset.depreciation.some((d) => d.fy === fy)) {
      const dep = depreciationFor(asset, b.start, dayNo(date));
      const key = `FIXED_ASSET:${asset._id}:DEP:${fy}`;
      asset.depreciation.push({ fy, amount: dep, from: fromDayNo(Math.max(b.start, baseDay(asset))), to: date, sourceKey: key });
      if (dep > 0) await postFor({ asset, key, date, rows: [["5200", dep, 0], ["1590", 0, dep]], description: `Depreciation to sale: ${asset.assetNumber} ${asset.name}`, userId, session });
    }
    const accumulated = accumulatedOf(asset);
    const gain = round2(amount - (asset.cost - accumulated));
    asset.disposal.gainOrLoss = gain;
    asset.status = "DISPOSED";
    await asset.save({ session });
    const rows = [[cashOrBank(asset.disposal.mode), amount, 0], ["1590", accumulated, 0], ["1510", 0, asset.cost]];
    if (gain > 0) rows.push(["4100", 0, gain]);
    if (gain < 0) rows.push(["5210", -gain, 0]);
    await postFor({ asset, key: `FIXED_ASSET:${asset._id}:DISPOSED`, date, rows, description: `${amount > 0 ? "Sale" : "Discard"} of ${asset.assetNumber} ${asset.name}`, userId, session });
    return asset.toObject();
  });

// ------------------------------------------------------------------ register (Companies Act) and tax block

const assetRegister = async ({ businessId, fy }) => {
  const b = fyBounds(fy);
  const assets = await FixedAsset.find({ businessId, status: { $ne: "CANCELLED" } }).sort({ assetNumber: 1 }).lean();
  const rows = [];
  for (const a of assets) {
    const base = baseDay(a);
    if (base > b.end) continue;
    const disposedDay = a.disposal?.date ? dayNo(a.disposal.date) : null;
    if (disposedDay !== null && disposedDay < b.start) continue;
    const isOpening = base < b.start || (a.source === "OPENING" && fyLabel(fromDayNo(base)) === fy);
    const record = (a.depreciation || []).find((d) => d.fy === fy);
    const yearDep = record ? record.amount : depreciationFor(a, b.start, b.end);
    const accOpening = isOpening ? round2(Number(a.openingAccumulated || 0) + (a.depreciation || []).filter((d) => d.fy < fy).reduce((s, d) => s + d.amount, 0)) : 0;
    const disposed = disposedDay !== null && disposedDay <= b.end;
    const grossOpening = isOpening ? a.cost : 0;
    const additions = isOpening ? 0 : a.cost;
    const deletions = disposed ? a.cost : 0;
    const accOnDeletion = disposed ? round2(accOpening + yearDep) : 0;
    const accClosing = round2(accOpening + yearDep - accOnDeletion);
    rows.push({
      assetId: a._id, assetNumber: a.assetNumber, name: a.name, assetClass: a.assetClass, classLabel: ASSET_CLASSES[a.assetClass]?.label || a.assetClass, centre: a.centre,
      putToUseDate: a.putToUseDate, usefulLifeYears: a.usefulLifeYears, leaseEndDate: a.leaseEndDate,
      grossOpening, additions, deletions, grossClosing: round2(grossOpening + additions - deletions),
      accOpening, yearDep: round2(yearDep), charged: Boolean(record), accOnDeletion, accClosing,
      netOpening: round2(grossOpening - accOpening), netClosing: round2(grossOpening + additions - deletions - accClosing),
      disposal: disposed ? a.disposal : null,
      note: a.assetClass === "FIT_OUT" && !a.leaseEndDate ? "Fit-out without a lease end date: written off over the class life" : "",
    });
  }
  const byClass = new Map();
  const keys = ["grossOpening", "additions", "deletions", "grossClosing", "accOpening", "yearDep", "accOnDeletion", "accClosing", "netOpening", "netClosing"];
  for (const r of rows) {
    const t = byClass.get(r.assetClass) || { assetClass: r.assetClass, classLabel: r.classLabel, ...Object.fromEntries(keys.map((k) => [k, 0])) };
    for (const k of keys) t[k] = round2(t[k] + r[k]);
    byClass.set(r.assetClass, t);
  }
  const totals = Object.fromEntries(keys.map((k) => [k, round2(rows.reduce((s, r) => s + r[k], 0))]));
  const charged = rows.length > 0 && rows.every((r) => r.charged || r.yearDep === 0);
  return { fy, rows, classes: [...byClass.values()], totals, depreciationCharged: charged };
};

const itBlocks = async ({ businessId, fy }) => {
  const target = fyBounds(fy);
  const assets = await FixedAsset.find({ businessId, status: { $ne: "CANCELLED" } }).lean();
  if (!assets.length) return { fy, blocks: [], notes: [] };
  const notes = [];
  let year = assets.map((a) => fyLabel(fromDayNo(baseDay(a)))).sort()[0];
  let closing = new Map();
  let result = [];
  while (year <= fy) {
    const b = fyBounds(year);
    const blocks = new Map();
    const block = (rate) => {
      if (!blocks.has(rate)) blocks.set(rate, { rate, name: IT_BLOCK_NAMES[rate] || `Block at ${rate}%`, opening: closing.get(rate) || 0, addFull: 0, addHalf: 0, sales: 0, assets: [] });
      return blocks.get(rate);
    };
    for (const [rate] of closing) block(rate);
    for (const a of assets) {
      const base = baseDay(a);
      if (a.source === "OPENING") {
        if (fyLabel(fromDayNo(base)) === year) {
          const wdv = a.openingItWdv ?? round2(a.cost - Number(a.openingAccumulated || 0));
          if (a.openingItWdv === null || a.openingItWdv === undefined) notes.push(`${a.assetNumber}: no tax WDV given at the start; the book value is used.`);
          block(a.itRate).opening = round2(block(a.itRate).opening + wdv);
        }
      } else if (base >= b.start && base <= b.end) {
        const daysUsed = b.end - base + 1;
        const row = block(a.itRate);
        if (daysUsed >= 180) row.addFull = round2(row.addFull + a.cost); else row.addHalf = round2(row.addHalf + a.cost);
        row.assets.push({ assetNumber: a.assetNumber, name: a.name, cost: a.cost, putToUseDate: a.putToUseDate, half: daysUsed < 180 });
      }
      if (a.disposal?.date && dayNo(a.disposal.date) >= b.start && dayNo(a.disposal.date) <= b.end) {
        const row = block(a.itRate);
        row.sales = round2(row.sales + Number(a.disposal.amount || 0));
      }
    }
    closing = new Map();
    result = [];
    for (const row of [...blocks.values()].sort((x, y) => x.rate - y.rate)) {
      let full = round2(row.opening + row.addFull - row.sales);
      let half = row.addHalf;
      let gain = 0;
      if (full < 0) { half = round2(half + full); full = 0; }
      if (half < 0) { gain = -half; half = 0; }
      const dep = round2(full * row.rate / 100 + half * row.rate / 200);
      const close = round2(full + half - dep);
      closing.set(row.rate, close);
      result.push({ ...row, wdvBeforeDep: round2(full + half), depreciation: dep, closing: close, shortTermGain: round2(gain) });
    }
    year = nextFy(year);
  }
  if (result.some((r) => r.shortTermGain > 0)) notes.push("A block's sales are more than its value: the excess is a short-term capital gain (s.50).");
  return { fy, from: fromDayNo(target.start), to: target.endDate, blocks: result, notes: [...new Set(notes)] };
};

const listAssets = async ({ businessId, status }) => {
  const filter = { businessId };
  if (status) filter.status = String(status).toUpperCase();
  return FixedAsset.find(filter).sort({ assetNumber: -1 }).lean();
};

module.exports = { ASSET_CLASSES, IT_BLOCK_NAMES, assetRegister, cancelAsset, createAsset, depreciationFor, disposeAsset, fyBounds, itBlocks, listAssets, runDepreciation };
