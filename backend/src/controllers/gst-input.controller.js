const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const gstInput = require("../services/gst-input.service");

const monthOf = (req) => String(req.query.month || req.body?.month || "");

const itcRegister = asyncHandler(async (req, res) => {
  res.json({ data: await gstInput.itcRegister({ businessId: req.tenant.businessId, month: monthOf(req) }) });
});

const import2b = asyncHandler(async (req, res) => {
  const { jsonText, csvText, fileBase64, fileName } = req.body || {};
  if (String(jsonText || "").length + String(fileBase64 || "").length > 11 * 1024 * 1024) throw new AppError("File is too large", 413);
  res.status(201).json({ data: await gstInput.import2b({ businessId: req.tenant.businessId, userId: req.user._id, month: monthOf(req), jsonText, csvText, fileBase64, fileName }) });
});

const match2b = asyncHandler(async (req, res) => {
  res.json({ data: await gstInput.match2b({ businessId: req.tenant.businessId, month: monthOf(req) }) });
});

const setImsAction = asyncHandler(async (req, res) => {
  res.json({ data: await gstInput.setImsAction({ businessId: req.tenant.businessId, month: monthOf(req), rowId: req.params.rowId, action: String(req.body?.action || "").toUpperCase(), note: req.body?.note }) });
});

const gstr3b = asyncHandler(async (req, res) => {
  res.json({ data: await gstInput.gstr3b({ businessId: req.tenant.businessId, month: monthOf(req), filingDate: req.query.filingDate || null }) });
});

const gstr1Json = asyncHandler(async (req, res) => {
  const { json, fileName } = await gstInput.gstr1Json({ businessId: req.tenant.businessId, month: monthOf(req) });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/[^A-Za-z0-9_.-]/g, "_")}"`);
  res.send(JSON.stringify(json));
});

// The JSON checked against the portal's upload rules before it is downloaded.
const gstr1JsonCheck = asyncHandler(async (req, res) => {
  const { checks, fileName } = await gstInput.gstr1Json({ businessId: req.tenant.businessId, month: monthOf(req) });
  res.json({ data: { fileName, errors: checks.filter((c) => c.level === "error"), warnings: checks.filter((c) => c.level === "warning") } });
});

const rcmDocuments = asyncHandler(async (req, res) => {
  res.json({ data: await gstInput.rcmDocuments({ businessId: req.tenant.businessId, expenseId: req.params.expenseId }) });
});

module.exports = { itcRegister, import2b, match2b, setImsAction, gstr3b, gstr1Json, gstr1JsonCheck, rcmDocuments };
