const IntegrationEvent = require("../models/IntegrationEvent");
const asyncHandler = require("../utils/asyncHandler");
const { writeAuditLog } = require("../services/audit.service");
const {
  createCredential,
  createInvoiceHandoff,
  ingestExternalOrder,
  listCredentials,
  resolveInvoiceHandoff,
  revokeCredential,
  syncExternalCustomer,
} = require("../services/integration.service");

const listIntegrationCredentials = asyncHandler(async (req, res) => {
  res.json({ data: await listCredentials({ businessId: req.tenant.businessId }) });
});

const createIntegrationCredential = asyncHandler(async (req, res) => {
  const result = await createCredential({
    businessId: req.tenant.businessId,
    name: req.body.name || "External integration",
    source: req.body.source || "API",
    userId: req.user._id,
  });
  await writeAuditLog({ req, action: "INTEGRATION_CREDENTIAL_CREATED", entityType: "INTEGRATION_CREDENTIAL", entityId: result.credential._id, metadata: { source: result.credential.source } });
  res.status(201).json({ data: { credential: result.credential, apiKey: result.rawKey } });
});

const revokeIntegrationCredential = asyncHandler(async (req, res) => {
  const credential = await revokeCredential({
    businessId: req.tenant.businessId,
    credentialId: req.params.credentialId,
    userId: req.user._id,
  });
  await writeAuditLog({ req, action: "INTEGRATION_CREDENTIAL_REVOKED", entityType: "INTEGRATION_CREDENTIAL", entityId: credential._id, metadata: { source: credential.source } });
  res.json({ data: credential });
});

const ingestOrder = asyncHandler(async (req, res) => {
  const result = await ingestExternalOrder({ credential: req.integrationCredential, payload: req.body });
  await writeAuditLog({ req, businessId: req.integrationCredential.businessId, action: "INTEGRATION_ORDER_INGESTED", entityType: "INTEGRATION_EVENT", entityId: result.event._id, metadata: { source: result.event.source, externalOrderId: result.event.externalOrderId, idempotent: result.idempotent } });
  res.status(result.idempotent ? 200 : 201).json({ data: result });
});

const upsertCustomer = asyncHandler(async (req, res) => {
  const result = await syncExternalCustomer({ credential: req.integrationCredential, payload: req.body });
  await writeAuditLog({ req, businessId: req.integrationCredential.businessId, action: "INTEGRATION_CUSTOMER_SYNCED", entityType: "CUSTOMER", entityId: result.customer._id, metadata: { source: result.mapping.source, externalId: result.mapping.externalId, outcome: result.outcome } });
  res.status(result.outcome === "created" ? 201 : 200).json({ data: { outcome: result.outcome, customer: result.customer, externalReference: { source: result.mapping.source, externalId: result.mapping.externalId } } });
});

const requestInvoiceHandoff = asyncHandler(async (req, res) => {
  const result = await createInvoiceHandoff({ credential: req.integrationCredential, payload: req.body });
  res.status(201).json({ data: result });
});

const consumeInvoiceHandoff = asyncHandler(async (req, res) => {
  const { hashValue, resolveInvoiceHandoff } = require("../services/integration.service");
  const IntegrationHandoff = require("../models/IntegrationHandoff");
  const Business = require("../models/Business");
  const Membership = require("../models/BusinessMembership");
  const AppError = require("../utils/appError");

  const handoff = await IntegrationHandoff.findOne({
    tokenHash: hashValue(req.params.token),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!handoff) throw new AppError("Handoff is invalid or expired", 404);

  let targetBusinessId = handoff.businessId;
  if (handoff.billingContext?.billingEntityCode === "GOLDHAWK") {
    let goldhawk = await Business.findOne({
      billingParentId: handoff.businessId,
      billingEntityCode: "GOLDHAWK",
    });
    if (!goldhawk) {
      const { ensureGoldhawk } = require("../services/billing-entity.service");
      goldhawk = await ensureGoldhawk(req.identityUser);
    }
    targetBusinessId = goldhawk._id;

    // Ensure member has membership in Goldhawk if they are authorized on parent business
    const existingMembership = await Membership.findOne({ userId: req.identityUser._id, businessId: targetBusinessId });
    if (!existingMembership) {
      const role = req.identityUser.role === "owner" ? "admin" : req.identityUser.role;
      await Membership.create({ userId: req.identityUser._id, businessId: targetBusinessId, role });
    }
  }

  const { resolveEntityUser } = require("../services/billing-entity.service");
  const user = await resolveEntityUser(req.identityUser, targetBusinessId);
  const business = await Business.findById(user.businessId);
  if (!business || business.isDisabled) throw new AppError("Billing entity unavailable", 403);

  const result = await resolveInvoiceHandoff({
    token: req.params.token,
    businessId: handoff.businessId,
    userId: user._id,
  });

  const { buildAuthPayload, signAccessToken } = require("../services/auth.service");
  res.json({
    data: {
      ...result,
      targetBusinessId,
      session: await buildAuthPayload({ user, business, accessToken: signAccessToken(user) }),
    },
  });
});

const listIntegrationEvents = asyncHandler(async (req, res) => {
  res.json({
    data: await IntegrationEvent.find({ businessId: req.tenant.businessId })
      .populate("customerId", "name email phone")
      .populate("invoiceId", "invoiceNumber grandTotal")
      .sort("-createdAt")
      .limit(Math.min(Number(req.query.limit) || 100, 200)),
  });
});

module.exports = {
  consumeInvoiceHandoff,
  createIntegrationCredential,
  ingestOrder,
  listIntegrationCredentials,
  listIntegrationEvents,
  requestInvoiceHandoff,
  revokeIntegrationCredential,
  upsertCustomer,
};
