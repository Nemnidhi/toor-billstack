const mongoose = require("mongoose");

const Appointment = require("../models/Appointment");
const Business = require("../models/Business");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Project = require("../models/Project");
const Quote = require("../models/Quote");
const RecurringBillingProfile = require("../models/RecurringBillingProfile");
const StockMovement = require("../models/StockMovement");
const Task = require("../models/Task");
const User = require("../models/User");
const AppError = require("../utils/appError");
const { buildGstSnapshot } = require("../utils/gst");
const { buildTaxDocument } = require("../utils/tax-document");
const { buildInvoiceNumber, buildInvoiceTotals } = require("../utils/invoice");
const { log } = require("../utils/logger");
const { buildInventoryFlags } = require("./inventory.service");
const { writeAuditLog } = require("./audit.service");
const { createCustomerLedgerEntryOnce } = require("./ledger.service");
const { dispatchInvoiceIssuedAutomation, scheduleWorkflowMessage } = require("./communication.service");
const { cleanText, resolveOrCreateCatalogService } = require("./service-catalog.service");

const ORDER_TRANSITIONS = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PARTIALLY_FULFILLED", "FULFILLED", "CANCELLED"],
  PARTIALLY_FULFILLED: ["FULFILLED", "CANCELLED"],
  FULFILLED: [],
  CANCELLED: [],
};

