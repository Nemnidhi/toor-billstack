const crypto = require("crypto");
const mongoose = require("mongoose");

const Business = require("../models/Business");
const Customer = require("../models/Customer");
const IntegrationCredential = require("../models/IntegrationCredential");
const IntegrationCustomerMapping = require("../models/IntegrationCustomerMapping");
const IntegrationEvent = require("../models/IntegrationEvent");
const IntegrationHandoff = require("../models/IntegrationHandoff");
const Invoice = require("../models/Invoice");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const AppError = require("../utils/appError");
const { buildGstSnapshot, validateGstin, validateStateCode } = require("../utils/gst");
const { buildInvoiceNumber, buildInvoiceTotals } = require("../utils/invoice");
const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const { dispatchInvoiceIssuedAutomation, sendInvoiceMessage } = require("./communication.service");
const { allocatePayment, createPayment } = require("./payment.service");
const { createCustomerLedgerEntryOnce } = require("./ledger.service");
const { ensureBusinessSubscription, getPlanEntitlements, isSubscriptionAccessible } = require("../utils/subscription");
const { buildInventoryFlags } = require("./inventory.service");
const { resolveOrCreateCatalogService } = require("./service-catalog.service");

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const hashValue = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const cleanText = (value, maxLength) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
const extractCleanEmail = (raw) => {
  if (!raw || typeof raw !== "string") return "";
  const cleaned = raw.replace(/^mailto:/i, "").trim();
  const angleMatch = cleaned.match(/<([^>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : cleaned).trim().toLowerCase();
  return candidate;
};
const normalizeEmail = (value) => extractCleanEmail(value);
const normalizePhone = (value) => cleanText(value, 32).replace(/\D/g, "");

const normalizeCustomerSyncPayload = (payload = {}, credential) => {
  const externalId = cleanText(payload.externalId, 160);
  const source = cleanText(payload.source || credential.source || "API", 80).toUpperCase();
  const name = cleanText(payload.name, 160);
  const email = normalizeEmail(payload.email);
  const phone = normalizePhone(payload.phone);
  const gstNumber = cleanText(payload.gstNumber || payload.gstin, 15).replace(/\s/g, "").toUpperCase();
  const stateCode = cleanText(payload.stateCode, 2).padStart(payload.stateCode ? 2 : 0, "0");
  const placeOfSupplyCode = cleanText(payload.placeOfSupplyCode, 2).padStart(payload.placeOfSupplyCode ? 2 : 0, "0");
  if (!externalId || !/^[A-Za-z0-9._:@/-]+$/.test(externalId)) throw new AppError("A valid externalId is required", 400);
  if (!source || !/^[A-Z0-9_-]+$/.test(source)) throw new AppError("A valid source is required", 400);
  if (!name) throw new AppError("Customer name is required", 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("Invalid customer email", 400);
  if (phone && (phone.length < 7 || phone.length > 15)) throw new AppError("Invalid customer phone", 400);
  if (gstNumber && !validateGstin(gstNumber)) throw new AppError("Invalid customer GSTIN", 400);
  if (stateCode && !validateStateCode(stateCode)) throw new AppError("Invalid customer state code", 400);
  if (placeOfSupplyCode && !validateStateCode(placeOfSupplyCode)) throw new AppError("Invalid place of supply code", 400);
  if (gstNumber && stateCode && gstNumber.slice(0, 2) !== stateCode) throw new AppError("GSTIN and state code do not match", 400);
  return { externalId, source, name, email, phone, billingAddress: cleanText(payload.billingAddress || payload.address, 500), gstNumber, stateCode, placeOfSupplyCode };
};

const customerUpdates = (input, supplied = {}) => Object.fromEntries(
  ["name", "phone", "email", "billingAddress", "gstNumber", "stateCode", "placeOfSupplyCode"]
    .filter((field) => input[field] || Object.prototype.hasOwnProperty.call(supplied, field))
    .map((field) => [field, input[field]])
);

const findCustomerIdentityMatches = async ({ businessId, input, session }) => {
  const matches = new Map();
  const identifiers = [
    input.gstNumber && { gstNumber: input.gstNumber },
    input.phone && { phone: { $regex: new RegExp(`^\\D*${input.phone.split("").join("\\D*")}\\D*$`) } },
    input.email && { email: input.email },
  ].filter(Boolean);
  for (const identifier of identifiers) {
    const rows = await Customer.find({ businessId, ...identifier }).limit(2).session(session);
    rows.forEach((row) => matches.set(row._id.toString(), row));
  }
  if (matches.size > 1) throw new AppError("Customer identifiers match different existing customers", 409);
  return matches.values().next().value || null;
};

const syncExternalCustomer = async ({ credential, payload }) => {
  const input = normalizeCustomerSyncPayload(payload, credential);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const mapping = await IntegrationCustomerMapping.findOne({ businessId: credential.businessId, source: input.source, externalId: input.externalId }).session(session);
      if (mapping) {
        const customer = await Customer.findOne({ _id: mapping.customerId, businessId: credential.businessId }).session(session);
        if (!customer) throw new AppError("Linked customer no longer exists", 409);
        const identityMatch = await findCustomerIdentityMatches({ businessId: credential.businessId, input, session });
        if (identityMatch && identityMatch._id.toString() !== customer._id.toString()) throw new AppError("Customer identifiers conflict with another existing customer", 409);
        // Explicit blank attributes clear this established mapping's fields.
        // Omitted fields and initial linking retain the existing behavior.
        const updates = customerUpdates(input, payload);
        const changed = Object.entries(updates).some(([field, value]) => String(customer[field] || "") !== String(value));
        if (changed) { Object.assign(customer, updates); await customer.save({ session }); }
        mapping.lastSyncedAt = new Date();
        await mapping.save({ session });
        result = { customer, mapping, outcome: changed ? "updated" : "already_synced" };
        return;
      }
      let customer = await findCustomerIdentityMatches({ businessId: credential.businessId, input, session });
      const outcome = customer ? "linked" : "created";
      if (customer) { Object.assign(customer, customerUpdates(input)); await customer.save({ session }); }
      else [customer] = await Customer.create([{ businessId: credential.businessId, ...customerUpdates(input) }], { session });
      const [createdMapping] = await IntegrationCustomerMapping.create([{
        businessId: credential.businessId, credentialId: credential._id, source: input.source,
        externalId: input.externalId, customerId: customer._id, lastSyncedAt: new Date(),
      }], { session });
      result = { customer, mapping: createdMapping, outcome };
    });
    return result;
  } catch (error) {
    if (error?.code === 11000) {
      const mapping = await IntegrationCustomerMapping.findOne({ businessId: credential.businessId, source: input.source, externalId: input.externalId });
      if (mapping) return { customer: await Customer.findOne({ _id: mapping.customerId, businessId: credential.businessId }), mapping, outcome: "already_synced" };
    }
    throw error;
  } finally { session.endSession(); }
};

