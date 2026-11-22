const mongoose = require("mongoose");

const ApprovalDocument = require("../models/ApprovalDocument");
const Business = require("../models/Business");
const Customer = require("../models/Customer");
const DispatchFulfilment = require("../models/DispatchFulfilment");
const Invoice = require("../models/Invoice");
const Order = require("../models/Order");
const Product = require("../models/Product");
const ProductBatch = require("../models/ProductBatch");
const ProductionJob = require("../models/ProductionJob");
const Project = require("../models/Project");
const Purchase = require("../models/Purchase");
const StockMovement = require("../models/StockMovement");
const Task = require("../models/Task");
const User = require("../models/User");
const AppError = require("../utils/appError");
const { buildInvoiceNumber } = require("../utils/invoice");
const { buildInventoryFlags } = require("./inventory.service");
const { writeAuditLog } = require("./audit.service");

const PRODUCTION_TRANSITIONS = {
  PLANNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const BATCH_TRANSITIONS = {
  ACTIVE: ["QUARANTINED", "CONSUMED", "EXPIRED"],
  QUARANTINED: ["ACTIVE", "CONSUMED", "EXPIRED"],
  CONSUMED: [],
  EXPIRED: [],
};

const DISPATCH_TRANSITIONS = {
  DRAFT: ["PACKED", "CANCELLED"],
  PACKED: ["DISPATCHED", "CANCELLED"],
  DISPATCHED: ["DELIVERED", "CANCELLED"],
  DELIVERED: [],
  CANCELLED: [],
};

const APPROVAL_TRANSITIONS = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

const assertObjectId = (value, label) => {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new AppError(`Invalid ${label}`, 400);
};

const normalizeDate = (value, label) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(`Invalid ${label}`, 400);
  return date;
};

const normalizeQuantity = (value, label, { allowZero = false } = {}) => {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0 || (!allowZero && quantity <= 0)) {
    throw new AppError(`${label} must be ${allowZero ? "zero or greater" : "greater than zero"}`, 400);
  }
  return quantity;
};

const assertTransition = (map, current, next, label) => {
  if (!map[current]?.includes(next)) throw new AppError(`Invalid ${label} lifecycle transition`, 400);
};

const nextNumber = ({ business, field, prefix, format, date = new Date() }) => {
  const numbering = business[field] || {};
  // a format with {FY} restarts at 1 each financial year
  const { sequence, sequenceFy } = require("../utils/invoice").invoiceSequenceFor({ format: numbering.format || format, nextSequence: numbering.nextSequence, sequenceFy: numbering.sequenceFy }, date);
  const value = buildInvoiceNumber({
    prefix: numbering.prefix || prefix,
    format: numbering.format || format,
    sequence,
    date,
  });
  business[field] = {
    prefix: numbering.prefix || prefix,
    format: numbering.format || format,
    nextSequence: sequence + 1,
    sequenceFy,
  };
  return value;
};

const applyStockDelta = async ({ business, businessId, productId, type, quantity, reason, referenceType, referenceId, createdBy, session }) => {
  const product = await Product.findOne({ _id: productId, businessId }).session(session);
  if (!product) throw new AppError("Product not found", 404);
  if (!product.trackInventory) return { product, movement: null };

  const safeQuantity = Number(quantity);
  if (!Number.isFinite(safeQuantity) || safeQuantity <= 0) throw new AppError("Stock quantity must be greater than zero", 400);

  const previousStock = Number(product.currentStock || 0);
  const newStock = type === "OUT" ? previousStock - safeQuantity : previousStock + safeQuantity;
  if (!business.inventorySettings?.allowNegativeStock && newStock < 0) throw new AppError(`Insufficient stock for ${product.name}`, 403);

  product.currentStock = newStock;
  const flags = buildInventoryFlags(product);
  product.isLowStock = flags.isLowStock;
  product.isOutOfStock = flags.isOutOfStock;
  await product.save({ session });

  const [movement] = await StockMovement.create(
    [{ businessId, productId: product._id, type, quantity: safeQuantity, previousStock, newStock, reason, referenceType, referenceId: String(referenceId || ""), createdBy }],
    { session }
  );
  return { product, movement };
};

