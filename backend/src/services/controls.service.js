// Books controls (phase 4): period lock, the edit log viewer / export, the Goldhawk GST
// registration watch, and documents attached to bills and supplier / landlord records.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const AppError = require("../utils/appError");
const Business = require("../models/Business");
const EditLog = require("../models/EditLog");
const Invoice = require("../models/Invoice");
const Expense = require("../models/Expense");
const Purchase = require("../models/Purchase");
const Supplier = require("../models/Supplier");
const { fyLabel } = require("../utils/invoice");

// ------------------------------------------------------------------ period lock

const getPeriodLock = async ({ businessId }) => {
  const business = await Business.findById(businessId).select("name booksLock").populate("booksLock.lockedBy", "name email").lean();
  if (!business) throw new AppError("Business not found", 404);
  return { businessId, name: business.name, lockedUpTo: business.booksLock?.lockedUpTo || "", lockedBy: business.booksLock?.lockedBy || null, lockedAt: business.booksLock?.lockedAt || null };
};

const setPeriodLock = async ({ businessId, userId, lockedUpTo }) => {
  const value = String(lockedUpTo || "").trim();
  if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError("Pick the last day of the closed period", 400);
  const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
  if (value && value >= today) throw new AppError("The books can only be closed up to a day before today", 400);
  const business = await Business.findById(businessId);
  if (!business) throw new AppError("Business not found", 404);
  business.booksLock = { lockedUpTo: value, lockedBy: userId, lockedAt: new Date() };
  await business.save(); // the edit log keeps every lock and reopen
  return getPeriodLock({ businessId });
};

// ------------------------------------------------------------------ edit log