const PROJECT_TRANSITIONS = {
  PLANNING: ["ACTIVE", "ON_HOLD", "CANCELLED"],
  ACTIVE: ["ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["ACTIVE", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const TASK_TRANSITIONS = {
  TODO: ["IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"],
  IN_PROGRESS: ["TODO", "BLOCKED", "DONE", "CANCELLED"],
  BLOCKED: ["TODO", "IN_PROGRESS", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

const RECURRING_TRANSITIONS = {
  DRAFT: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAUSED", "COMPLETED", "CANCELLED"],
  PAUSED: ["ACTIVE", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

const APPOINTMENT_TRANSITIONS = {
  SCHEDULED: ["CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"],
  CONFIRMED: ["COMPLETED", "CANCELLED", "NO_SHOW"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

const RECURRING_FREQUENCIES = ["WEEKLY", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"];

const assertObjectId = (value, label) => {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new AppError(`Invalid ${label}`, 400);
};

const normalizeDate = (value, label, required = false) => {
  if (!value && !required) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(`Invalid ${label}`, 400);
  return date;
};

const assertTransition = (map, current, next, label) => {
  if (!map[current]?.includes(next)) throw new AppError(`Invalid ${label} lifecycle transition`, 400);
};

const buildCustomerSnapshot = (customer) => ({
  name: customer.name,
  email: customer.email,
  phone: customer.phone,
  address: customer.billingAddress,
  gstNumber: customer.gstNumber,
});

const buildBusinessSnapshot = (business) => ({
  name: business.name,
  email: business.email || business.billingEmail,
  phone: business.phone,
  address: business.address,
  gstNumber: business.gstTaxId || business.gstConfiguration?.gstin,
});

const nextNumber = ({ business, field, prefix, format, date = new Date() }) => {
  const numbering = business[field] || {};
  const sequence = numbering.nextSequence || 1;
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
  };
  return value;
};

const normalizeLineItems = async ({ businessId, rawItems, session, allowManualServices = false }) => {
  let items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) throw new AppError("At least one line item is required", 400);
  if (allowManualServices) {
    // Workspaces without a visible product catalog (e.g. office rental) bill typed services.
    // Resolve each typed service to a reusable catalog entry so invoices keep a product reference.
    items = await Promise.all(items.map(async (item) => {
      if (item.productId && mongoose.Types.ObjectId.isValid(item.productId)) return item;
      const typedName = cleanText(item.productName || item.serviceName || item.name);
      if (!typedName) throw new AppError("Select a service or type the service name", 400);
      const { product } = await resolveOrCreateCatalogService({
        businessId,
        item: { ...item, productName: typedName, serviceName: typedName },
        session,
      });
      return { ...item, productId: product._id };
    }));
  }
  items.forEach((item) => {
    if (!item.productId) throw new AppError("Select a product or service for every line item", 400);
    assertObjectId(item.productId, "product");
  });

  const products = await Product.find({ _id: { $in: items.map((item) => item.productId) }, businessId }).session(session);
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));

  return {
    products,
    lineItems: items.map((item) => {
      const product = productMap.get(String(item.productId));
      if (!product) throw new AppError("One or more products are invalid for this business", 400);
      const quantity = Number(item.quantity || 0);
      const rate = Number(item.rate ?? product.sellingPrice ?? 0);
      if (!Number.isFinite(quantity) || quantity <= 0) throw new AppError("Quantity must be greater than zero", 400);
      if (!Number.isFinite(rate) || rate < 0) throw new AppError("Rate must be a valid non-negative amount", 400);
      return {
        productId: product._id,
        productName: product.name,
        quantity,
        rate,
        taxRate: Number(item.taxRate ?? item.tax ?? product.taxRate ?? 0),
        discountType: item.discountType === "amount" ? "amount" : "percent",
        discountValue: Number(item.discountValue !== undefined ? item.discountValue : item.discount ?? 0),
        snapshot: {
          sku: product.sku,
          hsnSac: product.hsnSac,
          gstClassification: product.gstClassification,
          trackInventory: product.trackInventory,
        },
      };
    }),
  };
};

const applyWorkflowInvoiceStockDeduction = async ({ business, businessId, invoice, lineItems, products, createdBy, session }) => {
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));

  for (const item of lineItems) {
    const product = productMap.get(String(item.productId));
    if (!product) continue;
    if (!product.trackInventory) continue;

    const quantity = Number(item.quantity || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new AppError("Invoice stock quantity is invalid", 400);

    const previousStock = Number(product.currentStock || 0);
    const newStock = previousStock - quantity;

    if (!business.inventorySettings?.allowNegativeStock && newStock < 0) {
      throw new AppError(`Insufficient stock for ${product.name}`, 403);
    }

    product.currentStock = newStock;
    const flags = buildInventoryFlags(product);
    product.isLowStock = flags.isLowStock;
    product.isOutOfStock = flags.isOutOfStock;
    await product.save({ session });

    await StockMovement.create(
      [
        {
          businessId,
          productId: product._id,
          type: "OUT",
          quantity,
          previousStock,
          newStock,
          reason: `Workflow invoice issue for ${invoice.invoiceNumber}`,
          referenceType: "INVOICE",
          referenceId: invoice._id.toString(),
          createdBy,
        },
      ],
      { session }
    );
  }
};

const createInvoiceFromWorkflow = async ({ business, customer, lineItems, source, userId, session }) => {
  if (!business || !customer) throw new AppError("Business or customer not found", 404);
  const existingQuery = source.type === "ORDER"
    ? { businessId: business._id, sourceOrderId: source.id }
    : { businessId: business._id, sourceRecurringProfileId: source.id, recurringOccurrenceKey: source.occurrenceKey };
  const existing = await Invoice.findOne(existingQuery).session(session);
  if (existing) return existing;

  const invoiceDate = new Date();
  const products = await Product.find({ _id: { $in: lineItems.map((item) => item.productId) }, businessId: business._id }).session(session);
  const { totals, gstSnapshot } = buildTaxDocument({ business, counterparty: customer, products, lineItems, placeOfSupplyCode: source.placeOfSupplyCode, amountPaid: 0 });
  const invoiceNumber = nextNumber({ business, field: "invoiceNumbering", prefix: "INV", format: "INV-{YYYY}-{0001}", date: invoiceDate });

  const payload = {
    businessId: business._id,
    customerId: customer._id,
    invoiceNumber,
    invoiceDate,
    dueDate: new Date(invoiceDate.getTime() + Number(source.paymentTermsDays || 0) * 24 * 60 * 60 * 1000),
    customerDetails: buildCustomerSnapshot(customer),
    businessDetails: buildBusinessSnapshot(business),
    lineItems: totals.lineItems,
    subtotal: totals.subtotal,
    totalTax: totals.totalTax,
    totalDiscount: totals.totalDiscount,
    shippingCharges: totals.shippingCharges,
    roundOff: totals.roundOff,
    grandTotal: totals.grandTotal,
    amountPaid: 0,
    balanceDue: totals.grandTotal,
    paymentStatus: "unpaid",
    gstSnapshot,
    gstBreakup: gstSnapshot ? { cgst: gstSnapshot.cgst, sgst: gstSnapshot.sgst, utgst: gstSnapshot.utgst, igst: gstSnapshot.igst, taxableValue: gstSnapshot.taxableValue, hsnSacSummary: gstSnapshot.hsnSacSummary } : undefined,
    status: "issued",
    createdBy: userId,
  };
  if (source.type === "ORDER") payload.sourceOrderId = source.id;
  if (source.type === "RECURRING") {
    payload.sourceRecurringProfileId = source.id;
    payload.recurringOccurrenceKey = source.occurrenceKey;
  }

  const [invoice] = await Invoice.create([payload], { session });
  await applyWorkflowInvoiceStockDeduction({
    business,
    businessId: business._id,
    invoice,
    lineItems: totals.lineItems,
    products,
    createdBy: userId,
    session,
  });
  await createCustomerLedgerEntryOnce({ businessId: business._id, customerId: customer._id, eventType: "INVOICE", amount: invoice.grandTotal, direction: "DEBIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:DEBIT`, createdBy: userId }, { session });
  await business.save({ session });
  return invoice;
};

const createOrder = async ({ businessId, userId, payload, req }) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      const [business, customer] = await Promise.all([
        Business.findById(businessId).session(session),
        Customer.findOne({ _id: payload.customerId, businessId }).session(session),
      ]);
      if (!business || !customer) throw new AppError("Business or customer not found", 404);
      const quote = payload.quoteId ? await Quote.findOne({ _id: payload.quoteId, businessId, customerId: customer._id }).session(session) : null;
      if (payload.quoteId && !quote) throw new AppError("Quote not found for this customer", 404);
      if (quote) {
        const existingOrder = await Order.findOne({ businessId, quoteId: quote._id }).session(session);
        if (existingOrder) {
          order = existingOrder;
          return;
        }
      }
      const { products, lineItems } = await normalizeLineItems({ businessId, rawItems: payload.lineItems || quote?.lineItems, session });
      const totals = buildInvoiceTotals({ lineItems });
      const orderDate = normalizeDate(payload.orderDate, "order date") || new Date();
      const gstSnapshot = business.gstConfiguration?.enabled ? buildGstSnapshot({ business, counterparty: customer, lineItems: totals.lineItems, products }) : null;
      [order] = await Order.create([{
        businessId,
        customerId: customer._id,
        quoteId: quote?._id || null,
        orderNumber: nextNumber({ business, field: "orderNumbering", prefix: "ORD", format: "ORD-{YYYY}-{0001}", date: orderDate }),
        orderDate,
        expectedDeliveryDate: normalizeDate(payload.expectedDeliveryDate, "expected delivery date"),
        lineItems: totals.lineItems,
        subtotal: totals.subtotal,
        totalTax: totals.totalTax,
        totalDiscount: totals.totalDiscount,
        grandTotal: totals.grandTotal,
        gstSnapshot,
        customerSnapshot: buildCustomerSnapshot(customer),
        businessSnapshot: buildBusinessSnapshot(business),
        notes: payload.notes || "",
        terms: payload.terms || "",
        internalNotes: payload.internalNotes || "",
        createdBy: userId,
      }], { session });
      await business.save({ session });
    });
    await writeAuditLog({ req, businessId, action: "ORDER_CREATED", entityType: "Order", entityId: order._id });
    return order;
  } finally {
    session.endSession();
  }
};

const listOrders = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.fulfilmentStatus) filter.fulfilmentStatus = String(query.fulfilmentStatus).toUpperCase();
  if (query.customerId) filter.customerId = query.customerId;
  if (query.search) filter.orderNumber = { $regex: String(query.search), $options: "i" };
  return Order.find(filter).populate("customerId", "name email phone").sort("-orderDate");
};