const allowedReturnUrl = (value) => {
  if (!value) return "";
  let parsed;
  try { parsed = new URL(value); } catch (_error) { throw new AppError("Invalid returnUrl", 400); }
  const allowed = String(process.env.CRM_RETURN_URLS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowed.some((entry) => { try { return new URL(entry).origin === parsed.origin; } catch (_error) { return false; } })) throw new AppError("returnUrl origin is not allowed", 400);
  return parsed.toString();
};

// Validates billingContext from CRM: checks types, strips unknown fields.
// Returns null when absent so existing handoffs without context stay compatible.
const normalizeBillingContext = (ctx) => {
  if (!ctx || typeof ctx !== "object") return null;
  const BILLING_TYPES = ["RESIDENTIAL", "COMMERCIAL", "COWORKING"];
  const ENTITY_CODES = ["", "GOLDHAWK"];
  const billingType = String(ctx.billingType || "").toUpperCase();
  const billingEntityCode = String(ctx.billingEntityCode || "").toUpperCase();
  if (!BILLING_TYPES.includes(billingType)) return null;
  if (!ENTITY_CODES.includes(billingEntityCode)) return null;
  // Validate entity code is consistent with billing type
  if (billingType === "RESIDENTIAL" && billingEntityCode !== "GOLDHAWK") return null;
  if ((billingType === "COMMERCIAL" || billingType === "COWORKING") && billingEntityCode !== "") return null;

  // sourceRef: required for duplicate prevention
  const sr = ctx.sourceRef && typeof ctx.sourceRef === "object" ? ctx.sourceRef : {};
  const sourceRef = sr.sourceId && sr.source && sr.sourceType && sr.billingPurpose ? {
    source: String(sr.source).toUpperCase().slice(0, 80),
    sourceType: String(sr.sourceType).slice(0, 40),
    sourceId: String(sr.sourceId).slice(0, 40),
    billingPurpose: String(sr.billingPurpose).toUpperCase().slice(0, 40),
    billingPeriod: String(sr.billingPeriod || "").slice(0, 10),
  } : null;

  const rawItems = Array.isArray(ctx.prefill?.lineItems) ? ctx.prefill.lineItems : [];
  const lineItems = rawItems.slice(0, 20).map(item => {
    const supplied = (typeof item.rate === "number" || (typeof item.rate === "string" && item.rate.trim() !== ""))
      && Number.isFinite(Number(item.rate)) && Number(item.rate) >= 0;
    return {
      productName: String(item.productName || item.serviceName || "").slice(0, 120),
      serviceName: String(item.serviceName || item.productName || "").slice(0, 120),
      quantity: Math.max(1, Number(item.quantity) || 1),
      rate: supplied ? Number(item.rate) : null,
      rateReliable: supplied && item.rateReliable === true,
      hsnSac: String(item.hsnSac || "").slice(0, 20),
      description: String(item.description || "").slice(0, 500),
      taxRate: Number.isFinite(Number(item.taxRate)) ? Number(item.taxRate) : undefined,
    };
  });

  return {
    billingType,
    billingEntityCode,
    sourceRef,
    prefill: {
      notes: String(ctx.prefill?.notes || "").slice(0, 500),
      reference: String(ctx.prefill?.reference || "").slice(0, 200),
      lineItems,
    },
  };
};