const validateProducts = async ({ businessId, items = [], session }) => {
  const ids = [...new Set(items.map((item) => item.productId).filter(Boolean).map(String))];
  ids.forEach((id) => assertObjectId(id, "product"));
  if (!ids.length) return new Map();
  const products = await Product.find({ _id: { $in: ids }, businessId }).session(session);
  if (products.length !== ids.length) throw new AppError("One or more products are invalid for this business", 400);
  return new Map(products.map((product) => [product._id.toString(), product]));
};

const validateApprovalSource = async ({ businessId, sourceType, sourceId }) => {
  const normalized = String(sourceType || "GENERAL").toUpperCase();
  if (normalized === "GENERAL") return { sourceType: "GENERAL", sourceId: null };
  assertObjectId(sourceId, "approval source");
  const sourceModels = {
    ORDER: Order,
    INVOICE: Invoice,
    PURCHASE: Purchase,
    PROJECT: Project,
    TASK: Task,
  };
  const Model = sourceModels[normalized];
  if (!Model) throw new AppError("Invalid approval source type", 400);
  const source = await Model.findOne({ _id: sourceId, businessId }).select("_id");
  if (!source) throw new AppError("Approval source not found for this business", 404);
  return { sourceType: normalized, sourceId: source._id };
};

const createProductionJob = async ({ businessId, userId, payload, req }) => {
  const session = await mongoose.startSession();
  try {
    let job;
    await session.withTransaction(async () => {
      const business = await Business.findById(businessId).session(session);
      if (!business) throw new AppError("Business not found", 404);
      if (payload.sourceKey) {
        job = await ProductionJob.findOne({ businessId, sourceKey: payload.sourceKey }).session(session);
        if (job) return;
      }
      const inputItems = Array.isArray(payload.inputItems) ? payload.inputItems : [];
      const productMap = await validateProducts({ businessId, items: [...inputItems, payload.outputProductId ? { productId: payload.outputProductId } : null].filter(Boolean), session });
      inputItems.forEach((item) => normalizeQuantity(item.quantity, "Input quantity"));
      const outputQuantity = normalizeQuantity(payload.outputQuantity || 0, "Output quantity", { allowZero: true });
      if (payload.sourceOrderId) {
        const order = await Order.findOne({ _id: payload.sourceOrderId, businessId }).session(session);
        if (!order) throw new AppError("Source order not found", 404);
      }
      const [created] = await ProductionJob.create(
        [{
          businessId,
          sourceKey: payload.sourceKey || "",
          jobNumber: nextNumber({ business, field: "productionJobNumbering", prefix: "JOB", format: "JOB-{YYYY}-{0001}" }),
          title: payload.title,
          sourceOrderId: payload.sourceOrderId || null,
          outputProductId: payload.outputProductId || null,
          outputQuantity,
          inputItems: inputItems.map((item) => ({ productId: item.productId, productName: productMap.get(String(item.productId))?.name || "", quantity: normalizeQuantity(item.quantity, "Input quantity") })),
          dueDate: normalizeDate(payload.dueDate, "due date"),
          notes: payload.notes || "",
          createdBy: userId,
        }],
        { session }
      );
      await business.save({ session });
      job = created;
    });
    await writeAuditLog({ req, businessId, action: "PRODUCTION_JOB_CREATED", entityType: "ProductionJob", entityId: job._id });
    return job;
  } finally {
    session.endSession();
  }
};

const listProductionJobs = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  return ProductionJob.find(filter).populate("outputProductId", "name sku").sort("-createdAt");
};

