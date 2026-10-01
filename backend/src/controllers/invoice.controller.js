const { buildTaxDocument } = require("../utils/tax-document");
const mongoose = require("mongoose");

const Business = require("../models/Business");
const Customer = require("../models/Customer");
const EInvoiceMetadata = require("../models/EInvoiceMetadata");
const Invoice = require("../models/Invoice");
const Product = require("../models/Product");
const StockMovement = require("../models/StockMovement");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const { sendInvoiceEmail } = require("../services/email.service");
const { dispatchInvoiceIssuedAutomation } = require("../services/communication.service");
const { buildInventoryFlags } = require("../services/inventory.service");
const { generateInvoicePdfBuffer } = require("../utils/pdfInvoice");
const { buildInvoiceNumber, buildInvoiceTotals } = require("../utils/invoice");
const { buildGstSnapshot, validateGstin, validateStateCode } = require("../utils/gst");
const { createCustomerLedgerEntryOnce } = require("../services/ledger.service");
const { log } = require("../utils/logger");
const paymentService = require("../services/payment.service");
  const { applyFinancialRead, applyFinancialReads, hasDocumentAllocations, hasMigratedFinancialState, documentUpdateDecision, legacyPaymentWriteDecision } = require("../services/financial-read.service");
const {
  buildPaginatedResponse,
  buildPagination,
  buildSearchFilter,
  buildSort,
} = require("../utils/queryFeatures");

const invoiceSortFields = ["invoiceDate", "dueDate", "grandTotal", "createdAt"];
const previewInvoiceTax = asyncHandler(async (req, res) => {
  const currentBusiness = await Business.findById(req.tenant.businessId);
  const allowedBusinessIds = [req.tenant.businessId];
  if (currentBusiness?.billingParentId) allowedBusinessIds.push(currentBusiness.billingParentId);
  const [business, customer] = await Promise.all([
    Promise.resolve(currentBusiness),
    Customer.findOne({ _id: req.body.customerId, businessId: { $in: allowedBusinessIds } })
  ]);
  if (!business || !customer) throw new AppError("Select a valid customer", 400);
  const products = await Product.find({ _id: { $in: invoiceProductIds(req.body.lineItems || []) }, businessId: req.tenant.businessId });
  const lineItems = buildInvoiceLineItems({ items: req.body.lineItems || [], products });
  res.json({ data: buildTaxDocument({ business, counterparty: customer, products, lineItems, placeOfSupplyCode: req.body.placeOfSupplyCode, shippingCharges: req.body.shippingCharges, roundOff: req.body.roundOff }) });
});

const attachEInvoiceMetadata = async ({ businessId, invoices }) => {
  const list = Array.isArray(invoices) ? invoices : [invoices];
  const metadataRows = await EInvoiceMetadata.find({
    businessId,
    invoiceId: { $in: list.map((invoice) => invoice._id) },
  }).select("invoiceId eInvoiceStatus irn acknowledgementNumber acknowledgementDate lastReadinessStatus lastReadinessErrors");
  const metadataMap = new Map(metadataRows.map((row) => [row.invoiceId.toString(), row]));
  const mapped = list.map((invoice) => {
    const plain = typeof invoice.toObject === "function" ? invoice.toObject() : invoice;
    const metadata = metadataMap.get(plain._id.toString());
    return {
      ...plain,
      eInvoice: metadata
        ? {
            status: metadata.eInvoiceStatus,
            irn: metadata.irn,
            acknowledgementNumber: metadata.acknowledgementNumber,
            acknowledgementDate: metadata.acknowledgementDate,
            readinessStatus: metadata.lastReadinessStatus,
            readinessErrors: metadata.lastReadinessErrors,
          }
        : { status: plain.gstSnapshot ? "READY" : "NOT_REQUIRED", irn: "", acknowledgementNumber: "", readinessStatus: "" },
    };
  });
  return Array.isArray(invoices) ? mapped : mapped[0];
};

