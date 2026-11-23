const Business = require("../models/Business");
const AppError = require("../utils/appError");

// Two report tags on every invoice, expense, purchase and recurring profile, as the client asked
// (23 Nov 2026: "both horizontal and vertical categorisation"):
//   business line - the vertical one, e.g. Workspace / TOOR / Enterprise;
//   report category - the horizontal one, e.g. C1 / C2 / C3.
// One list of each for the whole company group, kept on the primary company, so the
// business line x category report lines up across TOOR, Goldhawk and the rest.
// Names are never renamed in place (journal lines are append-only): a name is archived and
// a new one added. Archived names stay valid on the documents that already carry them.

const MAX_ITEMS = 50;
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
const KIND = { businessLine: "businessLines", reportCategory: "categories" };
const LABEL = { businessLine: "business line", reportCategory: "category" };

/** The primary company of a group (where the lists live). */
const rootOf = async (businessId) => {
  const business = await Business.findById(businessId).select("billingParentId reportingTags");
  if (!business) throw new AppError("Business not found", 404);
  if (!business.billingParentId) return business;
  const root = await Business.findById(business.billingParentId).select("billingParentId reportingTags");
  return root || business;
};

const listOut = (rows = []) => rows.filter((row) => clean(row?.name)).map((row) => ({ name: clean(row.name), archived: Boolean(row.archived) }));

const getTagLists = async (businessId) => {
  const root = await rootOf(businessId);
  return {
    rootBusinessId: root._id,
    businessLines: listOut(root.reportingTags?.businessLines),
    categories: listOut(root.reportingTags?.categories),
  };
};

/**
 * Replaces both lists. A name can be added or archived (and brought back), never dropped: a name
 * in use somewhere must stay readable on old documents, so a missing name is kept as archived.
 */
const setTagLists = async (businessId, payload = {}) => {
  const root = await rootOf(businessId);
  const next = {};
  for (const kind of ["businessLines", "categories"]) {
    const given = Array.isArray(payload[kind]) ? payload[kind] : null;
    const current = listOut(root.reportingTags?.[kind]);
    if (!given) {
      next[kind] = current;
      continue;
    }
    const seen = new Map();
    for (const row of given) {
      const name = clean(typeof row === "string" ? row : row?.name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) throw new AppError(`"${name}" is in the list twice`, 400);
      seen.set(key, { name, archived: typeof row === "object" && Boolean(row?.archived) });
    }
    for (const row of current) if (!seen.has(row.name.toLowerCase())) seen.set(row.name.toLowerCase(), { name: row.name, archived: true });
    next[kind] = [...seen.values()];
    if (next[kind].length > MAX_ITEMS) throw new AppError(`At most ${MAX_ITEMS} names in a list`, 400);
  }
  await Business.updateOne({ _id: root._id }, { $set: { "reportingTags.businessLines": next.businessLines, "reportingTags.categories": next.categories } });
  return getTagLists(root._id);
};

/**
 * The tags to save on a document. A name must be in the group's list and not archived, unless the
 * document already carried it (an old document keeps an archived name when edited for something
 * else). Blank is always allowed. Only tags present in `body` are returned (an edit that leaves
 * them out keeps what the document has).
 */
const cleanTags = async (businessId, body = {}, previous = {}) => {
  const out = {};
  const present = Object.keys(KIND).filter((field) => body[field] !== undefined);
  if (!present.length) return out;
  // Only a new, non-blank name needs the group's lists (blank and unchanged names need no lookup).
  const needsCheck = present.some((field) => clean(body[field]) && clean(body[field]) !== clean(previous?.[field]));
  const lists = needsCheck ? await getTagLists(businessId) : null;
  for (const field of present) {
    const value = clean(body[field]);
    if (value && value !== clean(previous?.[field])) {
      const row = lists[KIND[field]].find((item) => item.name.toLowerCase() === value.toLowerCase());
      if (!row) throw new AppError(`"${value}" is not a ${LABEL[field]} yet. Add it in Settings > Business lines & categories first.`, 400);
      if (row.archived) throw new AppError(`The ${LABEL[field]} "${row.name}" is archived. Bring it back in Settings > Business lines & categories, or pick another.`, 400);
      out[field] = row.name;
    } else out[field] = value;
  }
  return out;
};

module.exports = { getTagLists, setTagLists, cleanTags, rootOf };