const getOrder = ({ businessId, id }) => Order.findOne({ _id: id, businessId }).populate("customerId", "name email phone").populate("invoiceIds", "invoiceNumber grandTotal paymentStatus status");

const updateOrder = async ({ businessId, userId, id, payload }) => {
  const order = await Order.findOne({ _id: id, businessId });
  if (!order) throw new AppError("Order not found", 404);
  if (!["DRAFT", "CONFIRMED"].includes(order.status)) throw new AppError("Order cannot be edited after processing starts", 400);
  ["notes", "terms", "internalNotes"].forEach((field) => {
    if (payload[field] !== undefined) order[field] = payload[field];
  });
  order.expectedDeliveryDate = payload.expectedDeliveryDate ? normalizeDate(payload.expectedDeliveryDate, "expected delivery date") : order.expectedDeliveryDate;
  order.updatedBy = userId;
  return order.save();
};

const setOrderStatus = async ({ businessId, userId, id, status, req }) => {
  const order = await Order.findOne({ _id: id, businessId });
  if (!order) throw new AppError("Order not found", 404);
  const next = String(status || "").toUpperCase();
  assertTransition(ORDER_TRANSITIONS, order.status, next, "order");
  order.status = next;
  order.updatedBy = userId;
  await order.save();
  await writeAuditLog({ req, businessId, action: `ORDER_${next}`, entityType: "Order", entityId: order._id });
  return order;
};

const updateOrderFulfilment = async ({ businessId, userId, id, items = [], req }) => {
  const order = await Order.findOne({ _id: id, businessId });
  if (!order) throw new AppError("Order not found", 404);
  if (order.status === "CANCELLED") throw new AppError("Cancelled order cannot be fulfilled", 400);
  const byLine = new Map(items.map((item) => [String(item.lineItemId), Number(item.fulfilledQuantity)]));
  order.lineItems.forEach((line) => {
    if (!byLine.has(String(line._id))) return;
    const qty = byLine.get(String(line._id));
    if (!Number.isFinite(qty) || qty < 0 || qty > line.quantity) throw new AppError("Fulfilled quantity is invalid", 400);
    line.fulfilledQuantity = qty;
  });
  const total = order.lineItems.reduce((sum, item) => sum + item.quantity, 0);
  const fulfilled = order.lineItems.reduce((sum, item) => sum + item.fulfilledQuantity, 0);
  order.fulfilmentStatus = fulfilled <= 0 ? "NOT_STARTED" : fulfilled >= total ? "FULFILLED" : "PARTIAL";
  if (order.fulfilmentStatus === "FULFILLED") order.status = "FULFILLED";
  else if (order.fulfilmentStatus === "PARTIAL") order.status = "PARTIALLY_FULFILLED";
  else if (order.status === "CONFIRMED") order.status = "PROCESSING";
  order.updatedBy = userId;
  await order.save();
  await writeAuditLog({ req, businessId, action: "ORDER_FULFILMENT_UPDATED", entityType: "Order", entityId: order._id });
  return order;
};