const getInvoiceForSharing = async ({ invoiceId, businessId }) => {
  const [invoice, business] = await Promise.all([
    Invoice.findOne({
      _id: invoiceId,
      businessId,
    })
      .populate("customerId", "name email phone billingAddress shippingAddress gstNumber")
      .populate("createdBy", "name email"),
    Business.findById(businessId),
  ]);

  if (!invoice || !business) {
    throw new AppError("Invoice not found", 404);
  }

  const [derivedInvoice, paymentHistory] = await Promise.all([
    applyFinancialRead({ businessId, sourceType: "INVOICE", document: invoice }),
    paymentService.listAllocations({ businessId, sourceType: "INVOICE", sourceDocumentId: invoiceId }),
  ]);

  return {
    invoice: { ...derivedInvoice, paymentHistory },
    business,
  };
};

const syncCustomerInvoiceHistory = async ({ customer, businessId, session }) => {
  const invoices = await Invoice.find({
    businessId,
    customerId: customer._id,
    status: { $ne: "cancelled" },
  })
    .sort("-invoiceDate")
    .session(session);

  customer.invoiceHistory = invoices.map((invoice) => ({
    invoiceNumber: invoice.invoiceNumber,
    amount: invoice.grandTotal,
    status: invoice.paymentStatus,
    issuedAt: invoice.invoiceDate,
  }));

  await customer.save({ session });
};

const invoiceProductIds = (items = []) => [
  ...new Set(
    items
      .map((item) => item.productId)
      .filter((productId) => productId && mongoose.Types.ObjectId.isValid(productId))
      .map((productId) => productId.toString())
  ),
];

const applyInvoiceStockDelta = async ({
  business,
  businessId,
  invoiceId,
  previousItems,
  nextItems,
  createdBy,
  session,
}) => {
  const previousMap = new Map();
  const nextMap = new Map();

  previousItems.forEach((item) => {
    if (!item.productId) return;
    previousMap.set(item.productId.toString(), item);
  });

  nextItems.forEach((item) => {
    if (!item.productId) return;
    nextMap.set(item.productId.toString(), item);
  });

  const productIds = Array.from(new Set([...previousMap.keys(), ...nextMap.keys()]));
  const products = await Product.find({
    _id: { $in: productIds },
    businessId,
  }).session(session);

  const productMap = new Map(products.map((product) => [product._id.toString(), product]));

  for (const productId of productIds) {
    const previousQuantity = Number(previousMap.get(productId)?.quantity || 0);
    const nextQuantity = Number(nextMap.get(productId)?.quantity || 0);
    const delta = nextQuantity - previousQuantity;

    if (delta === 0) {
      continue;
    }

    const product = productMap.get(productId);

    if (!product) {
      throw new AppError("Invoice product not found", 400);
    }

    if (!product.trackInventory) {
      continue;
    }

    const previousStock = product.currentStock;
    const newStock = previousStock - delta;

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
          type: delta > 0 ? "OUT" : "RETURN",
          quantity: Math.abs(delta),
          previousStock,
          newStock,
          reason: `Invoice ${delta > 0 ? "issue" : "adjustment restore"} for ${invoiceId}`,
          referenceType: "INVOICE",
          referenceId: invoiceId.toString(),
          createdBy,
        },
      ],
      { session }
    );
  }
};

const buildInvoiceLineItems = ({ items, products }) => {
  const productMap = new Map(products.map((product) => [product._id.toString(), product]));

  return items.map((item) => {
    const productId = item.productId && mongoose.Types.ObjectId.isValid(item.productId)
      ? item.productId.toString()
      : "";
    const product = productId ? productMap.get(productId) : null;

    if (productId && !product) {
      throw new AppError("One or more invoice products are invalid", 400);
    }
    const manualName = item.productName || item.description || item.name;
    if (!product && (!manualName || String(manualName).trim().length < 2)) {
      throw new AppError("Product or item/service description is required", 400);
    }

    return {
      productId: product?._id || null,
      productName: product ? product.name : String(manualName).trim(),
      hsnSac: product?.hsnSac || item.hsnSac?.trim?.() || "",
      gstClassification: String(product?.gstClassification || item.gstClassification || "TAXABLE").toUpperCase(),
      isManual: !product,
      quantity: Number(item.quantity || 0),
      rate: Number(item.rate ?? product?.sellingPrice ?? 0),
      taxRate: Number(item.taxRate ?? item.tax ?? product?.taxRate ?? 0),
      discountType: item.discountType === "amount" ? "amount" : "percent",
      discountValue: Number(
        item.discountValue !== undefined ? item.discountValue : item.discount ?? product?.discount ?? 0
      ),
    };
  });
};

