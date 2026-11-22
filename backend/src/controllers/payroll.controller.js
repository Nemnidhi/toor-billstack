const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const payroll = require("../services/payroll.service");
const { writeAuditLog } = require("../services/audit.service");

// Payroll is kept per company (TOOR or Goldhawk), never in the consolidated view.
const companyOf = (req) => {
  const scope = req.accountingScope || {};
  if (scope.isConsolidated) throw new AppError("Pick TOOR or Goldhawk: payroll is kept per company.", 400);
  return scope.businessId;
};
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const audit = (req, action, entityId, metadata) =>
  writeAuditLog({ req, businessId: companyOf(req), action, entityType: "PAYROLL_RUN", entityId, metadata }).catch(() => {});

module.exports = {
  // from the CRM (integration key)
  receiveRun: asyncHandler(async (req, res) => {
    const result = await payroll.receiveRun({ credential: req.integrationCredential, payload: req.body });
    await writeAuditLog({ req, businessId: req.integrationCredential.businessId, action: "INTEGRATION_PAYROLL_RECEIVED", entityType: "PAYROLL_RUN", entityId: result.run._id, metadata: { month: result.run.month, version: result.run.version, outcome: result.outcome } }).catch(() => {});
    res.status(result.outcome === "unchanged" ? 200 : 201).json({ data: { outcome: result.outcome, runId: result.run._id, status: result.run.status, month: result.run.month, version: result.run.version } });
  }),

  runStatusForCrm: asyncHandler(async (req, res) => {
    res.json({ data: await payroll.runStatusForCrm({ credential: req.integrationCredential, externalRunId: req.params.runId }) });
  }),

  listRuns: asyncHandler(async (req, res) => ok(res, await payroll.listRuns({ businessId: companyOf(req), includeSuperseded: req.query.all === "1" }))),
  getRun: asyncHandler(async (req, res) => ok(res, await payroll.getRun({ businessId: companyOf(req), runId: req.params.id }))),
  setDeductionMap: asyncHandler(async (req, res) => {
    const run = await payroll.setDeductionMap({ businessId: companyOf(req), runId: req.params.id, map: req.body?.map });
    ok(res, await payroll.getRun({ businessId: run.businessId, runId: run._id }));
  }),
  postRun: asyncHandler(async (req, res) => {
    const run = await payroll.postRun({ businessId: companyOf(req), userId: req.user._id, runId: req.params.id });
    await audit(req, "PAYROLL_POSTED", run._id, { month: run.month, version: run.version, net: run.totals.net });
    ok(res, await payroll.getRun({ businessId: run.businessId, runId: run._id }));
  }),
  unpostRun: asyncHandler(async (req, res) => {
    const run = await payroll.unpostRun({ businessId: companyOf(req), userId: req.user._id, runId: req.params.id });
    await audit(req, "PAYROLL_UNPOSTED", run._id, { month: run.month, version: run.version });
    ok(res, await payroll.getRun({ businessId: run.businessId, runId: run._id }));
  }),
  payRun: asyncHandler(async (req, res) => {
    const run = await payroll.payRun({ businessId: companyOf(req), userId: req.user._id, runId: req.params.id, payload: req.body });
    const pay = run.payments[run.payments.length - 1];
    await audit(req, "PAYROLL_PAID", run._id, { month: run.month, amount: pay.amount, people: pay.rows.length });
    ok(res, await payroll.getRun({ businessId: run.businessId, runId: run._id }));
  }),
  payDues: asyncHandler(async (req, res) => {
    const run = await payroll.payDues({ businessId: companyOf(req), userId: req.user._id, runId: req.params.id, payload: req.body });
    const due = run.dues[run.dues.length - 1];
    await audit(req, "PAYROLL_DUES_PAID", run._id, { month: run.month, kind: due.kind, amount: due.amount });
    ok(res, await payroll.getRun({ businessId: run.businessId, runId: run._id }));
  }),
  register: asyncHandler(async (req, res) => {
    const { fileName, csv } = await payroll.registerCsv({ businessId: companyOf(req), runId: req.params.id });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(csv);
  }),

  advances: asyncHandler(async (req, res) => ok(res, await payroll.advanceBalances({ businessId: companyOf(req) }))),
  giveAdvance: asyncHandler(async (req, res) => ok(res, await payroll.giveAdvance({ businessId: companyOf(req), userId: req.user._id, payload: req.body }), 201)),
  cancelAdvance: asyncHandler(async (req, res) => ok(res, await payroll.cancelAdvance({ businessId: companyOf(req), userId: req.user._id, advanceId: req.params.id }))),
};
