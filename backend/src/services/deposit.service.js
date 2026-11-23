// Refundable deposits (phase 5). RECEIVED: Dr bank / cash, Cr 2410 Security Deposits Received.
// GIVEN: Dr 1210 Security Deposits Given, Cr bank / cash. Movements:
//   RECEIVED  REFUND   Dr 2410 / Cr bank      FORFEIT  Dr 2410 / Cr 4100 Other income
//   GIVEN     REFUND   Dr bank / Cr 1210      ADJUST_RENT  Dr 5020 Rent / Cr 1210
//             WRITE_OFF Dr 5210 / Cr 1210
//   RECEIVED  SET_OFF  the deposit pays the customer's unpaid invoices: a receipt with method
//             DEPOSIT_SET_OFF (Dr 2410 / Cr 2100 advances) allocated to them (Dr 2100 / Cr 1100), so
//             the invoices, the customer's ledger and statements show it like any payment.
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
const live = (movements) => (movements || []).filter((m) => !m.undoneAt);
const balanceOf = (deposit) => round2(deposit.amount - live(deposit.movements).reduce((s, m) => s + m.amount, 0));

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
const MOVE_LABEL = { REFUND: "refunded", FORFEIT: "forfeited", ADJUST_RENT: "adjusted against rent", WRITE_OFF: "written off", SET_OFF: "set off against invoices" };

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
    // An undone set-off stays in the history but no longer counts.
    const counted = moves.filter((m) => !(m.undoneAt && new Date(m.undoneAt) <= cut));
    const balance = round2(d.amount - counted.reduce((s, m) => s + m.amount, 0));
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

// ---------------------------------------------------------------------------
// Set-off (client answer D15a): a tenant's deposit pays their unpaid invoices.
// ---------------------------------------------------------------------------

/** The customer's invoices that a deposit can pay: issued, money still due. */
const setOffCandidates = async ({ businessId, depositId, customerId }) => {
  const deposit = await Deposit.findOne({ _id: depositId, businessId }).lean();
  if (!deposit) throw new AppError("Deposit not found", 404);
  // A deposit entered without a customer: the page asks whose it is first.
  const whose = deposit.customerId || (customerId && mongoose.isValidObjectId(customerId) ? customerId : null);
  if (!whose) return { deposit: { ...deposit, balance: balanceOf(deposit) }, invoices: [] };
  const Invoice = require("../models/Invoice");
  const invoices = await Invoice.find({ businessId, customerId: whose, status: { $nin: ["cancelled", "draft"] }, balanceDue: { $gt: 0 } })
    .sort({ invoiceDate: 1 }).select("invoiceNumber invoiceDate dueDate grandTotal balanceDue paymentStatus").lean();
  return { deposit: { ...deposit, balance: balanceOf(deposit) }, invoices };
};

/**
 * Pays invoices out of a deposit received. allocations: [{ invoiceId, amount }].
 * Order of work keeps the deposit and the books in step: the receipt (Dr 2410) and the deposit's
 * SET_OFF movement first, then the allocations; if an allocation fails, the money waits as the
 * customer's advance (Payments) and can be allocated there.
 */