const listInvoices = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const sort = buildSort(req.query.sortBy, req.query.sortOrder, invoiceSortFields, "-invoiceDate");
  const searchFilter = buildSearchFilter(req.query.search, ["invoiceNumber", "paymentStatus", "status"]);
  const filters = {
    businessId: req.tenant.businessId,
    ...searchFilter,
  };

  if (req.query.customerId) {
    filters.customerId = req.query.customerId;
  }

  if (req.query.paymentStatus) {
    filters.paymentStatus = req.query.paymentStatus;
  }

  if (req.query.status) {
    filters.status = req.query.status;
  }

  const [items, total] = await Promise.all([
    Invoice.find(filters)
      .populate("customerId", "name email phone")
      .populate("createdBy", "name email")
      .sort(sort)
      .skip(skip)
      .limit(limit),
    Invoice.countDocuments(filters),
  ]);

  const financialItems = await applyFinancialReads({ businessId: req.tenant.businessId, sourceType: "INVOICE", documents: items });
  const enrichedItems = await attachEInvoiceMetadata({ businessId: req.tenant.businessId, invoices: financialItems });

  res.status(200).json({
    message: "Invoices fetched successfully",
    data: buildPaginatedResponse({ items: enrichedItems, total, page, limit }),
  });
});

const getInvoiceById = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({
    _id: req.params.invoiceId,
    businessId: req.tenant.businessId,
  })
    .populate("customerId", "name email phone billingAddress shippingAddress gstNumber")
    .populate("createdBy", "name email");

  if (!invoice) {
    throw new AppError("Invoice not found", 404);
  }

  const financialInvoice = await applyFinancialRead({ businessId: req.tenant.businessId, sourceType: "INVOICE", document: invoice });
  const enrichedInvoice = await attachEInvoiceMetadata({ businessId: req.tenant.businessId, invoices: financialInvoice });

  res.status(200).json({
    message: "Invoice fetched successfully",
    data: enrichedInvoice,
  });
});

