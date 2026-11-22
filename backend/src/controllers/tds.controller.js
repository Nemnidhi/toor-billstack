const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const tdsService = require("../services/tds.service");

// TDS is filed per company (per TAN), so these pages always work on one company.
const companyOf = (req) => {
  const scope = req.accountingScope || {};
  if (scope.isConsolidated) throw new AppError("TDS is kept per company. Pick TOOR or Goldhawk.", 400);
  return scope.businessId;
};
const fyOf = (req) => String(req.query.fy || req.body?.fy || tdsService.meta().currentPeriod.fy);

const getMeta = asyncHandler(async (req, res) => {
  res.json({ success: true, data: tdsService.meta() });
});

const getReceivable = asyncHandler(async (req, res) => {
  const data = await tdsService.receivableRegister({ businessId: companyOf(req), fy: fyOf(req), quarter: req.query.quarter || "", customerId: req.query.customerId || null });
  res.json({ success: true, data });
});

const updateReceivable = asyncHandler(async (req, res) => {
  const data = await tdsService.updateReceivable({ businessId: companyOf(req), id: req.params.id, ...req.body });
  res.json({ success: true, data });
});

const import26as = asyncHandler(async (req, res) => {
  const { csvText, fileBase64, fileName } = req.body || {};
  if (fileBase64 && String(fileBase64).length > 11 * 1024 * 1024) throw new AppError("File is too large", 413);
  const data = await tdsService.import26as({ businessId: companyOf(req), userId: req.user._id, fy: fyOf(req), csvText, fileBase64, fileName });
  res.status(201).json({ success: true, data });
});

const getPayable = asyncHandler(async (req, res) => {
  const data = await tdsService.payableRegister({ businessId: companyOf(req), fy: fyOf(req) });
  res.json({ success: true, data });
});

const getChallans = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tdsService.listChallans({ businessId: companyOf(req), fy: fyOf(req) }) });
});

const createChallan = asyncHandler(async (req, res) => {
  const data = await tdsService.recordChallan({ businessId: companyOf(req), userId: req.user._id, payload: req.body || {} });
  res.status(201).json({ success: true, data });
});

const cancelChallan = asyncHandler(async (req, res) => {
  const data = await tdsService.cancelChallan({ businessId: companyOf(req), userId: req.user._id, id: req.params.id, reason: req.body?.reason || "" });
  res.json({ success: true, data });
});

const getForm140 = asyncHandler(async (req, res) => {
  const { csv, rows, dueDate } = await tdsService.form140Csv({ businessId: companyOf(req), fy: fyOf(req), quarter: req.query.quarter });
  if (req.query.format === "json") return res.json({ success: true, data: { rows: await tdsService.form140Rows({ businessId: companyOf(req), fy: fyOf(req), quarter: req.query.quarter }), count: rows, dueDate } });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="form140-${fyOf(req)}-${String(req.query.quarter).toUpperCase()}.csv"`);
  res.send(csv);
});

const getForm131 = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tdsService.form131Register({ businessId: companyOf(req), fy: fyOf(req), quarter: req.query.quarter }) });
});

module.exports = { getMeta, getReceivable, updateReceivable, import26as, getPayable, getChallans, createChallan, cancelChallan, getForm140, getForm131 };