const createInvoiceHandoff = async ({ credential, payload }) => {
  if (!mongoose.isValidObjectId(payload.customerId)) throw new AppError("Valid customerId is required", 400);
  const customer = await Customer.findOne({ _id: payload.customerId, businessId: credential.businessId });
  if (!customer) throw new AppError("Customer not found for this integration", 404);
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 3 * 60 * 1000);
  const billingContext = normalizeBillingContext(payload.billingContext);
  await IntegrationHandoff.create({
    businessId: credential.businessId,
    credentialId: credential._id,
    customerId: customer._id,
    tokenHash: hashValue(rawToken),
    purpose: "INVOICE_CREATE",
    returnUrl: allowedReturnUrl(payload.returnUrl),
    expiresAt,
    billingContext,
  });
  const clientUrl = String(process.env.CLIENT_URL || "http://localhost:5173").split(",")[0].trim().replace(/\/$/, "");
  return { handoffUrl: `${clientUrl}/integration/invoice-handoff?token=${encodeURIComponent(rawToken)}`, expiresAt };
};

const resolveInvoiceHandoff = async ({ token, businessId, userId }) => {
  if (!token || String(token).length > 256) throw new AppError("Invalid handoff token", 400);
  const handoff = await IntegrationHandoff.findOneAndUpdate(
    { tokenHash: hashValue(token), businessId, purpose: "INVOICE_CREATE", usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date(), usedBy: userId } },
    { new: true }
  ).populate("customerId", "name email phone billingAddress gstNumber stateCode placeOfSupplyCode");
  if (!handoff) throw new AppError("Handoff token is invalid, expired, used, or belongs to another workspace", 410);

  let existingInvoice = null;
  if (handoff.billingContext?.sourceRef?.sourceId) {
    const sr = handoff.billingContext.sourceRef;
    const inv = await Invoice.findOne({
      "crmSourceRef.source": sr.source,
      "crmSourceRef.sourceType": sr.sourceType,
      "crmSourceRef.sourceId": sr.sourceId,
      "crmSourceRef.billingPurpose": sr.billingPurpose,
      "crmSourceRef.billingPeriod": sr.billingPeriod || "",
    }).select("_id invoiceNumber grandTotal status createdAt");
    if (inv) {
      existingInvoice = {
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        grandTotal: inv.grandTotal,
        status: inv.status,
      };
    }
  }

  return {
    purpose: handoff.purpose,
    customer: handoff.customerId,
    returnUrl: handoff.returnUrl || "",
    billingContext: handoff.billingContext || null,
    existingInvoice,
  };
};

const generateApiKey = () => {
  const prefix = crypto.randomBytes(4).toString("hex");
  const secret = crypto.randomBytes(24).toString("hex");
  return { keyPrefix: prefix, rawKey: `bs_live_${prefix}_${secret}`, keyHash: hashValue(`${prefix}:${secret}`) };
};

const splitApiKey = (rawKey = "") => {
  const match = String(rawKey).match(/^bs_live_([a-f0-9]{8})_([a-f0-9]{48})$/i);
  if (!match) throw new AppError("Invalid integration API key", 401);
  return { keyPrefix: match[1], secret: match[2] };
};