const createInvoice = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();

  try {
    let createdInvoiceId;

    await session.withTransaction(async () => {
      const business = await Business.findById(req.tenant.businessId).session(session);
      if (!business) {
        throw new AppError("Business not found", 404);
      }

      const allowedBusinessIds = [req.tenant.businessId];
      if (business.billingParentId) allowedBusinessIds.push(business.billingParentId);

      const customer = await Customer.findOne({
        _id: req.body.customerId,
        businessId: { $in: allowedBusinessIds },
      }).session(session);

      if (!customer) {
        throw new AppError("Customer not found", 404);
      }

      let crmSourceRef = null;
      if (req.body.crmSourceRef && typeof req.body.crmSourceRef === "object") {
        const sr = req.body.crmSourceRef;
        if (sr.source && sr.sourceType && sr.sourceId && sr.billingPurpose) {
          crmSourceRef = {
            source: String(sr.source).trim(),
            sourceType: String(sr.sourceType).trim(),
            sourceId: String(sr.sourceId).trim(),
            billingPurpose: String(sr.billingPurpose).trim(),
            billingPeriod: String(sr.billingPeriod || "").trim(),
          };

          const existingInvoice = await Invoice.findOne({
            "crmSourceRef.source": crmSourceRef.source,
            "crmSourceRef.sourceType": crmSourceRef.sourceType,
            "crmSourceRef.sourceId": crmSourceRef.sourceId,
            "crmSourceRef.billingPurpose": crmSourceRef.billingPurpose,
            "crmSourceRef.billingPeriod": crmSourceRef.billingPeriod,
          }).session(session);

          if (existingInvoice) {
            throw new AppError(`An invoice (${existingInvoice.invoiceNumber}) already exists for this CRM billable source`, 409);
          }
        }
      }

      const rawItems = Array.isArray(req.body.lineItems) ? req.body.lineItems : [];

      if (!rawItems.length) {
        throw new AppError("At least one invoice line item is required", 400);
      }

      const products = await Product.find({
        _id: { $in: invoiceProductIds(rawItems) },
        businessId: req.tenant.businessId,
      }).session(session);

      const normalizedItems = buildInvoiceLineItems({ items: rawItems, products });
      const { totals, gstSnapshot } = buildTaxDocument({ business, counterparty: customer, products, placeOfSupplyCode: req.body.placeOfSupplyCode,
        lineItems: normalizedItems,
        shippingCharges: req.body.shippingCharges,
        roundOff: req.body.roundOff,
        amountPaid: req.body.amountPaid,
      });

      const sequence = business.invoiceNumbering?.nextSequence || 1;
      const invoiceDate = req.body.invoiceDate ? new Date(req.body.invoiceDate) : new Date();
      const invoiceNumber = buildInvoiceNumber({
        prefix: business.invoiceNumbering?.prefix,
        format: business.invoiceNumbering?.format,
        sequence,
        date: invoiceDate,
      });

      const created = await Invoice.create(
        [
          {
            businessId: req.tenant.businessId,
            customerId: customer._id,
            invoiceNumber,
            invoiceDate,
            dueDate: req.body.dueDate ? new Date(req.body.dueDate) : invoiceDate,
            customerDetails: {
              name: customer.name,
              email: customer.email,
              phone: customer.phone,
              address: customer.billingAddress,
              gstNumber: customer.gstNumber,
            },
            businessDetails: {
              name: business.name,
              email: business.email || business.billingEmail,
              phone: business.phone,
              address: business.address,
              gstNumber: business.gstTaxId,
            },
            crmSourceRef,
            lineItems: totals.lineItems,
            subtotal: totals.subtotal,
            totalTax: totals.totalTax,
            totalDiscount: totals.totalDiscount,
            shippingCharges: totals.shippingCharges,
            roundOff: totals.roundOff,
            grandTotal: totals.grandTotal,
            amountPaid: totals.amountPaid,
            balanceDue: totals.balanceDue,
            paymentStatus: totals.paymentStatus,
            notes: req.body.notes?.trim() || "",
            termsAndConditions: req.body.termsAndConditions?.trim() || "",
            gstSnapshot,
            gstBreakup: gstSnapshot ? { cgst: gstSnapshot.cgst, sgst: gstSnapshot.sgst, utgst: gstSnapshot.utgst, igst: gstSnapshot.igst, taxableValue: gstSnapshot.taxableValue, hsnSacSummary: gstSnapshot.hsnSacSummary } : undefined,
            status: "issued",
            createdBy: req.user._id,
          },
        ],
        { session }
      );

      const invoice = created[0];
      createdInvoiceId = invoice._id;
      await createCustomerLedgerEntryOnce({ businessId: req.tenant.businessId, customerId: customer._id, eventType: "INVOICE", amount: invoice.grandTotal, direction: "DEBIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:DEBIT`, createdBy: req.user._id }, { session });
      business.invoiceNumbering.nextSequence = sequence + 1;
      await business.save({ session });

      await applyInvoiceStockDelta({
        business,
        businessId: req.tenant.businessId,
        invoiceId: invoice._id,
        previousItems: [],
        nextItems: totals.lineItems,
        createdBy: req.user._id,
        session,
      });

      await syncCustomerInvoiceHistory({
        customer,
        businessId: req.tenant.businessId,
        session,
      });
    });

    const invoice = await Invoice.findById(createdInvoiceId)
      .populate("customerId", "name email phone")
      .populate("createdBy", "name email");

    await dispatchInvoiceIssuedAutomation({
      businessId: req.tenant.businessId,
      invoiceId: createdInvoiceId,
      createdBy: req.user._id,
    }).catch((error) => log("warn", "Invoice issued automation failed", { invoiceId: createdInvoiceId.toString(), error: error.message }));

    res.status(201).json({
      message: "Invoice created successfully",
      data: invoice,
    });
  } catch (error) {
    if (error?.code === 11000 && (error.message?.includes("crmSourceRef") || error.keyPattern?.["crmSourceRef.source"])) {
      throw new AppError("An invoice has already been issued for this CRM billable source", 409);
    }
    throw error;
  } finally {
    session.endSession();
  }
});