const setProductionJobStatus = async ({ businessId, userId, id, status, req }) => {
  const session = await mongoose.startSession();
  try {
    let job;
    await session.withTransaction(async () => {
      const business = await Business.findById(businessId).session(session);
      job = await ProductionJob.findOne({ _id: id, businessId }).session(session);
      if (!business || !job) throw new AppError("Production job not found", 404);
      const next = String(status || "").toUpperCase();
      assertTransition(PRODUCTION_TRANSITIONS, job.status, next, "production job");
      if (next === "COMPLETED") {
        job = await ProductionJob.findOneAndUpdate(
          { _id: id, businessId, status: "IN_PROGRESS", stockApplied: { $ne: true } },
          { $set: { status: "COMPLETED", completedAt: new Date(), stockApplied: true, stockAppliedAt: new Date(), updatedBy: userId } },
          { new: true, session }
        );
        if (!job) throw new AppError("Production job stock has already been applied or status changed", 409);
        for (const item of job.inputItems) {
          await applyStockDelta({ business, businessId, productId: item.productId, type: "OUT", quantity: item.quantity, reason: `Production job ${job.jobNumber} input consumption`, referenceType: "MANUAL", referenceId: job._id, createdBy: userId, session });
        }
        if (job.outputProductId && job.outputQuantity > 0) {
          await applyStockDelta({ business, businessId, productId: job.outputProductId, type: "IN", quantity: job.outputQuantity, reason: `Production job ${job.jobNumber} output`, referenceType: "MANUAL", referenceId: job._id, createdBy: userId, session });
        }
        return;
      }
      if (next === "IN_PROGRESS") job.startedAt = job.startedAt || new Date();
      job.status = next;
      job.updatedBy = userId;
      await job.save({ session });
    });
    await writeAuditLog({ req, businessId, action: `PRODUCTION_JOB_${job.status}`, entityType: "ProductionJob", entityId: job._id });
    return job;
  } finally {
    session.endSession();
  }
};

const createBatch = async ({ businessId, userId, payload, req }) => {
  assertObjectId(payload.productId, "product");
  const batchNumber = String(payload.batchNumber || "").trim();
  if (!batchNumber) throw new AppError("Batch number is required", 400);
  const quantityOnHand = normalizeQuantity(payload.quantityOnHand || 0, "Batch quantity", { allowZero: true });
  const [product, purchase] = await Promise.all([
    Product.findOne({ _id: payload.productId, businessId }),
    payload.sourcePurchaseId ? Purchase.findOne({ _id: payload.sourcePurchaseId, businessId }) : null,
  ]);
  if (!product) throw new AppError("Product not found", 404);
  if (payload.sourcePurchaseId && !purchase) throw new AppError("Source purchase not found", 404);
  if (payload.expiryDate && payload.manufactureDate && normalizeDate(payload.expiryDate, "expiry date") < normalizeDate(payload.manufactureDate, "manufacture date")) {
    throw new AppError("Expiry date cannot be before manufacture date", 400);
  }
  const sourceKey = String(payload.sourceKey || (payload.sourcePurchaseId ? `PURCHASE:${payload.sourcePurchaseId}:PRODUCT:${product._id}:BATCH:${batchNumber}` : "")).trim();
  const batch = await ProductBatch.findOneAndUpdate(
    sourceKey ? { businessId, sourceKey } : { businessId, productId: product._id, batchNumber },
    {
      $setOnInsert: {
        businessId,
        productId: product._id,
        sourceKey,
        batchNumber,
        manufactureDate: normalizeDate(payload.manufactureDate, "manufacture date"),
        expiryDate: normalizeDate(payload.expiryDate, "expiry date"),
        quantityOnHand,
        sourcePurchaseId: payload.sourcePurchaseId || null,
        notes: payload.notes || "",
        createdBy: userId,
      },
    },
    { upsert: true, new: true }
  );
  await writeAuditLog({ req, businessId, action: "BATCH_CREATED", entityType: "ProductBatch", entityId: batch._id });
  return batch;
};

const listBatches = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.productId) filter.productId = query.productId;
  if (query.status) filter.status = String(query.status).toUpperCase();
  const expiryFilter = {};
  if (query.expiryFrom) expiryFilter.$gte = normalizeDate(query.expiryFrom, "expiry start");
  if (query.expiryTo) expiryFilter.$lte = normalizeDate(query.expiryTo, "expiry end");
  if (query.expiringWithinDays !== undefined) {
    const days = Number(query.expiringWithinDays);
    if (!Number.isFinite(days) || days < 0) throw new AppError("Expiry window must be zero or greater", 400);
    expiryFilter.$gte = new Date();
    expiryFilter.$lte = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    filter.status = filter.status || "ACTIVE";
  }
  if (Object.keys(expiryFilter).length) filter.expiryDate = expiryFilter;
  return ProductBatch.find(filter).populate("productId", "name sku").sort("expiryDate");
};