const editLogFilter = ({ businessId, model, recordId, userId, action, from, to, search }) => {
  const filter = { businessId: new mongoose.Types.ObjectId(String(businessId)) };
  if (model) filter.model = String(model);
  if (recordId && mongoose.isValidObjectId(recordId)) filter.recordId = new mongoose.Types.ObjectId(String(recordId));
  if (userId && mongoose.isValidObjectId(userId)) filter.userId = new mongoose.Types.ObjectId(String(userId));
  if (action) filter.action = String(action).toUpperCase();
  if (from || to) {
    filter.at = {};
    if (from) filter.at.$gte = new Date(`${from}T00:00:00+05:30`);
    if (to) filter.at.$lte = new Date(`${to}T23:59:59.999+05:30`);
  }
  if (search) filter.recordLabel = { $regex: String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  return filter;
};

const listEditLog = async ({ businessId, query = {} }) => {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(query.limit || 50)));
  const filter = editLogFilter({ businessId, ...query });
  const [items, total, models] = await Promise.all([
    EditLog.find(filter).sort({ at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    EditLog.countDocuments(filter),
    EditLog.distinct("model", { businessId: filter.businessId }),
  ]);
  return { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, models: models.sort() };
};

const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// One line per changed field (a create or delete is one line with the whole record).
const exportEditLogCsv = async ({ businessId, query = {} }) => {
  const filter = editLogFilter({ businessId, ...query });
  const lines = [["When (IST)", "User", "IP", "Record type", "Record", "Record id", "Action", "Field", "Before", "After"].join(",")];
  const cursor = EditLog.find(filter).sort({ at: 1, _id: 1 }).lean().cursor();
  for await (const row of cursor) {
    const when = new Date(new Date(row.at).getTime() + 330 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    const base = [when, row.userEmail || row.userName || "system", row.ip, row.model, row.recordLabel, String(row.recordId), row.action];
    if (row.changes?.length) for (const c of row.changes) lines.push([...base, c.path, c.before, c.after].map(csvCell).join(","));
    else lines.push([...base, row.update ? "(update)" : "(whole record)", row.action === "DELETE" ? row.snapshot : "", row.action === "CREATE" ? row.snapshot : row.update].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
};

// ------------------------------------------------------------------ Goldhawk GST watch

const GST_THRESHOLD_SERVICES = 2000000; // Rs 20 lakh, services, normal-category state (MP)

const goldhawkWatch = async ({ businessId, now = new Date() }) => {
  const business = await Business.findById(businessId).select("billingParentId billingEntityCode").lean();
  if (!business) throw new AppError("Business not found", 404);
  const homeId = business.billingParentId || business._id;
  const gh = business.billingEntityCode === "GOLDHAWK" ? await Business.findById(business._id).lean() : await Business.findOne({ billingParentId: homeId, billingEntityCode: "GOLDHAWK" }).lean();
  if (!gh) return null;
  const registered = Boolean(gh.gstConfiguration?.enabled && (gh.gstConfiguration.gstin || gh.gstTaxId));
  const fy = fyLabel(now);
  const fyStart = Number(`20${fy.slice(0, 2)}`);
  const from = new Date(Date.UTC(fyStart, 3, 1) - 330 * 60 * 1000);
  const invoices = await Invoice.find({ businessId: gh._id, status: "issued", invoiceDate: { $gte: from, $lte: now } }).select("grandTotal totalTax").lean();
  const turnover = Math.round(invoices.reduce((sum, inv) => sum + Number(inv.grandTotal || 0) - Number(inv.totalTax || 0), 0) * 100) / 100;
  const share = turnover / GST_THRESHOLD_SERVICES;
  const level = registered ? "REGISTERED" : share >= 1 ? "CROSSED" : share >= 0.9 ? "DANGER" : share >= 0.75 ? "WARNING" : "OK";
  const messages = {
    REGISTERED: "Goldhawk is GST registered: its bills now carry GST and post it in the books.",
    CROSSED: "Goldhawk's billing this year has crossed Rs 20 lakh. GST registration is due within 30 days of crossing; after registering, turn on GST with the GSTIN in Goldhawk's settings.",
    DANGER: "Goldhawk's billing this year is above 90% of the Rs 20 lakh GST limit.",
    WARNING: "Goldhawk's billing this year is above 75% of the Rs 20 lakh GST limit.",
    OK: "Goldhawk's billing is under the GST registration limit.",
  };
  return { entityId: gh._id, name: gh.name, fy, turnover, threshold: GST_THRESHOLD_SERVICES, percent: Math.round(share * 1000) / 10, invoices: invoices.length, registered, level, message: messages[level] };
};

// ------------------------------------------------------------------ attachments

const DOCUMENT_DIR = path.join(process.cwd(), "uploads", "documents"); // not served publicly
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const DOCUMENT_TYPES = new Map([
  [".pdf", { mime: "application/pdf", ok: (b) => b.subarray(0, 5).toString("ascii") === "%PDF-" }],
  [".jpg", { mime: "image/jpeg", ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  [".jpeg", { mime: "image/jpeg", ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  [".png", { mime: "image/png", ok: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
]);
const RECORD_MODELS = { purchase: Purchase, expense: Expense, supplier: Supplier };
const KINDS = ["BILL", "AGREEMENT", "RECEIPT", "CERTIFICATE", "OTHER"];

const recordOf = async ({ businessId, recordType, recordId }) => {
  const Model = RECORD_MODELS[String(recordType || "").toLowerCase()];
  if (!Model) throw new AppError("Documents can be attached to purchases, expenses and suppliers", 400);
  if (!mongoose.isValidObjectId(recordId)) throw new AppError("Record not found", 404);
  const record = await Model.findOne({ _id: recordId, businessId });
  if (!record) throw new AppError("Record not found", 404);
  return record;
};

const addAttachment = async ({ businessId, userId, recordType, recordId, fileBase64, fileName, kind, validFrom, validTo, note }) => {
  const record = await recordOf({ businessId, recordType, recordId });
  const ext = path.extname(String(fileName || "")).toLowerCase();
  const type = DOCUMENT_TYPES.get(ext);
  if (!type) throw new AppError("Attach a PDF, JPG or PNG file", 400);
  const buffer = Buffer.from(String(fileBase64 || ""), "base64");
  if (!buffer.length) throw new AppError("The file is empty", 400);
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new AppError("The file is larger than 5 MB", 413);
  if (!type.ok(buffer)) throw new AppError("The file's content does not match its type", 400);
  if ((record.attachments || []).length >= 20) throw new AppError("A record can hold at most 20 documents", 400);
  await fs.promises.mkdir(DOCUMENT_DIR, { recursive: true });
  const storedName = `${businessId}-${Date.now()}-${crypto.randomBytes(12).toString("hex")}${ext}`;
  await fs.promises.writeFile(path.join(DOCUMENT_DIR, storedName), buffer, { flag: "wx" });
  record.attachments.push({
    fileName: path.basename(String(fileName)).slice(0, 160),
    storedName,
    mimeType: type.mime,
    size: buffer.length,
    kind: KINDS.includes(String(kind || "").toUpperCase()) ? String(kind).toUpperCase() : "OTHER",
    validFrom: validFrom ? new Date(validFrom) : null,
    validTo: validTo ? new Date(validTo) : null,
    note: String(note || "").slice(0, 300),
    uploadedBy: userId,
    uploadedAt: new Date(),
  });
  try {
    await record.save();
  } catch (error) {
    await fs.promises.unlink(path.join(DOCUMENT_DIR, storedName)).catch(() => {});
    throw error;
  }
  return record.attachments[record.attachments.length - 1];
};

const readAttachment = async ({ businessId, recordType, recordId, attachmentId }) => {
  const record = await recordOf({ businessId, recordType, recordId });
  const item = record.attachments.id(attachmentId);
  if (!item) throw new AppError("Document not found", 404);
  const full = path.join(DOCUMENT_DIR, path.basename(item.storedName));
  if (!fs.existsSync(full)) throw new AppError("The stored file is missing", 404);
  return { item, full };
};

// Removing takes the document off the record; the file stays on disk and the edit log keeps the change.
const removeAttachment = async ({ businessId, recordType, recordId, attachmentId }) => {
  const record = await recordOf({ businessId, recordType, recordId });
  const item = record.attachments.id(attachmentId);
  if (!item) throw new AppError("Document not found", 404);
  item.deleteOne();
  await record.save();
  return { removed: attachmentId };
};

// Landlord / supplier agreements that end within `days` days (or have ended).
const expiringAgreements = async ({ businessId, days = 60, now = new Date() }) => {
  const until = new Date(now.getTime() + days * 86400000);
  const suppliers = await Supplier.find({ businessId, "attachments.kind": "AGREEMENT", "attachments.validTo": { $ne: null, $lte: until } }).select("supplierName attachments").lean();
  const out = [];
  for (const s of suppliers) for (const a of s.attachments || []) {
    if (a.kind === "AGREEMENT" && a.validTo && new Date(a.validTo) <= until) out.push({ supplierId: s._id, supplierName: s.supplierName, attachmentId: a._id, fileName: a.fileName, validTo: a.validTo, ended: new Date(a.validTo) < now });
  }
  return out.sort((a, b) => new Date(a.validTo) - new Date(b.validTo));
};

module.exports = {
  DOCUMENT_DIR,
  addAttachment,
  expiringAgreements,
  exportEditLogCsv,
  getPeriodLock,
  goldhawkWatch,
  listEditLog,
  readAttachment,
  removeAttachment,
  setPeriodLock,
};