const convertOrderToInvoice = async ({ businessId, userId, id, req }) => {
  const session = await mongoose.startSession();
  try {
    let invoice;
    await session.withTransaction(async () => {
      const order = await Order.findOne({ _id: id, businessId }).session(session);
      if (!order) throw new AppError("Order not found", 404);
      if (order.status === "CANCELLED") throw new AppError("Cancelled order cannot be converted", 400);
      if (order.invoiceIds?.length) {
        invoice = await Invoice.findOne({ _id: order.invoiceIds[0], businessId }).session(session);
        return;
      }
      const [business, customer] = await Promise.all([
        Business.findById(businessId).session(session),
        Customer.findOne({ _id: order.customerId, businessId }).session(session),
      ]);
      invoice = await createInvoiceFromWorkflow({ business, customer, lineItems: order.lineItems, source: { type: "ORDER", id: order._id }, userId, session });
      order.invoiceIds = [invoice._id];
      await order.save({ session });
    });
    await writeAuditLog({ req, businessId, action: "ORDER_CONVERTED_TO_INVOICE", entityType: "Invoice", entityId: invoice._id });
    if (invoice?._id) {
      await dispatchInvoiceIssuedAutomation({ businessId, invoiceId: invoice._id, createdBy: userId })
        .catch((error) => log("warn", "Order invoice issued automation failed", { invoiceId: invoice._id.toString(), error: error.message }));
    }
    return invoice;
  } finally {
    session.endSession();
  }
};

const validateUsers = async ({ businessId, userIds = [] }) => {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  ids.forEach((id) => assertObjectId(id, "user"));
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids }, businessId, isActive: true }).select("_id");
  if (users.length !== ids.length) throw new AppError("One or more assignees are not part of this business", 400);
  return users.map((user) => user._id);
};

const createProject = async ({ businessId, userId, payload }) => {
  const session = await mongoose.startSession();
  try {
    let project;
    await session.withTransaction(async () => {
      const business = await Business.findById(businessId).session(session);
      if (!business) throw new AppError("Business not found", 404);
      if (payload.customerId) {
        const customer = await Customer.findOne({ _id: payload.customerId, businessId }).session(session);
        if (!customer) throw new AppError("Customer not found", 404);
      }
      const assignedUsers = await validateUsers({ businessId, userIds: payload.assignedUsers || [] });
      const [managerId] = await validateUsers({ businessId, userIds: [payload.managerId || userId] });
      const startDate = normalizeDate(payload.startDate, "start date");
      const dueDate = normalizeDate(payload.dueDate, "due date");
      if (startDate && dueDate && dueDate < startDate) throw new AppError("Project due date cannot be before start date", 400);
      [project] = await Project.create([{
        businessId,
        projectNumber: nextNumber({ business, field: "projectNumbering", prefix: "PRJ", format: "PRJ-{YYYY}-{0001}" }),
        name: String(payload.name || `${customer.name} monthly billing`).trim(),
        customerId: payload.customerId || null,
        description: payload.description || "",
        projectType: payload.projectType || "",
        priority: String(payload.priority || "MEDIUM").toUpperCase(),
        startDate,
        dueDate,
        assignedUsers,
        managerId,
        estimatedValue: Number(payload.estimatedValue || 0),
        tags: payload.tags || [],
        notes: payload.notes || "",
        createdBy: userId,
      }], { session });
      await business.save({ session });
    });
    await writeAuditLog({ businessId, action: "PROJECT_CREATED", entityType: "Project", entityId: project._id });
    return project;
  } finally {
    session.endSession();
  }
};

const listProjects = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.customerId) filter.customerId = query.customerId;
  return Project.find(filter).populate("customerId", "name").populate("assignedUsers", "name email").sort("-createdAt");
};

const getProject = ({ businessId, id }) => Project.findOne({ _id: id, businessId }).populate("customerId", "name").populate("assignedUsers", "name email");