const setBatchStatus = async ({ businessId, userId, id, status, req }) => {
  const batch = await ProductBatch.findOne({ _id: id, businessId });
  if (!batch) throw new AppError("Batch not found", 404);
  const next = String(status || "").toUpperCase();
  assertTransition(BATCH_TRANSITIONS, batch.status, next, "batch");
  batch.status = next;
  batch.updatedBy = userId;
  await batch.save();
  await writeAuditLog({ req, businessId, action: `BATCH_${next}`, entityType: "ProductBatch", entityId: batch._id });
  return batch;
};

const createDispatch = async ({ businessId, userId, payload, req }) => {
  const session = await mongoose.startSession();
  try {
    let dispatch;
    await session.withTransaction(async () => {
      const business = await Business.findById(businessId).session(session);
      if (!business) throw new AppError("Business not found", 404);
      const order = payload.orderId ? await Order.findOne({ _id: payload.orderId, businessId }).session(session) : null;
      const invoice = payload.invoiceId ? await Invoice.findOne({ _id: payload.invoiceId, businessId }).session(session) : null;
      const sourceKey = String(payload.sourceKey || (order?._id ? `ORDER:${order._id}:DISPATCH` : invoice?._id ? `INVOICE:${invoice._id}:DISPATCH` : "")).trim();
      if (sourceKey) {
        dispatch = await DispatchFulfilment.findOne({ businessId, sourceKey }).session(session);
        if (dispatch) return;
      }
      if (payload.orderId && !order) throw new AppError("Order not found", 404);
      if (payload.invoiceId && !invoice) throw new AppError("Invoice not found", 404);
      if (order && invoice && String(order.customerId) !== String(invoice.customerId)) throw new AppError("Order and invoice customer mismatch", 400);
      if (payload.customerId && order?.customerId && String(payload.customerId) !== String(order.customerId)) throw new AppError("Dispatch customer does not match order", 400);
      if (payload.customerId && invoice?.customerId && String(payload.customerId) !== String(invoice.customerId)) throw new AppError("Dispatch customer does not match invoice", 400);
      const customerId = payload.customerId || order?.customerId || invoice?.customerId;
      const customer = await Customer.findOne({ _id: customerId, businessId }).session(session);
      if (!customer) throw new AppError("Customer not found", 404);
      const rawItems = Array.isArray(payload.items) && payload.items.length ? payload.items : order?.lineItems || invoice?.lineItems || [];
      rawItems.forEach((item) => normalizeQuantity(item.quantity, "Dispatch quantity"));
      const productMap = await validateProducts({ businessId, items: rawItems, session });
      const [created] = await DispatchFulfilment.create(
        [{
          businessId,
          sourceKey,
          dispatchNumber: nextNumber({ business, field: "dispatchNumbering", prefix: "DSP", format: "DSP-{YYYY}-{0001}" }),
          orderId: order?._id || null,
          invoiceId: invoice?._id || null,
          customerId: customer._id,
          items: rawItems.map((item) => ({ orderLineId: item._id || item.orderLineId || null, productId: item.productId, productName: item.productName || productMap.get(String(item.productId))?.name || "", quantity: normalizeQuantity(item.quantity, "Dispatch quantity") })),
          carrier: payload.carrier || "",
          trackingNumber: payload.trackingNumber || "",
          dispatchDate: normalizeDate(payload.dispatchDate, "dispatch date"),
          notes: payload.notes || "",
          createdBy: userId,
        }],
        { session }
      );
      await business.save({ session });
      dispatch = created;
    });
    await writeAuditLog({ req, businessId, action: "DISPATCH_CREATED", entityType: "DispatchFulfilment", entityId: dispatch._id });
    return dispatch;
  } finally {
    session.endSession();
  }
};

const listDispatches = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  return DispatchFulfilment.find(filter).populate("customerId", "name email phone").sort("-createdAt");
};