const authenticateIntegrationKey = async (rawKey) => {
  const { keyPrefix, secret } = splitApiKey(rawKey);
  const credential = await IntegrationCredential.findOne({ keyPrefix, status: "ACTIVE" });
  if (!credential) throw new AppError("Invalid integration API key", 401);
  const expected = Buffer.from(credential.keyHash, "hex");
  const actual = Buffer.from(hashValue(`${keyPrefix}:${secret}`), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new AppError("Invalid integration API key", 401);
  }
  credential.lastUsedAt = new Date();
  await credential.save();
  return credential;
};

const createCredential = async ({ businessId, name, source, userId }) => {
  const key = generateApiKey();
  const credential = await IntegrationCredential.create({
    businessId,
    name,
    source: source || "API",
    keyPrefix: key.keyPrefix,
    keyHash: key.keyHash,
    createdBy: userId,
  });
  return { credential, rawKey: key.rawKey };
};

const revokeCredential = async ({ businessId, credentialId, userId }) => {
  const credential = await IntegrationCredential.findOne({ _id: credentialId, businessId });
  if (!credential) throw new AppError("Integration credential not found", 404);
  credential.status = "REVOKED";
  credential.revokedAt = new Date();
  credential.revokedBy = userId;
  await credential.save();
  return credential;
};

const listCredentials = ({ businessId }) =>
  IntegrationCredential.find({ businessId }).select("-keyHash").sort("-createdAt");

const getOrCreateIntegrationProduct = async ({ businessId, item, session }) => {
  const sku = String(item.sku || item.externalProductId || "").trim().toUpperCase();
  const query = sku ? { businessId, sku } : { businessId, name: item.name };
  return Product.findOneAndUpdate(
    query,
    {
      $setOnInsert: {
        businessId,
        name: item.name,
        sku,
        sellingPrice: Number(item.rate || item.amount || 0),
        taxRate: Number(item.taxRate || 0),
        hsnSac: item.hsnSac || "",
        gstClassification: item.gstClassification || "",
        trackInventory: false,
        status: "active",
      },
    },
    { upsert: true, new: true, session }
  );
};

const normalizeOrderPayload = (payload = {}) => {
  if (!payload.externalOrderId) throw new AppError("externalOrderId is required", 400);
  if (!payload.customer?.name && !payload.customer?.email && !payload.customer?.phone) {
    throw new AppError("Customer identity is required", 400);
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    throw new AppError("At least one purchased item is required", 400);
  }
  return {
    externalOrderId: String(payload.externalOrderId),
    source: String(payload.source || "API").toUpperCase(),
    customer: payload.customer,
    items: payload.items,
    payment: payload.payment || {},
    sendInvoice: payload.communication?.sendInvoice === true,
  };
};

const applyIntegrationInvoiceStock = async ({ business, businessId, invoiceId, lineItems, createdBy, session }) => {
  const productIds = [...new Set(lineItems.map((item) => item.productId.toString()))];
  const products = await Product.find({ _id: { $in: productIds }, businessId }).session(session);
  const map = new Map(products.map((product) => [product._id.toString(), product]));
  for (const item of lineItems) {
    const product = map.get(item.productId.toString());
    if (!product || !product.trackInventory) continue;
    const previousStock = product.currentStock;
    const newStock = previousStock - Number(item.quantity || 0);
    if (!business.inventorySettings?.allowNegativeStock && newStock < 0) throw new AppError(`Insufficient stock for ${product.name}`, 403);
    product.currentStock = newStock;
    Object.assign(product, buildInventoryFlags(product));
    await product.save({ session });
    await StockMovement.create(
      [{ businessId, productId: product._id, type: "OUT", quantity: Number(item.quantity || 0), previousStock, newStock, reason: `External order invoice ${invoiceId}`, referenceType: "INVOICE", referenceId: invoiceId.toString(), createdBy }],
      { session }
    );
  }
};