const updateProject = async ({ businessId, userId, id, payload }) => {
  const project = await Project.findOne({ _id: id, businessId });
  if (!project) throw new AppError("Project not found", 404);
  const previousStatus = project.status;
  if (payload.status && payload.status !== project.status) assertTransition(PROJECT_TRANSITIONS, project.status, String(payload.status).toUpperCase(), "project");
  Object.assign(project, {
    name: payload.name ?? project.name,
    description: payload.description ?? project.description,
    projectType: payload.projectType ?? project.projectType,
    status: payload.status ? String(payload.status).toUpperCase() : project.status,
    priority: payload.priority ? String(payload.priority).toUpperCase() : project.priority,
    dueDate: payload.dueDate ? normalizeDate(payload.dueDate, "due date") : project.dueDate,
    updatedBy: userId,
  });
  if (project.status === "COMPLETED" && !project.completedAt) project.completedAt = new Date();
  await project.save();
  if (project.status !== previousStatus) await writeAuditLog({ businessId, action: `PROJECT_${project.status}`, entityType: "Project", entityId: project._id });
  return project;
};

const createTask = async ({ businessId, userId, payload }) => {
  if (payload.projectId) {
    const project = await Project.findOne({ _id: payload.projectId, businessId });
    if (!project) throw new AppError("Project not found", 404);
  }
  const [assignedTo] = await validateUsers({ businessId, userIds: payload.assignedTo ? [payload.assignedTo] : [] });
  const task = await Task.create({
    businessId,
    projectId: payload.projectId || null,
    title: payload.title,
    description: payload.description || "",
    priority: String(payload.priority || "MEDIUM").toUpperCase(),
    assignedTo: assignedTo || null,
    dueDate: normalizeDate(payload.dueDate, "due date"),
    tags: payload.tags || [],
    notes: payload.notes || "",
    createdBy: userId,
  });
  await writeAuditLog({ businessId, action: "TASK_CREATED", entityType: "Task", entityId: task._id });
  return task;
};

const listTasks = ({ businessId, userId, query = {} }) => {
  const filter = { businessId };
  if (query.mine === "true") filter.assignedTo = userId;
  if (query.projectId) filter.projectId = query.projectId;
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.priority) filter.priority = String(query.priority).toUpperCase();
  return Task.find(filter).populate("projectId", "projectNumber name").populate("assignedTo", "name email").sort("dueDate -createdAt");
};

const updateTask = async ({ businessId, userId, id, payload }) => {
  const task = await Task.findOne({ _id: id, businessId });
  if (!task) throw new AppError("Task not found", 404);
  const previousAssignee = task.assignedTo ? String(task.assignedTo) : "";
  const previousStatus = task.status;
  if (payload.status && payload.status !== task.status) assertTransition(TASK_TRANSITIONS, task.status, String(payload.status).toUpperCase(), "task");
  const [assignedTo] = await validateUsers({ businessId, userIds: payload.assignedTo ? [payload.assignedTo] : [] });
  Object.assign(task, {
    title: payload.title ?? task.title,
    description: payload.description ?? task.description,
    status: payload.status ? String(payload.status).toUpperCase() : task.status,
    priority: payload.priority ? String(payload.priority).toUpperCase() : task.priority,
    assignedTo: payload.assignedTo ? assignedTo : task.assignedTo,
    dueDate: payload.dueDate ? normalizeDate(payload.dueDate, "due date") : task.dueDate,
    notes: payload.notes ?? task.notes,
    updatedBy: userId,
  });
  if (task.status === "DONE" && !task.completedAt) task.completedAt = new Date();
  await task.save();
  if (task.status !== previousStatus) await writeAuditLog({ businessId, action: `TASK_${task.status}`, entityType: "Task", entityId: task._id });
  if ((task.assignedTo ? String(task.assignedTo) : "") !== previousAssignee) await writeAuditLog({ businessId, action: "TASK_REASSIGNED", entityType: "Task", entityId: task._id });
  return task;
};

const addInterval = (date, frequency, interval = 1) => {
  if (!RECURRING_FREQUENCIES.includes(frequency)) throw new AppError("Invalid recurring billing frequency", 400);
  if (!Number.isInteger(Number(interval)) || Number(interval) <= 0) throw new AppError("Recurring interval must be a positive integer", 400);
  const next = new Date(date);
  if (frequency === "WEEKLY") next.setDate(next.getDate() + 7 * interval);
  if (frequency === "MONTHLY") next.setMonth(next.getMonth() + interval);
  if (frequency === "QUARTERLY") next.setMonth(next.getMonth() + 3 * interval);
  if (frequency === "HALF_YEARLY") next.setMonth(next.getMonth() + 6 * interval);
  if (frequency === "YEARLY") next.setFullYear(next.getFullYear() + interval);
  return next;
};

const occurrenceKey = (profile, date = profile.nextBillingDate) => `${profile._id}:${new Date(date).toISOString().slice(0, 10)}`;