const updateInvoice = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const invoice = await Invoice.findOne({
        _id: req.params.invoiceId,
        businessId: req.tenant.businessId,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }

      if (invoice.status === "cancelled") {
        throw new AppError("Cancelled invoices cannot be edited", 400);
      }

      const allocationsExist = await hasDocumentAllocations({
        businessId: req.tenant.businessId,
        sourceType: "INVOICE",
        sourceDocumentId: invoice._id,
        session,
      });
      const migrated = await hasMigratedFinancialState({ businessId: req.tenant.businessId, sourceType: "INVOICE", sourceDocumentId: invoice._id, session });
      const paymentWrite = legacyPaymentWriteDecision({ sourceType: "INVOICE", migrated, allocationsExist, body: req.body });
      if (!paymentWrite.allowed) throw new AppError("Payment changes for this invoice must use the Payment and Allocation workflow.", 400);
      const updateDecision = documentUpdateDecision({ sourceType: "INVOICE", allocationsExist, body: req.body });
      if (!updateDecision.allowed) {
        throw new AppError("Invoices with payment allocations cannot have financial values changed.", 400);
      }
      if (allocationsExist) {
        if (req.body.notes !== undefined) invoice.notes = req.body.notes?.trim() || "";
        if (req.body.termsAndConditions !== undefined) invoice.termsAndConditions = req.body.termsAndConditions?.trim() || "";
        await invoice.save({ session });
        return;
      }

      const previousCustomerId = invoice.customerId.toString();
      const business = await Business.findById(req.tenant.businessId).session(session);
      const customer = await Customer.findOne({
        _id: req.body.customerId || invoice.customerId,
        businessId: req.tenant.businessId,
      }).session(session);

      if (!business || !customer) {
        throw new AppError("Business or customer not found", 404);
      }

      const rawItems = Array.isArray(req.body.lineItems) ? req.body.lineItems : [];

      if (!rawItems.length) {
        throw new AppError("At least one invoice line item is required", 400);
      }

      const products = await Product.find({
        _id: { $in: invoiceProductIds(rawItems) },
        businessId: req.tenant.businessId,
      }).session(session);

      const normalizedItems = buildInvoiceLineItems({ items: rawItems, products });
      const { totals, gstSnapshot } = buildTaxDocument({ business, counterparty: customer, products, placeOfSupplyCode: req.body.placeOfSupplyCode,
        lineItems: normalizedItems,
        shippingCharges: req.body.shippingCharges,
        roundOff: req.body.roundOff,
        amountPaid: req.body.amountPaid !== undefined ? req.body.amountPaid : invoice.amountPaid,
      });

      const previousItems = invoice.lineItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
      }));

      invoice.customerId = customer._id;
      invoice.invoiceDate = req.body.invoiceDate ? new Date(req.body.invoiceDate) : invoice.invoiceDate;
      invoice.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : invoice.dueDate;
      invoice.customerDetails = {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        address: customer.billingAddress,
        gstNumber: customer.gstNumber,
      };
      invoice.businessDetails = {
        name: business.name,
        email: business.email || business.billingEmail,
        phone: business.phone,
        address: business.address,
        gstNumber: business.gstTaxId,
      };
      invoice.lineItems = totals.lineItems;
      invoice.subtotal = totals.subtotal;
      invoice.totalTax = totals.totalTax;
      invoice.totalDiscount = totals.totalDiscount;
      invoice.shippingCharges = totals.shippingCharges;
      invoice.roundOff = totals.roundOff;
      invoice.grandTotal = totals.grandTotal;
      invoice.amountPaid = totals.amountPaid;
      invoice.balanceDue = totals.balanceDue;
      invoice.paymentStatus = totals.paymentStatus;
      invoice.gstSnapshot = gstSnapshot;
      invoice.gstBreakup = gstSnapshot ? { cgst: gstSnapshot.cgst, sgst: gstSnapshot.sgst, utgst: gstSnapshot.utgst, igst: gstSnapshot.igst, taxableValue: gstSnapshot.taxableValue, hsnSacSummary: gstSnapshot.hsnSacSummary } : undefined;
      invoice.notes = req.body.notes?.trim() || "";
      invoice.termsAndConditions = req.body.termsAndConditions?.trim() || "";

      await applyInvoiceStockDelta({
        business,
        businessId: req.tenant.businessId,
        invoiceId: invoice._id,
        previousItems,
        nextItems: totals.lineItems,
        createdBy: req.user._id,
        session,
      });

      await invoice.save({ session });
      await syncCustomerInvoiceHistory({
        customer,
        businessId: req.tenant.businessId,
        session,
      });

      if (previousCustomerId !== customer._id.toString()) {
        const previousCustomer = await Customer.findOne({
          _id: previousCustomerId,
          businessId: req.tenant.businessId,
        }).session(session);

        if (previousCustomer) {
          await syncCustomerInvoiceHistory({
            customer: previousCustomer,
            businessId: req.tenant.businessId,
            session,
          });
        }
      }
    });

    const invoice = await Invoice.findById(req.params.invoiceId)
      .populate("customerId", "name email phone")
      .populate("createdBy", "name email");

    res.status(200).json({
      message: "Invoice updated successfully",
      data: invoice,
    });
  } finally {
    session.endSession();
  }
});