const setOffAgainstInvoices = async ({ businessId, userId, depositId, payload = {} }) => {
  const Invoice = require("../models/Invoice");
  const paymentService = require("./payment.service");
  const date = parseDate(payload.date, "set-off date");
  const wanted = (Array.isArray(payload.allocations) ? payload.allocations : [])
    .map((a) => ({ invoiceId: String(a.invoiceId || ""), amount: round2(a.amount) }))
    .filter((a) => a.invoiceId && a.amount > 0);
  if (!wanted.length) throw new AppError("Choose the invoices to pay from the deposit", 400);
  if (new Set(wanted.map((a) => a.invoiceId)).size !== wanted.length) throw new AppError("An invoice is listed twice", 400);

  const deposit = await Deposit.findOne({ _id: depositId, businessId });
  if (!deposit) throw new AppError("Deposit not found", 404);
  if (deposit.direction !== "RECEIVED") throw new AppError("Only a deposit received from a customer can pay their invoices", 400);
  if (deposit.status !== "OPEN") throw new AppError("This deposit is closed", 409);
  if (!deposit.customerId && payload.customerId) {
    // An older deposit typed with a name only: link it to the customer now (kept for next time).
    const customer = mongoose.isValidObjectId(payload.customerId) ? await Customer.findOne({ _id: payload.customerId, businessId }).select("_id").lean() : null;
    if (!customer) throw new AppError("Customer not found", 404);
    deposit.customerId = customer._id;
    await deposit.save();
  }
  if (!deposit.customerId) throw new AppError("Choose whose deposit this is (the customer), then set it off", 400);
  if (date < deposit.date) throw new AppError("The date is before the deposit", 400);

  const invoices = await Invoice.find({ _id: { $in: wanted.map((a) => a.invoiceId) }, businessId }).select("invoiceNumber customerId balanceDue status").lean();
  const byId = new Map(invoices.map((inv) => [String(inv._id), inv]));
  for (const a of wanted) {
    const inv = byId.get(a.invoiceId);
    if (!inv) throw new AppError("Invoice not found", 404);
    if (String(inv.customerId) !== String(deposit.customerId)) throw new AppError(`Invoice ${inv.invoiceNumber} is not ${deposit.partyName}'s`, 400);
    if (["cancelled", "draft"].includes(inv.status)) throw new AppError(`Invoice ${inv.invoiceNumber} is ${inv.status}`, 400);
    if (a.amount > round2(inv.balanceDue) + 0.004) throw new AppError(`Only ${round2(inv.balanceDue)} is due on invoice ${inv.invoiceNumber}`, 400);
    a.invoiceNumber = inv.invoiceNumber;
  }
  const total = round2(wanted.reduce((s, a) => s + a.amount, 0));
  if (total > balanceOf(deposit) + 0.004) throw new AppError(`Only ${balanceOf(deposit)} is left on this deposit`, 400);

  const note = String(payload.note || "").trim();
  const payment = await paymentService.createPayment({
    businessId,
    userId,
    payload: {
      direction: "RECEIVED", customerId: deposit.customerId, amount: total, paymentDate: date, paymentMethod: "DEPOSIT_SET_OFF",
      referenceNumber: deposit.depositNumber, notes: `Paid from deposit ${deposit.depositNumber}${note ? `: ${note}` : ""}`,
      idempotencyKey: payload.idempotencyKey ? `DEPOSIT_SETOFF:${deposit._id}:${String(payload.idempotencyKey).slice(0, 60)}` : "",
    },
  });

  // Record it on the deposit (once, even if the same request comes twice).
  const already = await Deposit.findOne({ _id: deposit._id, "movements.paymentId": payment._id }).lean();
  if (!already) {
    const updated = await Deposit.findOneAndUpdate(
      { _id: deposit._id, businessId, status: "OPEN" },
      { $push: { movements: { kind: "SET_OFF", amount: total, date, mode: "", note, createdBy: userId, paymentId: payment._id, invoices: wanted.map(({ invoiceId, invoiceNumber, amount }) => ({ invoiceId, invoiceNumber, amount })) } } },
      { new: true },
    );
    if (!updated) throw new AppError("This deposit was closed meanwhile; the receipt is in Payments as the customer's advance", 409);
    if (balanceOf(updated) <= 0.004) await Deposit.updateOne({ _id: deposit._id }, { $set: { status: "CLOSED" } });
  }

  const failed = [];
  for (const a of wanted) {
    try {
      await paymentService.allocatePayment({ businessId, userId, paymentId: payment._id, payload: { invoiceId: a.invoiceId, allocatedAmount: a.amount } });
    } catch (error) {
      failed.push({ invoiceNumber: a.invoiceNumber, message: error.message });
    }
  }
  return { deposit: (await Deposit.findById(deposit._id)).toObject(), paymentId: payment._id, total, failed };
};

/** Undoes a set-off: the invoices are due again and the deposit holds the money again. */
const undoSetOff = async ({ businessId, userId, depositId, movementId, reason = "" }) => {
  const paymentService = require("./payment.service");
  const PaymentAllocation = require("../models/PaymentAllocation");
  const deposit = await Deposit.findOne({ _id: depositId, businessId });
  if (!deposit) throw new AppError("Deposit not found", 404);
  const move = deposit.movements.id(movementId);
  if (!move || move.kind !== "SET_OFF") throw new AppError("Set-off not found on this deposit", 404);
  if (move.undoneAt) return deposit.toObject();

  const allocations = await PaymentAllocation.find({ businessId, paymentId: move.paymentId }).lean();
  for (const allocation of allocations) {
    try {
      await paymentService.reverseAllocation({ businessId, userId, allocationId: allocation._id, reason: `Set-off from deposit ${deposit.depositNumber} undone` });
    } catch (error) {
      if (!/already been reversed|fully reversed/i.test(error.message)) throw error;
    }
  }
  await paymentService.reversePayment({ businessId, userId, paymentId: move.paymentId, reason: reason || `Set-off from deposit ${deposit.depositNumber} undone`, fromDeposit: true });
  move.undoneAt = new Date();
  move.undoneBy = userId;
  if (deposit.status === "CLOSED" && balanceOf(deposit) > 0.004) deposit.status = "OPEN";
  await deposit.save();
  return deposit.toObject();
};

module.exports = { addMovement, cancelDeposit, createDeposit, depositRegister, setOffAgainstInvoices, setOffCandidates, undoSetOff };