const setDispatchStatus = async ({ businessId, userId, id, status, req }) => {
  const dispatch = await DispatchFulfilment.findOne({ _id: id, businessId });
  if (!dispatch) throw new AppError("Dispatch not found", 404);
  const next = String(status || "").toUpperCase();
  assertTransition(DISPATCH_TRANSITIONS, dispatch.status, next, "dispatch");
  dispatch.status = next;
  if (next === "DISPATCHED") dispatch.dispatchDate = dispatch.dispatchDate || new Date();
  if (next === "DELIVERED") dispatch.deliveredAt = new Date();
  dispatch.updatedBy = userId;
  await dispatch.save();
  await writeAuditLog({ req, businessId, action: `DISPATCH_${next}`, entityType: "DispatchFulfilment", entityId: dispatch._id });
  return dispatch;
};

const createApprovalDocument = async ({ businessId, userId, payload, req }) => {
  const approverIds = [...new Set((payload.approvers || []).map(String))];
  approverIds.forEach((id) => assertObjectId(id, "approver"));
  const users = approverIds.length ? await User.find({ _id: { $in: approverIds }, businessId, isActive: true }).select("_id") : [];
  if (users.length !== approverIds.length) throw new AppError("One or more approvers are not part of this business", 400);
  const source = await validateApprovalSource({ businessId, sourceType: payload.sourceType, sourceId: payload.sourceId });
  const sourceKey = String(payload.sourceKey || (source.sourceId ? `APPROVAL:${source.sourceType}:${source.sourceId}` : "")).trim();
  const document = await ApprovalDocument.findOneAndUpdate(
    sourceKey ? { businessId, sourceKey } : { businessId, sourceKey: `DOC:${new mongoose.Types.ObjectId()}` },
    {
      $setOnInsert: {
        businessId,
        sourceKey,
        title: payload.title,
        documentType: payload.documentType || "GENERAL",
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        approvers: users.map((user) => ({ userId: user._id })),
        notes: payload.notes || "",
        createdBy: userId,
      },
    },
    { upsert: true, new: true }
  );
  await writeAuditLog({ req, businessId, action: "APPROVAL_DOCUMENT_CREATED", entityType: "ApprovalDocument", entityId: document._id });
  return document;
};

const listApprovalDocuments = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  return ApprovalDocument.find(filter).populate("approvers.userId", "name email").sort("-createdAt");
};

const setApprovalStatus = async ({ businessId, userId, role, id, status, comment = "", req }) => {
  const document = await ApprovalDocument.findOne({ _id: id, businessId });
  if (!document) throw new AppError("Approval document not found", 404);
  const next = String(status || "").toUpperCase();
  assertTransition(APPROVAL_TRANSITIONS, document.status, next, "approval document");
  const ownStep = document.approvers.find((step) => String(step.userId) === String(userId));
  const isAdminApprover = ["owner", "admin"].includes(String(role || "").toLowerCase());
  if (["APPROVED", "REJECTED"].includes(next) && document.approvers.length && !ownStep && !isAdminApprover) {
    throw new AppError("Only assigned approvers can approve or reject this document", 403);
  }
  document.status = next;
  document.updatedBy = userId;
  if (ownStep && ["APPROVED", "REJECTED"].includes(next)) {
    ownStep.status = next;
    ownStep.actedAt = new Date();
    ownStep.comment = comment;
  }
  await document.save();
  await writeAuditLog({ req, businessId, action: `APPROVAL_DOCUMENT_${next}`, entityType: "ApprovalDocument", entityId: document._id });
  return document;
};

module.exports = {
  APPROVAL_TRANSITIONS,
  BATCH_TRANSITIONS,
  DISPATCH_TRANSITIONS,
  PRODUCTION_TRANSITIONS,
  createApprovalDocument,
  createBatch,
  createDispatch,
  createProductionJob,
  listApprovalDocuments,
  listBatches,
  listDispatches,
  listProductionJobs,
  setApprovalStatus,
  setBatchStatus,
  setDispatchStatus,
  setProductionJobStatus,
};
