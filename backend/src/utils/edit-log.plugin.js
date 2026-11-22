// Mongoose plugin: writes every create / change / delete of a book record to the EditLog,
// in the same database session (so a rolled-back transaction leaves no log line behind).
// Covers document save, deleteOne, insertMany, and the query updates / deletes. Writes made
// with raw collection calls or bulkWrite are not seen; book code does not use them.
const mongoose = require("mongoose");
const context = require("./request-context");

const SKIP = new Set(["updatedAt", "createdAt", "__v"]);
const MAX_VALUE = 4000;
const MAX_DOCS = 200;

const plain = (value) => {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const text = JSON.stringify(value, (key, v) => (v && v._bsontype === "ObjectId" ? String(v) : v));
    if (text && text.length > MAX_VALUE) return `${text.slice(0, MAX_VALUE)}... (cut)`;
    return text === undefined ? null : JSON.parse(text);
  }
  return value;
};
const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

const getPath = (obj, path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), obj);
const topPaths = (paths) => paths.filter((p) => !SKIP.has(p.split(".")[0])).filter((p) => !paths.some((other) => other !== p && p.startsWith(`${other}.`)));

const diff = (before, after) => {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const key of keys) {
    if (SKIP.has(key) || key === "_id") continue;
    if (!same(before?.[key], after?.[key])) changes.push({ path: key, before: plain(before?.[key]), after: plain(after?.[key]) });
  }
  return changes;
};

const labelOf = (doc) =>
  String(doc?.invoiceNumber || doc?.expenseNumber || doc?.purchaseNumber || doc?.depositNumber || doc?.assetNumber || doc?.entryNumber || doc?.creditNoteNumber || doc?.returnNumber || doc?.referenceNumber || doc?.name || doc?.supplierName || doc?.code || "").slice(0, 120);

const write = async (entries, session) => {
  if (!entries.length) return;
  const EditLog = require("../models/EditLog");
  const who = context.get() || {};
  const rows = entries.map((entry) => ({
    ...entry,
    userId: who.userId || null,
    userEmail: who.userEmail || (who.requestId ? "" : "system"),
    userName: who.userName || "",
    ip: who.ip || "",
    requestId: who.requestId || "",
    at: new Date(),
  }));
  await EditLog.insertMany(rows, session ? { session } : {});
};

module.exports = function editLogPlugin(schema, { model, businessKey = "businessId" }) {
  const businessOf = (doc) => (businessKey === "_id" ? doc?._id : doc?.[businessKey]) || null;
  const snapshotOf = (doc) => plain(typeof doc.toObject === "function" ? doc.toObject({ depopulate: true }) : doc);

  schema.post("init", function () {
    this.$locals.editLogBefore = this.toObject({ depopulate: true });
  });

  schema.pre("save", function () {
    this.$locals.editLogNew = this.isNew;
    this.$locals.editLogPaths = this.isNew ? [] : topPaths(this.modifiedPaths());
  });

  schema.post("save", async function (doc) {
    const session = doc.$session();
    if (doc.$locals.editLogNew) {
      await write([{ businessId: businessOf(doc), model, recordId: doc._id, recordLabel: labelOf(doc), action: "CREATE", snapshot: snapshotOf(doc) }], session);
    } else {
      const before = doc.$locals.editLogBefore || {};
      const changes = (doc.$locals.editLogPaths || [])
        .map((path) => ({ path, before: plain(getPath(before, path)), after: plain(doc.get(path)) }))
        .filter((c) => !same(c.before, c.after));
      if (changes.length) await write([{ businessId: businessOf(doc), model, recordId: doc._id, recordLabel: labelOf(doc), action: "UPDATE", changes }], session);
    }
    doc.$locals.editLogBefore = doc.toObject({ depopulate: true });
    doc.$locals.editLogNew = false;
  });

  schema.post("insertMany", async function (docs) {
    // insertMany gives each new document the call's session
    const session = (docs[0] && typeof docs[0].$session === "function" && docs[0].$session()) || null;
    await write(docs.map((doc) => ({ businessId: businessOf(doc), model, recordId: doc._id, recordLabel: labelOf(doc), action: "CREATE", snapshot: snapshotOf(doc) })), session);
  });

  // query updates: read the records before and after, and log what changed on each
  const beforeQuery = async function () {
    const session = this.getOptions().session || null;
    const docs = await this.model.find(this.getFilter()).limit(MAX_DOCS + 1).session(session).lean();
    this.$editLog = { docs, session, update: this.getUpdate() };
  };
  const afterUpdate = async function () {
    const state = this.$editLog;
    if (!state || !state.docs.length) return;
    const { docs, session } = state;
    if (docs.length > MAX_DOCS) {
      await write(docs.slice(0, MAX_DOCS).map((doc) => ({ businessId: businessOf(doc), model, recordId: doc._id, recordLabel: labelOf(doc), action: "UPDATE", update: plain(state.update) })), session);
      return;
    }
    const after = new Map((await this.model.find({ _id: { $in: docs.map((d) => d._id) } }).session(session).lean()).map((d) => [String(d._id), d]));
    const entries = [];
    for (const doc of docs) {
      const now = after.get(String(doc._id));
      if (!now) continue;
      const changes = diff(doc, now);
      if (changes.length) entries.push({ businessId: businessOf(now), model, recordId: doc._id, recordLabel: labelOf(now), action: "UPDATE", changes });
    }
    await write(entries, session);
  };
  const afterDelete = async function () {
    const state = this.$editLog;
    if (!state || !state.docs.length) return;
    const gone = new Set((await this.model.find({ _id: { $in: state.docs.map((d) => d._id) } }).session(state.session).select("_id").lean()).map((d) => String(d._id)));
    await write(state.docs.filter((doc) => !gone.has(String(doc._id))).map((doc) => ({ businessId: businessOf(doc), model, recordId: doc._id, recordLabel: labelOf(doc), action: "DELETE", snapshot: plain(doc) })), state.session);
  };

  // updateOne / deleteOne are both query and document middleware; only the query form here
  const queryOnly = { document: false, query: true };
  schema.pre("updateOne", queryOnly, beforeQuery);
  schema.post("updateOne", queryOnly, afterUpdate);
  schema.pre(["updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"], beforeQuery);
  schema.post(["updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"], afterUpdate);
  schema.pre("deleteOne", queryOnly, beforeQuery);
  schema.post("deleteOne", queryOnly, afterDelete);
  schema.pre(["deleteMany", "findOneAndDelete"], beforeQuery);
  schema.post(["deleteMany", "findOneAndDelete"], afterDelete);

  // doc.deleteOne()
  schema.post("deleteOne", { document: true, query: false }, async function (doc) {
    await write([{ businessId: businessOf(doc), model, recordId: doc._id, recordLabel: labelOf(doc), action: "DELETE", snapshot: snapshotOf(doc) }], doc.$session());
  });
};

module.exports.MAX_DOCS = MAX_DOCS;