const cancelInvoice = asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const invoice = await Invoice.findOne({
        _id: req.params.invoiceId,
        businessId: req.tenant.businessId,
      }).session(session);

      if (!invoice) {
        throw new AppError("Invoice not found", 404);
      }

      if (invoice.status === "cancelled") {
        throw new AppError("Invoice is already cancelled", 400);
      }

      const business = await Business.findById(req.tenant.businessId).session(session);
      const customer = await Customer.findOne({
        _id: invoice.customerId,
        businessId: req.tenant.businessId,
      }).session(session);

      await applyInvoiceStockDelta({
        business,
        businessId: req.tenant.businessId,
        invoiceId: invoice._id,
        previousItems: invoice.lineItems.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
        nextItems: [],
        createdBy: req.user._id,
        session,
      });

      invoice.status = "cancelled";
      invoice.paymentStatus = "cancelled";
        invoice.balanceDue = 0;
        await invoice.save({ session });
        await createCustomerLedgerEntryOnce({ businessId: req.tenant.businessId, customerId: invoice.customerId, eventType: "REVERSAL", amount: invoice.grandTotal, direction: "CREDIT", invoiceId: invoice._id, sourceKey: `INVOICE:${invoice._id}:CANCEL`, createdBy: req.user._id, notes: "Invoice cancellation" }, { session });

      if (customer) {
        await syncCustomerInvoiceHistory({
          customer,
          businessId: req.tenant.businessId,
          session,
        });
      }
    });

    res.status(200).json({
      message: "Invoice cancelled successfully",
    });
  } finally {
    session.endSession();
  }
});

const downloadInvoicePdf = asyncHandler(async (req, res) => {
  const { invoice, business } = await getInvoiceForSharing({
    invoiceId: req.params.invoiceId,
    businessId: req.tenant.businessId,
  });

  const pdfBuffer = await generateInvoicePdfBuffer({ invoice, business });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${req.query.download === "true" ? "attachment" : "inline"}; filename="${invoice.invoiceNumber}.pdf"`
  );
  res.send(pdfBuffer);
});

const emailInvoicePdf = asyncHandler(async (req, res) => {
  const { invoice, business } = await getInvoiceForSharing({
    invoiceId: req.params.invoiceId,
    businessId: req.tenant.businessId,
  });

  const toEmail = req.body.toEmail || invoice.customerDetails.email;

  if (!toEmail) {
    throw new AppError("Recipient email is required", 400);
  }

  const pdfBuffer = await generateInvoicePdfBuffer({ invoice, business });

  await sendInvoiceEmail({
    to: toEmail,
    subject: `Invoice ${invoice.invoiceNumber} from ${business.name}`,
    html: `
      <p>Hello,</p>
      <p>Please find attached invoice <strong>${invoice.invoiceNumber}</strong>.</p>
      <p>Invoice total: ${invoice.grandTotal.toFixed(2)}</p>
      <p>Amount received: ${Number(invoice.amountPaid || 0).toFixed(2)}</p>
      <p>Balance due: ${Number(invoice.balanceDue || 0).toFixed(2)}</p>
      <p>Payment status: ${invoice.paymentStatus}</p>
      <p>Regards,<br/>${business.name}</p>
    `,
    pdfBuffer,
    filename: `${invoice.invoiceNumber}.pdf`,
  });

  res.status(200).json({
    message: "Invoice emailed successfully",
  });
});

module.exports = {
  previewInvoiceTax,
  cancelInvoice,
  createInvoice,
  downloadInvoicePdf,
  emailInvoicePdf,
  getInvoiceById,
  listInvoices,
  updateInvoice,
};
