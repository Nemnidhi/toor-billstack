const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const deposits = require("../services/deposit.service");
const assets = require("../services/fixed-asset.service");
const yearEnd = require("../services/year-end.service");
const { fyLabel } = require("../utils/invoice");

// Year-end work is per company (TOOR or Goldhawk), never the consolidated view.
const companyOf = (req) => {
  const scope = req.accountingScope || {};
  if (scope.isConsolidated) throw new AppError("Pick TOOR or Goldhawk: this is kept per company.", 400);
  return scope.businessId;
};
const lastFy = () => {
  const now = fyLabel(new Date());
  return `${String(Number(now.slice(0, 2)) - 1).padStart(2, "0")}-${now.slice(0, 2)}`;
};
const fyOf = (req) => String(req.query.fy || req.body?.fy || lastFy());
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

module.exports = {
  listDeposits: asyncHandler(async (req, res) => ok(res, await deposits.depositRegister({ businessId: companyOf(req), direction: req.query.direction, asOf: req.query.asOf }))),
  createDeposit: asyncHandler(async (req, res) => ok(res, await deposits.createDeposit({ businessId: companyOf(req), userId: req.user._id, payload: req.body }), 201)),
  moveDeposit: asyncHandler(async (req, res) => ok(res, await deposits.addMovement({ businessId: companyOf(req), userId: req.user._id, depositId: req.params.id, payload: req.body }))),
  cancelDeposit: asyncHandler(async (req, res) => ok(res, await deposits.cancelDeposit({ businessId: companyOf(req), userId: req.user._id, depositId: req.params.id }))),
  setOffCandidates: asyncHandler(async (req, res) => ok(res, await deposits.setOffCandidates({ businessId: companyOf(req), depositId: req.params.id, customerId: req.query.customerId }))),
  setOffDeposit: asyncHandler(async (req, res) => ok(res, await deposits.setOffAgainstInvoices({ businessId: companyOf(req), userId: req.user._id, depositId: req.params.id, payload: req.body }))),
  undoSetOff: asyncHandler(async (req, res) => ok(res, await deposits.undoSetOff({ businessId: companyOf(req), userId: req.user._id, depositId: req.params.id, movementId: req.params.movementId, reason: req.body?.reason }))),

  assetClasses: asyncHandler(async (req, res) => ok(res, { classes: assets.ASSET_CLASSES, blocks: assets.IT_BLOCK_NAMES, lastFy: lastFy() })),
  listAssets: asyncHandler(async (req, res) => ok(res, await assets.listAssets({ businessId: companyOf(req), status: req.query.status }))),
  createAsset: asyncHandler(async (req, res) => ok(res, await assets.createAsset({ businessId: companyOf(req), userId: req.user._id, payload: req.body }), 201)),
  disposeAsset: asyncHandler(async (req, res) => ok(res, await assets.disposeAsset({ businessId: companyOf(req), userId: req.user._id, assetId: req.params.id, payload: req.body }))),
  cancelAsset: asyncHandler(async (req, res) => ok(res, await assets.cancelAsset({ businessId: companyOf(req), userId: req.user._id, assetId: req.params.id }))),
  assetRegister: asyncHandler(async (req, res) => ok(res, await assets.assetRegister({ businessId: companyOf(req), fy: fyOf(req) }))),
  itBlocks: asyncHandler(async (req, res) => ok(res, await assets.itBlocks({ businessId: companyOf(req), fy: fyOf(req) }))),
  runDepreciation: asyncHandler(async (req, res) => ok(res, await assets.runDepreciation({ businessId: companyOf(req), userId: req.user._id, fy: fyOf(req) }))),

  scheduleIII: asyncHandler(async (req, res) => ok(res, await yearEnd.scheduleIII({ businessId: companyOf(req), fy: fyOf(req) }))),
  msme: asyncHandler(async (req, res) => ok(res, await yearEnd.msmeReport({ businessId: companyOf(req), fy: fyOf(req), bankRate: Number(req.query.bankRate || 5.5) }))),
  gstr9: asyncHandler(async (req, res) => ok(res, await yearEnd.gstr9({ businessId: companyOf(req), fy: fyOf(req) }))),
  tally: asyncHandler(async (req, res) => {
    const fy = fyOf(req);
    const y = 2000 + Number(fy.slice(0, 2));
    const from = String(req.query.from || `${y}-04-01`);
    const to = String(req.query.to || `${y + 1}-03-31`);
    const out = await yearEnd.tallyXml({ businessId: companyOf(req), from, to });
    const part = req.query.part === "masters" ? "masters" : "vouchers";
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tally-${part}-${from}-to-${to}.xml"`);
    res.setHeader("X-Tally-Counts", JSON.stringify(out.counts));
    res.send(part === "masters" ? out.mastersXml : out.vouchersXml);
  }),
};