const ingestExternalOrder = async ({ credential, payload }) => {
  const normalized = normalizeOrderPayload(payload);
  const payloadHash = hashValue(stableStringify(normalized));
  const existing = await IntegrationEvent.findOne({
    businessId: credential.businessId,
    source: normalized.source,
    externalOrderId: normalized.externalOrderId,
  });
  if (existing) {
    if (existing.payloadHash === payloadHash && existing.status === "PROCESSED") return { event: existing, idempotent: true };
    existing.status = "CONFLICT";
    existing.errorMessage = "Conflicting duplicate external order payload";
    await existing.save();
    throw new AppError("Conflicting duplicate external order payload", 409);
  }

  const session = await mongoose.startSession();
  let event;
  let pendingConfirmedPayment = null;
  try {
    await session.withTransaction(async () => {
      const business = await Business.findById(credential.businessId).session(session);
      if (!business) throw new AppError("Business not found", 404);
      if (business.deploymentMode !== "SELF_HOSTED") {
        const subscription = await ensureBusinessSubscription({ businessId: business._id, planCode: business.planCode, session });
        if (!isSubscriptionAccessible(subscription)) throw new AppError("Your subscription is inactive or expired", 402);
        const plan = getPlanEntitlements(subscription);
        const currentMonthKey = new Date().toISOString().slice(0, 7);
        const invoiceCount = await Invoice.countDocuments({ businessId: business._id, status: { $ne: "cancelled" }, invoiceDate: { $gte: new Date(`${currentMonthKey}-01T00:00:00.000Z`) } }).session(session);
        if (invoiceCount >= plan.invoiceMonthlyLimit) throw new AppError(`Invoice limit reached for the ${plan.name} plan. Monthly limit: ${plan.invoiceMonthlyLimit}`, 403);
      }
      [event] = await IntegrationEvent.create(
        [{
          businessId: credential.businessId,
          credentialId: credential._id,
          source: normalized.source,
          externalOrderId: normalized.externalOrderId,
          payloadHash,
          status: "PROCESSING",
          metadata: { paymentStatus: normalized.payment.status || "UNCONFIRMED" },
        }],
        { session }
      );
      const customerQuery = normalized.customer.email
        ? { businessId: credential.businessId, email: String(normalized.customer.email).toLowerCase() }
        : { businessId: credential.businessId, phone: normalized.customer.phone };
      const customer = await Customer.findOneAndUpdate(
        customerQuery,
        {
          $set: {
            name: normalized.customer.name || normalized.customer.email || normalized.customer.phone,
            phone: normalized.customer.phone || "",
            billingAddress: normalized.customer.address || normalized.customer.billingAddress || "",
            gstNumber: normalized.customer.gstNumber || "",
            stateCode: normalized.customer.stateCode || "",
          },
          $setOnInsert: { businessId: credential.businessId, email: normalized.customer.email || "" },
        },
        { upsert: true, new: true, session }
      );
      const products = [];
      for (const item of normalized.items) products.push(await getOrCreateIntegrationProduct({ businessId: credential.businessId, item, session }));
      const lineItems = normalized.items.map((item, index) => ({
        productId: products[index]._id,
        productName: products[index].name,
        quantity: Number(item.quantity || 1),
        rate: Number(item.rate ?? item.amount ?? 0),
        taxRate: Number(item.taxRate || 0),
        discountType: item.discountType === "amount" ? "amount" : "percent",
        discountValue: Number(item.discountValue || 0),
      }));
      if (business.billingEntityCode === "GOLDHAWK") lineItems.forEach(line => { line.taxRate = 0; });
      const totals = buildInvoiceTotals({ lineItems, amountPaid: 0 });
      if (business.gstConfiguration?.enabled) {
        if (!validateGstin(business.gstConfiguration.gstin || business.gstTaxId) || !validateStateCode(business.gstConfiguration.stateCode)) throw new AppError("Invalid business GST configuration", 400);
        if (customer.gstNumber && !validateGstin(customer.gstNumber)) throw new AppError("Invalid customer GSTIN", 400);
      }
      const gstSnapshot = business.gstConfiguration?.enabled
        ? buildGstSnapshot({ business, counterparty: customer, lineItems: totals.lineItems, products, placeOfSupplyCode: normalized.customer.placeOfSupplyCode || normalized.customer.stateCode })
        : null;
      const sequence = business.invoiceNumbering?.nextSequence || 1;
      const invoiceDate = normalized.payment.paidAt ? new Date(normalized.payment.paidAt) : new Date();
      const [invoice] = await Invoice.create(
        [{
          businessId: credential.businessId,
          customerId: customer._id,
          invoiceNumber: buildInvoiceNumber({ prefix: business.invoiceNumbering?.prefix, format: business.invoiceNumbering?.format, sequence, date: invoiceDate }),
          invoiceDate,
          dueDate: invoiceDate,
          customerDetails: { name: customer.name, email: customer.email, phone: customer.phone, address: customer.billingAddress, gstNumber: customer.gstNumber },
          businessDetails: { name: business.name, email: business.email || business.billingEmail, phone: business.phone, address: business.address, gstNumber: business.gstTaxId },
          lineItems: totals.lineItems,
          subtotal: totals.subtotal,
          totalTax: totals.totalTax,
          totalDiscount: totals.totalDiscount,
          gstSnapshot,
          gstBreakup: gstSnapshot ? { cgst: gstSnapshot.cgst, sgst: gstSnapshot.sgst, utgst: gstSnapshot.utgst, igst: gstSnapshot.igst, taxableValue: gstSnapshot.taxableValue, hsnSacSummary: gstSnapshot.hsnSacSummary } : undefined,
          grandTotal: totals.grandTotal,
          amountPaid: 0,
          balanceDue: totals.grandTotal,
          paymentStatus: "unpaid",
          notes: `Imported from ${normalized.source}: ${normalized.externalOrderId}`,
          createdBy: credential.createdBy,
        }],
        { session }
      );
      await createCustomerLedgerEntryOnce({ businessId: credential.businessId, customerId: customer._id, eventType: "INVOICE", amount: invoice.grandTotal, direction: "DEBIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:DEBIT`, createdBy: credential.createdBy }, { session });
      await applyIntegrationInvoiceStock({ business, businessId: credential.businessId, invoiceId: invoice._id, lineItems: totals.lineItems, createdBy: credential.createdBy, session });
      business.invoiceNumbering.nextSequence = sequence + 1;
      await business.save({ session });
      event.customerId = customer._id;
      event.invoiceId = invoice._id;
      if (String(normalized.payment.status || "").toUpperCase() === "CONFIRMED") {
        const amount = fromMinorUnits(toMinorUnits(normalized.payment.amount ?? totals.grandTotal));
        if (toMinorUnits(amount) > toMinorUnits(totals.grandTotal)) throw new AppError("Confirmed payment exceeds invoice amount", 400);
        pendingConfirmedPayment = { amount, invoiceId: invoice._id, customerId: customer._id };
      }
      event.status = pendingConfirmedPayment ? "PROCESSING" : "PROCESSED";
      await event.save({ session });
    });
  } catch (error) {
    if (event?._id) {
      await IntegrationEvent.updateOne({ _id: event._id }, { status: "FAILED", errorMessage: error.message });
    }
    throw error;
  } finally {
    session.endSession();
  }
  if (event.invoiceId) {
    await dispatchInvoiceIssuedAutomation({ businessId: credential.businessId, invoiceId: event.invoiceId, createdBy: credential.createdBy }).catch(() => {});
  }
  if (pendingConfirmedPayment) {
    const payment = await createPayment({
      businessId: credential.businessId,
      userId: credential.createdBy,
      payload: {
        direction: "RECEIVED",
        amount: pendingConfirmedPayment.amount,
        currency: normalized.payment.currency || "INR",
        paymentDate: normalized.payment.paidAt ? new Date(normalized.payment.paidAt) : new Date(),
        paymentMethod: normalized.payment.method || "EXTERNAL",
        referenceNumber: normalized.payment.reference || normalized.externalOrderId,
        customerId: pendingConfirmedPayment.customerId,
        notes: `External payment from ${normalized.source}`,
      },
    });
    const allocation = await allocatePayment({
      businessId: credential.businessId,
      userId: credential.createdBy,
      paymentId: payment._id,
      payload: { invoiceId: pendingConfirmedPayment.invoiceId, allocatedAmount: pendingConfirmedPayment.amount },
    });
    await IntegrationEvent.updateOne({ _id: event._id, businessId: credential.businessId }, { paymentId: payment._id, allocationId: allocation._id, status: "PROCESSED", errorMessage: "" });
  }
  if (normalized.sendInvoice && event.invoiceId) {
    sendInvoiceMessage({ businessId: credential.businessId, invoiceId: event.invoiceId, channel: "EMAIL", createdBy: credential.createdBy }).catch(() => {});
  }
  return { event, idempotent: false };
};

module.exports = {
  authenticateIntegrationKey,
  createInvoiceHandoff,
  createCredential,
  hashValue,
  ingestExternalOrder,
  listCredentials,
  normalizeCustomerSyncPayload,
  normalizeBillingContext,
  resolveInvoiceHandoff,
  revokeCredential,
  syncExternalCustomer,
};
