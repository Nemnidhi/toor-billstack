const mongoose = require("mongoose");
const Account = require("../models/Account");
const JournalEntry = require("../models/JournalEntry");
const AppError = require("../utils/appError");
const { fromMinorUnits } = require("../utils/money");
const { resolveIndianPeriod } = require("../utils/indian-fy");
const { listEntities, resolveEntityUser } = require("./billing-entity.service");
const { getTagLists } = require("./reporting-tags.service");

// Business line x category report (client, 23 Nov 2026: "a report where I can see both").
// Rows: business line, or company. Columns: category. Cells: income, expenses or profit, read
// from the posted journal (the same numbers as the P&L), with each cell's share of the total.
// Scope: one company, or every company the person can see the accounts of (personal books only
// when asked for by id - they never mix into company totals).

const ALLOWED = ["owner", "admin", "accountant", "auditor"];
const NOT_SET = "__not_set__";
const DIMENSIONS = ["businessLine", "reportCategory", "company"];
const MEASURES = ["income", "expenses", "profit"];

/** The companies the report reads, after checking the person may see each one's accounts. */
const scopeEntities = async (user, entity) => {
  const all = await listEntities(user);
  const requested = String(entity || "").trim();
  let picked;
  if (!requested || requested === "current") picked = all.filter((e) => String(e.id) === String(user.businessId));
  else if (["all", "group"].includes(requested.toLowerCase())) picked = all.filter((e) => e.kind !== "PERSONAL");
  // As the consolidated statements: the primary company and Goldhawk.
  else if (requested.toLowerCase() === "consolidated") picked = all.filter((e) => e.isPrimary || e.billingEntityCode === "GOLDHAWK");
  else if (mongoose.isValidObjectId(requested)) picked = all.filter((e) => String(e.id) === requested);
  else if (requested.toUpperCase() === "TOOR") picked = all.filter((e) => e.isPrimary);
  else picked = all.filter((e) => String(e.billingEntityCode || "").toUpperCase() === requested.toUpperCase());
  if (!picked.length) throw new AppError("You do not have access to that business", 403);
  const allowed = [];
  for (const e of picked) {
    const scoped = await resolveEntityUser(user, e.id);
    if (ALLOWED.includes(scoped.role)) allowed.push(e);
  }
  if (!allowed.length) throw new AppError("You do not have permission to see the accounts of that business", 403);
  return allowed;
};

const pct = (part, whole) => (whole ? Math.round((part / whole) * 10000) / 100 : 0);

const getTagMatrix = async ({ user, query = {} }) => {
  const rowsBy = DIMENSIONS.includes(query.rows) ? query.rows : "businessLine";
  const columnsBy = DIMENSIONS.includes(query.columns) ? query.columns : "reportCategory";
  if (rowsBy === columnsBy) throw new AppError("Rows and columns must be different", 400);
  const measure = MEASURES.includes(query.measure) ? query.measure : "profit";
  const period = resolveIndianPeriod(query);
  const entities = await scopeEntities(user, query.entity);
  const ids = entities.map((e) => new mongoose.Types.ObjectId(String(e.id)));
  const nameOf = new Map(entities.map((e) => [String(e.id), e.name]));

  const accounts = await Account.find({ businessId: { $in: ids }, type: { $in: ["INCOME", "EXPENSE"] } }).select("_id type").lean();
  const typeOf = new Map(accounts.map((a) => [String(a._id), a.type]));

  const match = { businessId: { $in: ids }, status: "POSTED" };
  if (period.fromDate || period.toDate) {
    match.entryDate = {};
    if (period.fromDate) match.entryDate.$gte = period.fromDate;
    if (period.toDate) match.entryDate.$lte = period.toDate;
  }
  const entries = await JournalEntry.find(match).select("businessId lines").lean();

  const keyOf = (dim, line, businessId) => (dim === "company" ? String(businessId) : String(line[dim] || "").trim() || NOT_SET);
  const cells = new Map(); // row|col -> {income, expenses} in paise
  for (const entry of entries) {
    for (const line of entry.lines || []) {
      const type = typeOf.get(String(line.accountId));
      if (!type) continue;
      const key = `${keyOf(rowsBy, line, entry.businessId)}\u0000${keyOf(columnsBy, line, entry.businessId)}`;
      const cell = cells.get(key) || { income: 0, expenses: 0 };
      if (type === "INCOME") cell.income += (line.creditMinor || 0) - (line.debitMinor || 0);
      else cell.expenses += (line.debitMinor || 0) - (line.creditMinor || 0);
      cells.set(key, cell);
    }
  }
  const valueOf = (cell) => (measure === "income" ? cell.income : measure === "expenses" ? cell.expenses : cell.income - cell.expenses);

  // Labels in the order of the group's lists (archived names too, when they carry amounts), then
  // anything else in use, then "Not set" last.
  const lists = await getTagLists(user.businessId);
  const listFor = (dim) => (dim === "businessLine" ? lists.businessLines : dim === "reportCategory" ? lists.categories : entities.map((e) => ({ name: String(e.id), archived: false })));
  const keysUsed = (pos) => new Set([...cells.keys()].map((k) => k.split("\u0000")[pos]));
  const ordered = (dim, pos) => {
    const used = keysUsed(pos);
    const fromList = listFor(dim).filter((item) => !item.archived || used.has(item.name)).map((item) => item.name);
    const extra = [...used].filter((k) => k !== NOT_SET && !fromList.includes(k)).sort();
    const keys = [...fromList, ...extra];
    if (used.has(NOT_SET)) keys.push(NOT_SET);
    return keys.map((key) => ({
      key,
      label: key === NOT_SET ? "Not set" : dim === "company" ? nameOf.get(key) || key : key,
      archived: Boolean(listFor(dim).find((item) => item.name === key)?.archived),
    }));
  };
  const rowKeys = ordered(rowsBy, 0);
  const colKeys = ordered(columnsBy, 1);

  let grand = 0;
  for (const cell of cells.values()) grand += valueOf(cell);
  const colTotals = new Map(colKeys.map((c) => [c.key, 0]));
  const rows = rowKeys.map((r) => {
    let total = 0;
    const values = colKeys.map((c) => {
      const cell = cells.get(`${r.key}\u0000${c.key}`);
      const v = cell ? valueOf(cell) : 0;
      total += v;
      colTotals.set(c.key, colTotals.get(c.key) + v);
      return { column: c.key, amount: fromMinorUnits(v), percentOfTotal: pct(v, grand) };
    });
    return { key: r.key, label: r.label, archived: r.archived, cells: values, total: fromMinorUnits(total), percentOfTotal: pct(total, grand) };
  });

  return {
    measure,
    rowsBy,
    columnsBy,
    period: { from: period.fromStr, to: period.toStr, label: period.periodLabel },
    companies: entities.map((e) => ({ id: e.id, name: e.name, kind: e.kind || "COMPANY" })),
    columns: colKeys.map((c) => ({ ...c, total: fromMinorUnits(colTotals.get(c.key)), percentOfTotal: pct(colTotals.get(c.key), grand) })),
    rows,
    total: fromMinorUnits(grand),
    notSetKey: NOT_SET,
  };
};

module.exports = { getTagMatrix, NOT_SET };
