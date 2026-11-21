// Refundable deposits (phase 5). RECEIVED: Dr bank / cash, Cr 2410 Security Deposits Received.
// GIVEN: Dr 1210 Security Deposits Given, Cr bank / cash. Movements:
//   RECEIVED  REFUND   Dr 2410 / Cr bank      FORFEIT  Dr 2410 / Cr 4100 Other income
//   GIVEN     REFUND   Dr bank / Cr 1210      ADJUST_RENT  Dr 5020 Rent / Cr 1210
//             WRITE_OFF Dr 5210 / Cr 1210
const mongoose = require("mongoose");
const AppError = require("../utils/appError");
const Deposit = require("../models/Deposit");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");
const accounting = require("./accounting.service");
const { fyLabel } = require("../utils/invoice");

const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const cashOrBank = (mode) => (mode === "CASH" ? "1010" : "1020");
const parseDate = (value, label) => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) throw new AppError(`Enter a valid ${label}`, 400);
  return d;
};
const balanceOf = (deposit) => round2(deposit.amount - (deposit.movements || []).reduce((s, m) => s + m.amount, 0));

const MOVES = {
  RECEIVED: {
    REFUND: (amt, mode) => [["2410", amt, 0], [cashOrBank(mode), 0, amt]],
    FORFEIT: (amt) => [["2410", amt, 0], ["4100", 0, amt]],
  },
  GIVEN: {
    REFUND: (amt, mode) => [[cashOrBank(mode), amt, 0], ["1210", 0, amt]],
    ADJUST_RENT: (amt) => [["5020", amt, 0], ["1210", 0, amt]],
    WRITE_OFF: (amt) => [["5210", amt, 0], ["1210", 0, amt]],
  },
};
const MOVE_LABEL = { REFUND: "refunded", FORFEIT: "forfeited", ADJUST_RENT: "adjusted against rent", WRITE_OFF: "written off" };

const post = async ({ deposit, key, date, rows, description, userId, session }) => {
  const accounts = await accounting.ensureDefaultAccounts({ businessId: deposit.businessId, session });
  const lines = rows.map(([code, dr, cr]) => accounting.postingLine(accounts.get(code), accounting.paise(dr), accounting.paise(cr), description, deposit.centre || ""));
  return accounting.postJournalEntry({ businessId: deposit.businessId, userId, entryDate: date, sourceType: "DEPOSIT", sourceId: deposit._id, sourceKey: key, description, lines, session });
};