const createRecurringProfile = async ({ businessId, userId, payload }) => {
  const session = await mongoose.startSession();
  try {
    let profile;
    if (!payload.customerId || !mongoose.Types.ObjectId.isValid(payload.customerId)) throw new AppError("Select a client for this billing profile", 400);
    await session.withTransaction(async () => {
      const [business, customer] = await Promise.all([
        Business.findById(businessId).session(session),
        Customer.findOne({ _id: payload.customerId, businessId }).session(session),
      ]);
      if (!business || !customer) throw new AppError("Business or customer not found", 404);
      const startDate = normalizeDate(payload.startDate, "start date", true);
      const nextBillingDate = normalizeDate(payload.nextBillingDate || payload.startDate, "next billing date", true);
      const endDate = normalizeDate(payload.endDate, "end date");
      if (endDate && endDate < startDate) throw new AppError("End date cannot be before start date", 400);
      const frequency = String(payload.frequency || "MONTHLY").toUpperCase();
      const interval = Number(payload.interval || 1);
      if (!RECURRING_FREQUENCIES.includes(frequency)) throw new AppError("Invalid recurring billing frequency", 400);
      if (!Number.isInteger(interval) || interval <= 0) throw new AppError("Recurring interval must be a positive integer", 400);
      const { lineItems, products } = await normalizeLineItems({ businessId, rawItems: payload.lineItems, session, allowManualServices: true });
      const { totals } = buildTaxDocument({ business, counterparty: customer, products, lineItems, placeOfSupplyCode: payload.placeOfSupplyCode });
      [profile] = await RecurringBillingProfile.create([{
        businessId,
        customerId: customer._id,
        name: cleanText(payload.name) || `${customer.name} ${frequency.toLowerCase().replace("_", "-")} billing`,
        description: payload.description || "",
        lineItems: totals.lineItems,
        placeOfSupplyCode: payload.placeOfSupplyCode || customer.placeOfSupplyCode || customer.stateCode || "",
        subtotal: totals.subtotal,
        totalTax: totals.totalTax,
        totalDiscount: totals.totalDiscount,
        grandTotal: totals.grandTotal,
        frequency,
        interval,
        startDate,
        nextBillingDate,
        endDate,
        paymentTermsDays: Number(payload.paymentTermsDays || 0),
        renewalDate: normalizeDate(payload.renewalDate, "renewal date"),
        renewalReminderDays: Number(payload.renewalReminderDays || 30),
        autoRenew: Boolean(payload.autoRenew),
        createdBy: userId,
      }], { session });
      if (profile.renewalDate && customer.email) {
        const reminderAt = new Date(profile.renewalDate);
        reminderAt.setDate(reminderAt.getDate() - Number(profile.renewalReminderDays || 30));
        await scheduleWorkflowMessage({
          businessId,
          customerId: customer._id,
          channel: "EMAIL",
          scheduledFor: reminderAt,
          subject: "Recurring billing renewal reminder",
          content: `Renewal reminder for ${profile.name}. Renewal date: ${profile.renewalDate.toLocaleDateString("en-IN")}.`,
          recipient: customer.email || "",
          sourceKey: `RENEWAL:${profile._id}:EMAIL:${reminderAt.toISOString()}`,
          metadata: { workflowType: "RENEWAL", recurringProfileId: profile._id, scheduledFor: reminderAt },
          createdBy: userId,
          session,
        });
      }
    });
    await writeAuditLog({ businessId, action: "RECURRING_CREATED", entityType: "RecurringBillingProfile", entityId: profile._id });
    return profile;
  } finally {
    session.endSession();
  }
};

const listRecurringProfiles = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.customerId) filter.customerId = query.customerId;
  return RecurringBillingProfile.find(filter).populate("customerId", "name email").sort("nextBillingDate");
};

const getRecurringProfile = ({ businessId, id }) => RecurringBillingProfile.findOne({ _id: id, businessId }).populate("customerId", "name email").populate("generatedInvoices.invoiceId", "invoiceNumber grandTotal");

const setRecurringStatus = async ({ businessId, userId, id, status, req }) => {
  const profile = await RecurringBillingProfile.findOne({ _id: id, businessId });
  if (!profile) throw new AppError("Recurring profile not found", 404);
  const next = String(status || "").toUpperCase();
  assertTransition(RECURRING_TRANSITIONS, profile.status, next, "recurring billing");
  profile.status = next;
  profile.updatedBy = userId;
  await profile.save();
  await writeAuditLog({ req, businessId, action: `RECURRING_${next}`, entityType: "RecurringBillingProfile", entityId: profile._id });
  return profile;
};

const deleteRecurringProfile = async ({ businessId, id, req }) => {
  const profile = await RecurringBillingProfile.findOne({ _id: id, businessId });
  if (!profile) throw new AppError("Recurring profile not found", 404);
  if (profile.status !== "CANCELLED") throw new AppError("Cancel this monthly billing profile before deleting it", 400);
  if (profile.generatedInvoices?.length) throw new AppError("This profile has generated invoices and must be retained for history", 400);
  await RecurringBillingProfile.deleteOne({ _id: profile._id, businessId });
  await writeAuditLog({ req, businessId, action: "RECURRING_DELETED", entityType: "RecurringBillingProfile", entityId: profile._id });
  return { id: profile._id };
};

