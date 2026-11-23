const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const controls = require("../services/controls.service");

// Period lock and the edit log are kept per company.
const companyOf = (req) => {
  const scope = req.accountingScope || {};
  if (scope.isConsolidated) throw new AppError("Pick TOOR or Goldhawk: the books are closed and audited per company.", 400);
  return scope.businessId;
};
// Client D14 (23 Nov 2026): the accountant closes and reopens the books as well as the owner / admin
// (and an auditor given "Close / reopen the books").
const ownerOrAdmin = (req) => {
  const role = require("../middlewares/auditor").effectiveRole(req, req.accountingScope?.role || req.user?.role);
  if (!["owner", "admin", "accountant"].includes(role)) throw new AppError("Only the owner, an admin or an accountant can close or reopen the books", 403);
};

const getPeriodLock = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await controls.getPeriodLock({ businessId: companyOf(req) }) });
});

const setPeriodLock = asyncHandler(async (req, res) => {
  ownerOrAdmin(req);
  const data = await controls.setPeriodLock({ businessId: companyOf(req), userId: req.user._id, lockedUpTo: req.body?.lockedUpTo });
  res.json({ success: true, data });
});

const getEditLog = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await controls.listEditLog({ businessId: companyOf(req), query: req.query }) });
});

const exportEditLog = asyncHandler(async (req, res) => {
  const csv = await controls.exportEditLogCsv({ businessId: companyOf(req), query: req.query });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="edit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${csv}`);
});

const getGoldhawkWatch = asyncHandler(async (req, res) => {
  const businessId = req.accountingScope?.homeBusinessId || req.accountingScope?.businessId || req.tenant?.businessId;
  res.json({ success: true, data: await controls.goldhawkWatch({ businessId }) });
});

// documents: the tenant's own records (any role that can open the record)
const tenantOf = (req) => req.tenant?.businessId;

const addDocument = asyncHandler(async (req, res) => {
  const { fileBase64, fileName, kind, validFrom, validTo, note } = req.body || {};
  const data = await controls.addAttachment({ businessId: tenantOf(req), userId: req.user._id, recordType: req.params.recordType, recordId: req.params.recordId, fileBase64, fileName, kind, validFrom, validTo, note });
  res.status(201).json({ success: true, data });
});

const downloadDocument = asyncHandler(async (req, res) => {
  const { item, full } = await controls.readAttachment({ businessId: tenantOf(req), ...req.params });
  res.setHeader("Content-Type", item.mimeType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${encodeURIComponent(item.fileName)}"`);
  res.sendFile(full);
});

const removeDocument = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await controls.removeAttachment({ businessId: tenantOf(req), ...req.params }) });
});

const getExpiringAgreements = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await controls.expiringAgreements({ businessId: tenantOf(req), days: Math.min(365, Number(req.query.days || 60)) }) });
});

module.exports = { addDocument, downloadDocument, exportEditLog, getEditLog, getExpiringAgreements, getGoldhawkWatch, getPeriodLock, removeDocument, setPeriodLock };