const nextNumber = async ({ businessId, direction, date, session }) => {
  const prefix = `${direction === "RECEIVED" ? "DR" : "DG"}/${fyLabel(date)}/`;
  const last = await Deposit.findOne({ businessId, depositNumber: { $regex: `^${prefix.replace(/\//g, "\\/")}` } }).sort({ depositNumber: -1 }).session(session).lean();
  const n = last ? Number(last.depositNumber.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(4, "0")}`;
};

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

const createDeposit = async ({ businessId, userId, payload = {} }) => {
  const direction = String(payload.direction || "").toUpperCase();
  if (!["RECEIVED", "GIVEN"].includes(direction)) throw new AppError("Choose whether the deposit was received or given", 400);
  const amount = round2(payload.amount);
  if (!(amount > 0)) throw new AppError("Enter the deposit amount", 400);
  const date = parseDate(payload.date, "deposit date");
  const mode = payload.mode === "CASH" ? "CASH" : "BANK";
  let partyName = String(payload.partyName || "").trim();
  let customerId = null;
  let supplierId = null;
  if (payload.customerId) {
    const c = await Customer.findOne({ _id: payload.customerId, businessId }).select("name").lean();
    if (!c) throw new AppError("Customer not found", 404);
    customerId = c._id; partyName = partyName || c.name;
  }
  if (payload.supplierId) {
    const s = await Supplier.findOne({ _id: payload.supplierId, businessId }).select("supplierName").lean();
    if (!s) throw new AppError("Supplier not found", 404);
    supplierId = s._id; partyName = partyName || s.supplierName;
  }
  if (!partyName) throw new AppError("Enter who the deposit is from or to", 400);

  return withTransaction(async (session) => {
    const depositNumber = await nextNumber({ businessId, direction, date, session });
    const [deposit] = await Deposit.create([{
      businessId, depositNumber, direction, customerId, supplierId, partyName,
      purpose: ["RENT", "SECURITY", "UTILITY", "OTHER"].includes(payload.purpose) ? payload.purpose : "SECURITY",
      amount, date, mode, reference: String(payload.reference || "").trim(),
      agreementEnd: payload.agreementEnd ? parseDate(payload.agreementEnd, "agreement end") : null,
      centre: String(payload.centre || "").trim(), note: String(payload.note || "").trim(), createdBy: userId,
    }], { session });
    const description = `Deposit ${direction === "RECEIVED" ? "received from" : "paid to"} ${partyName} (${depositNumber})`;
    const rows = direction === "RECEIVED" ? [[cashOrBank(mode), amount, 0], ["2410", 0, amount]] : [["1210", amount, 0], [cashOrBank(mode), 0, amount]];
    await post({ deposit, key: `DEPOSIT:${deposit._id}:POSTED`, date, rows, description, userId, session });
    return deposit.toObject();
  });
};

const addMovement = async ({ businessId, userId, depositId, payload = {} }) => {
  const kind = String(payload.kind || "").toUpperCase();
  const amount = round2(payload.amount);
  const date = parseDate(payload.date, "date");
  return withTransaction(async (session) => {
    const deposit = await Deposit.findOne({ _id: depositId, businessId }).session(session);
    if (!deposit) throw new AppError("Deposit not found", 404);
    if (deposit.status !== "OPEN") throw new AppError("This deposit is closed", 409);
    const build = MOVES[deposit.direction][kind];
    if (!build) throw new AppError(`A ${deposit.direction === "RECEIVED" ? "deposit received" : "deposit given"} can be ${Object.keys(MOVES[deposit.direction]).map((k) => MOVE_LABEL[k]).join(" or ")}`, 400);
    if (!(amount > 0)) throw new AppError("Enter the amount", 400);
    if (amount > balanceOf(deposit) + 0.004) throw new AppError(`Only ${balanceOf(deposit)} is left on this deposit`, 400);
    if (date < deposit.date) throw new AppError("The date is before the deposit", 400);
    const mode = payload.mode === "CASH" ? "CASH" : "BANK";
    deposit.movements.push({ kind, amount, date, mode: kind === "REFUND" ? mode : "", note: String(payload.note || "").trim(), createdBy: userId });
    const move = deposit.movements[deposit.movements.length - 1];
    if (balanceOf(deposit) <= 0.004) deposit.status = "CLOSED";
    await deposit.save({ session });
    await post({ deposit, key: `DEPOSIT:${deposit._id}:MOVE:${move._id}`, date, rows: build(amount, mode), description: `Deposit ${deposit.depositNumber} ${MOVE_LABEL[kind]} (${deposit.partyName})`, userId, session });
    return deposit.toObject();
  });
};

// A deposit entered by mistake (nothing refunded or adjusted yet) is cancelled with a reversal.
const cancelDeposit = async ({ businessId, userId, depositId }) =>
  withTransaction(async (session) => {
    const deposit = await Deposit.findOne({ _id: depositId, businessId }).session(session);
    if (!deposit) throw new AppError("Deposit not found", 404);
    if (deposit.status === "CANCELLED") return deposit.toObject();
    if (deposit.movements.length) throw new AppError("This deposit has refunds or adjustments; it cannot be cancelled", 409);
    deposit.status = "CANCELLED";
    await deposit.save({ session });
    await accounting.reverseRecordPostings({ businessId, keyType: "DEPOSIT", recordId: deposit._id, cancelKey: `DEPOSIT_CANCEL:${deposit._id}`, label: `Deposit ${deposit.depositNumber} cancelled`, userId, entryDate: deposit.date, session });
    return deposit.toObject();
  });

// Register as on a day: what is held / owed per party, with what happened to each deposit.
const depositRegister = async ({ businessId, direction, asOf }) => {
  const filter = { businessId, status: { $ne: "CANCELLED" } };
  if (direction) filter.direction = String(direction).toUpperCase();
  const cut = asOf ? new Date(`${asOf}T23:59:59.999+05:30`) : new Date();
  filter.date = { $lte: cut };
  const rows = (await Deposit.find(filter).sort({ date: 1 }).lean()).map((d) => {
    const moves = (d.movements || []).filter((m) => new Date(m.date) <= cut);
    const balance = round2(d.amount - moves.reduce((s, m) => s + m.amount, 0));
    return { ...d, balance, movements: moves };
  });
  const sum = (dir) => round2(rows.filter((r) => r.direction === dir).reduce((s, r) => s + r.balance, 0));
  const soon = new Date(cut.getTime() + 60 * 86400000);
  return {
    asOf: asOf || new Date().toISOString().slice(0, 10),
    rows,
    totals: { received: sum("RECEIVED"), given: sum("GIVEN") },
    endingSoon: rows.filter((r) => r.balance > 0 && r.agreementEnd && new Date(r.agreementEnd) <= soon),
  };
};

module.exports = { addMovement, cancelDeposit, createDeposit, depositRegister };
