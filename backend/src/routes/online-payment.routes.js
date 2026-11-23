const express = require("express");
const auth = require("../middlewares/auth.middleware");
const tenant = require("../middlewares/tenant.middleware");
const { permit } = require("../middlewares/role.middleware");
const { requireActiveSubscription } = require("../middlewares/subscription.middleware");
const { validateObjectIdParam } = require("../middlewares/object-id.middleware");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const service = require("../services/online-payment.service");

const router = express.Router();

// Razorpay calls this for the business whose account it is (the path names the business, so its own
// webhook secret checks the signature). The raw body is kept for "/webhooks/" paths (app.js).
router.post(
  "/webhooks/razorpay/:businessId",
  asyncHandler(async (req, res) => {
    if (!req.rawBody) throw new AppError("Empty body", 400);
    const result = await service.handleWebhook({ businessId: req.params.businessId, rawBody: req.rawBody, signature: req.get("x-razorpay-signature") || "", eventId: req.get("x-razorpay-event-id") || "" });
    res.json({ ok: true, ...result });
  })
);

router.use(auth, tenant, requireActiveSubscription());

router.get("/settings", permit("owner", "admin", "accountant"), asyncHandler(async (req, res) => {
  res.json({ data: await service.getSettings({ businessId: req.tenant.businessId }) });
}));
router.put("/settings", permit("owner", "admin"), asyncHandler(async (req, res) => {
  res.json({ data: await service.saveSettings({ businessId: req.tenant.businessId, userId: req.user?._id, body: req.body || {} }) });
}));

router.get("/invoices/:invoiceId", validateObjectIdParam("invoiceId"), asyncHandler(async (req, res) => {
  res.json({ data: await service.invoiceLinks({ businessId: req.tenant.businessId, invoiceId: req.params.invoiceId }) });
}));
// Make (or refresh for the amount now due) the invoice's payment link.
router.post("/invoices/:invoiceId/link", validateObjectIdParam("invoiceId"), permit("owner", "admin", "staff", "accountant"), asyncHandler(async (req, res) => {
  const link = await service.ensureInvoiceLink({ businessId: req.tenant.businessId, invoiceId: req.params.invoiceId, userId: req.user?._id });
  res.status(201).json({ data: service.linkOut(link) });
}));
router.post("/invoices/:invoiceId/link/cancel", validateObjectIdParam("invoiceId"), permit("owner", "admin", "accountant"), asyncHandler(async (req, res) => {
  res.json({ data: await service.cancelInvoiceLink({ businessId: req.tenant.businessId, invoiceId: req.params.invoiceId }) });
}));
// Paid online but not recorded (books locked for that day, ...): try again once fixed.
router.post("/invoices/:invoiceId/link/record", validateObjectIdParam("invoiceId"), permit("owner", "admin", "accountant"), asyncHandler(async (req, res) => {
  res.json({ data: await service.recordAgain({ businessId: req.tenant.businessId, invoiceId: req.params.invoiceId }) });
}));
// A refund made in Razorpay: { how: "reverse" } (full refund: reverse the payment) or { how: "done" }.
router.post("/invoices/:invoiceId/refunds/:refundId/record", validateObjectIdParam("invoiceId"), permit("owner", "admin", "accountant"), asyncHandler(async (req, res) => {
  res.json({ data: await service.recordRefund({ businessId: req.tenant.businessId, invoiceId: req.params.invoiceId, refundId: String(req.params.refundId), userId: req.user?._id, how: String(req.body?.how || "") }) });
}));

// Razorpay settlements: posted by themselves when every line is known, else waiting for the accountant.
router.get("/settlements", permit("owner", "admin", "accountant"), asyncHandler(async (req, res) => {
  res.json({ data: await service.listSettlements({ businessId: req.tenant.businessId }) });
}));
router.post("/settlements/:id/decide", validateObjectIdParam("id"), permit("owner", "admin", "accountant"), asyncHandler(async (req, res) => {
  res.json({ data: await service.decideSettlement({ businessId: req.tenant.businessId, id: req.params.id, userId: req.user?._id, action: String(req.body?.action || "") }) });
}));

module.exports = router;