const generateRecurringInvoice = async ({ businessId, userId, id, runDate = new Date(), req }) => {
  const session = await mongoose.startSession();
  try {
    let invoice;
    await session.withTransaction(async () => {
      const profile = await RecurringBillingProfile.findOne({ _id: id, businessId }).session(session);
      if (!profile) throw new AppError("Recurring profile not found", 404);
      if (profile.status !== "ACTIVE") throw new AppError("Recurring profile must be active", 400);
      if (profile.endDate && profile.nextBillingDate > profile.endDate) throw new AppError("Recurring profile has ended", 400);
      const key = occurrenceKey(profile);
      const existing = await Invoice.findOne({ businessId, recurringOccurrenceKey: key }).session(session);
      if (existing) {
        invoice = existing;
        return;
      }
      const [business, customer] = await Promise.all([
        Business.findById(businessId).session(session),
        Customer.findOne({ _id: profile.customerId, businessId }).session(session),
      ]);
      invoice = await createInvoiceFromWorkflow({
        business,
        customer,
        lineItems: profile.lineItems,
        source: { type: "RECURRING", id: profile._id, occurrenceKey: key, paymentTermsDays: profile.paymentTermsDays, placeOfSupplyCode: profile.placeOfSupplyCode },
        userId,
        session,
      });
      profile.generatedInvoices.push({ invoiceId: invoice._id, occurrenceKey: key, generatedAt: runDate });
      profile.lastGeneratedAt = runDate;
      profile.nextBillingDate = addInterval(profile.nextBillingDate, profile.frequency, profile.interval);
      if (profile.endDate && profile.nextBillingDate > profile.endDate) profile.status = "COMPLETED";
      await profile.save({ session });
    });
    await writeAuditLog({ req, businessId, action: "RECURRING_INVOICE_GENERATED", entityType: "Invoice", entityId: invoice._id });
    if (invoice?._id) {
      await dispatchInvoiceIssuedAutomation({ businessId, invoiceId: invoice._id, createdBy: userId || invoice.createdBy })
        .catch((error) => log("warn", "Recurring invoice issued automation failed", { invoiceId: invoice._id.toString(), error: error.message }));
    }
    return invoice;
  } finally {
    session.endSession();
  }
};

const processDueRecurringProfiles = async ({ businessId, userId, now = new Date() }) => {
  const profiles = await RecurringBillingProfile.find({ businessId, status: "ACTIVE", autoGenerateInvoice: true, nextBillingDate: { $lte: now } }).sort("nextBillingDate").limit(25);
  const results = [];
  for (const profile of profiles) {
    results.push(await generateRecurringInvoice({ businessId, userId: userId || profile.createdBy, id: profile._id, runDate: now }));
  }
  return results;
};

const validateAppointmentPayload = async ({ businessId, payload, existingId = null }) => {
  const startAt = normalizeDate(payload.startAt, "start time", true);
  const endAt = normalizeDate(payload.endAt, "end time", true);
  if (endAt <= startAt) throw new AppError("Appointment end time must be after start time", 400);
  if (payload.customerId) {
    const customer = await Customer.findOne({ _id: payload.customerId, businessId }).select("_id");
    if (!customer) throw new AppError("Customer not found", 404);
  }
  const assignedUsers = await validateUsers({ businessId, userIds: payload.assignedUsers || [] });
  if (assignedUsers.length) {
    const conflict = await Appointment.findOne({
      businessId,
      _id: existingId ? { $ne: existingId } : { $exists: true },
      status: { $in: ["SCHEDULED", "CONFIRMED"] },
      assignedUsers: { $in: assignedUsers },
      startAt: { $lt: endAt },
      endAt: { $gt: startAt },
    }).select("_id title startAt endAt");
    if (conflict) throw new AppError("Appointment conflicts with an existing booking for the assigned staff", 409);
  }
  return { startAt, endAt, assignedUsers };
};

const createAppointment = async ({ businessId, userId, payload, req }) => {
  const { startAt, endAt, assignedUsers } = await validateAppointmentPayload({ businessId, payload });
  const session = await mongoose.startSession();
  try {
    let appointment;
    await session.withTransaction(async () => {
      appointment = await Appointment.create([{
    businessId,
    customerId: payload.customerId || null,
    title: payload.title,
    description: payload.description || "",
    appointmentType: payload.appointmentType || "",
    assignedUsers,
    startAt,
    endAt,
    timezone: payload.timezone || process.env.BILLSTACK_DEFAULT_TIMEZONE || "Asia/Kolkata",
    locationType: String(payload.locationType || "OFFICE").toUpperCase(),
    physicalLocation: payload.physicalLocation || "",
    meetingLink: payload.meetingLink || "",
    notes: payload.notes || "",
    conflictOverride: payload.overrideConflict ? { allowed: true, reason: payload.overrideReason || "", by: userId } : undefined,
        createdBy: userId,
      }], { session }).then((rows) => rows[0]);
      if (appointment.customerId) {
        const customer = await Customer.findOne({ _id: appointment.customerId, businessId }).session(session);
        if (customer?.email) {
          const scheduledFor = new Date(appointment.startAt);
          scheduledFor.setDate(scheduledFor.getDate() - 1);
          if (scheduledFor > new Date()) {
            await scheduleWorkflowMessage({
              businessId,
              customerId: customer._id,
              channel: "EMAIL",
              scheduledFor,
              subject: "Appointment reminder",
              content: `Reminder: ${appointment.title} is scheduled for ${appointment.startAt.toLocaleString("en-IN")}.`,
              recipient: customer.email,
              sourceKey: `APPOINTMENT:${appointment._id}:EMAIL:${scheduledFor.toISOString()}`,
              metadata: { workflowType: "APPOINTMENT", appointmentId: appointment._id, scheduledFor },
              createdBy: userId,
              session,
            });
          }
        }
      }
    });
    await writeAuditLog({ req, businessId, action: "APPOINTMENT_CREATED", entityType: "Appointment", entityId: appointment._id });
    return appointment;
  } finally {
    session.endSession();
  }
};

const listAppointments = ({ businessId, query = {} }) => {
  const filter = { businessId };
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.customerId) filter.customerId = query.customerId;
  if (query.assignedUserId) filter.assignedUsers = query.assignedUserId;
  if (query.from || query.to) filter.startAt = {};
  if (query.from) filter.startAt.$gte = normalizeDate(query.from, "from date");
  if (query.to) filter.startAt.$lte = normalizeDate(query.to, "to date");
  return Appointment.find(filter).populate("customerId", "name email phone").populate("assignedUsers", "name email").sort("startAt");
};

const updateAppointment = async ({ businessId, userId, id, payload, req }) => {
  const appointment = await Appointment.findOne({ _id: id, businessId });
  if (!appointment) throw new AppError("Appointment not found", 404);
  if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(appointment.status)) throw new AppError("Finalized appointment cannot be edited", 400);
  const { startAt, endAt, assignedUsers } = await validateAppointmentPayload({ businessId, payload: { ...appointment.toObject(), ...payload }, existingId: appointment._id });
  Object.assign(appointment, {
    title: payload.title ?? appointment.title,
    description: payload.description ?? appointment.description,
    appointmentType: payload.appointmentType ?? appointment.appointmentType,
    assignedUsers,
    startAt,
    endAt,
    locationType: payload.locationType ? String(payload.locationType).toUpperCase() : appointment.locationType,
    physicalLocation: payload.physicalLocation ?? appointment.physicalLocation,
    meetingLink: payload.meetingLink ?? appointment.meetingLink,
    notes: payload.notes ?? appointment.notes,
    updatedBy: userId,
  });
  await appointment.save();
  await writeAuditLog({ req, businessId, action: "APPOINTMENT_RESCHEDULED", entityType: "Appointment", entityId: appointment._id });
  return appointment;
};

const setAppointmentStatus = async ({ businessId, userId, id, status, req }) => {
  const appointment = await Appointment.findOne({ _id: id, businessId });
  if (!appointment) throw new AppError("Appointment not found", 404);
  const next = String(status || "").toUpperCase();
  assertTransition(APPOINTMENT_TRANSITIONS, appointment.status, next, "appointment");
  appointment.status = next;
  appointment.updatedBy = userId;
  await appointment.save();
  await writeAuditLog({ req, businessId, action: `APPOINTMENT_${next}`, entityType: "Appointment", entityId: appointment._id });
  return appointment;
};

module.exports = {
  ORDER_TRANSITIONS,
  PROJECT_TRANSITIONS,
  TASK_TRANSITIONS,
  RECURRING_TRANSITIONS,
  APPOINTMENT_TRANSITIONS,
  addInterval,
  createAppointment,
  createOrder,
  createProject,
  createRecurringProfile,
  createTask,
  deleteRecurringProfile,
  convertOrderToInvoice,
  generateRecurringInvoice,
  getOrder,
  getProject,
  getRecurringProfile,
  listAppointments,
  listOrders,
  listProjects,
  listRecurringProfiles,
  listTasks,
  normalizeLineItems,
  occurrenceKey,
  processDueRecurringProfiles,
  setAppointmentStatus,
  setOrderStatus,
  setRecurringStatus,
  updateAppointment,
  updateOrder,
  updateOrderFulfilment,
  updateProject,
  updateTask,
};
