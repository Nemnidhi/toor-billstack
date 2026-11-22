const Supplier = require("../models/Supplier");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const {
  buildPaginatedResponse,
  buildPagination,
  buildSearchFilter,
  buildSort,
} = require("../utils/queryFeatures");

const supplierSortFields = ["supplierName", "email", "paymentStatus", "createdAt", "updatedAt"];

const listSuppliers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = buildPagination(req.query);
  const sort = buildSort(req.query.sortBy, req.query.sortOrder, supplierSortFields);
  const searchFilter = buildSearchFilter(req.query.search, [
    "supplierName",
    "email",
    "phone",
    "gstNumber",
  ]);

  const filters = {
    businessId: req.tenant.businessId,
    ...searchFilter,
  };

  if (req.query.paymentStatus) {
    filters.paymentStatus = req.query.paymentStatus;
  }

  const [items, total] = await Promise.all([
    Supplier.find(filters).populate("productsSupplied", "name sku").sort(sort).skip(skip).limit(limit),
    Supplier.countDocuments(filters),
  ]);

  res.status(200).json({
    message: "Suppliers fetched successfully",
    data: buildPaginatedResponse({ items, total, page, limit }),
  });
});

const getSupplierById = asyncHandler(async (req, res) => {
  const supplier = await Supplier.findOne({
    _id: req.params.supplierId,
    businessId: req.tenant.businessId,
  }).populate("productsSupplied", "name sku");

  if (!supplier) {
    throw new AppError("Supplier not found", 404);
  }

  res.status(200).json({
    message: "Supplier fetched successfully",
    data: supplier,
  });
});

const { normalizePan, normalizeTdsKind } = require("../utils/tax-ids");

// MSME (Udyam) details for the 45-day payment rule; fields not sent keep their value
const msmeFieldsOf = (body = {}, current = {}) => {
  const out = {};
  if (body.msmeType !== undefined) {
    const t = String(body.msmeType || "").toUpperCase();
    if (!["", "MICRO", "SMALL", "MEDIUM"].includes(t)) throw new AppError("MSME type must be micro, small or medium", 400);
    out.msmeType = t;
  }
  if (body.udyamNumber !== undefined) out.udyamNumber = String(body.udyamNumber || "").trim().toUpperCase();
  if (body.msmeTrader !== undefined) out.msmeTrader = body.msmeTrader === true || body.msmeTrader === "true";
  if (body.msmeCreditDays !== undefined) {
    const days = Number(body.msmeCreditDays || 0);
    if (!Number.isFinite(days) || days < 0 || days > 45) throw new AppError("Agreed credit days for an MSME supplier can be at most 45", 400);
    out.msmeCreditDays = Math.round(days);
  }
  return out;
};

const tdsRateOf = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new AppError("TDS rate must be between 0 and 100", 400);
  return rate;
};

const createSupplier = asyncHandler(async (req, res) => {
  const supplier = await Supplier.create({
    businessId: req.tenant.businessId,
    supplierName: req.body.supplierName.trim(),
    phone: req.body.phone?.trim() || "",
    email: req.body.email?.trim().toLowerCase() || "",
    address: req.body.address?.trim() || "",
    gstNumber: req.body.gstNumber?.trim().toUpperCase() || "",
    pan: normalizePan(req.body.pan),
    tdsKind: normalizeTdsKind(req.body.tdsKind),
    tdsRate: tdsRateOf(req.body.tdsRate),
    ...msmeFieldsOf(req.body),
    productsSupplied: Array.isArray(req.body.productsSupplied) ? req.body.productsSupplied : [],
    notes: req.body.notes?.trim() || "",
    paymentStatus: req.body.paymentStatus || "unpaid",
  });

  res.status(201).json({
    message: "Supplier created successfully",
    data: supplier,
  });
});

const updateSupplier = asyncHandler(async (req, res) => {
  const supplier = await Supplier.findOne({
    _id: req.params.supplierId,
    businessId: req.tenant.businessId,
  });

  if (!supplier) {
    throw new AppError("Supplier not found", 404);
  }

  supplier.supplierName = req.body.supplierName?.trim() || supplier.supplierName;
  supplier.phone = req.body.phone?.trim() || "";
  supplier.email = req.body.email?.trim().toLowerCase() || "";
  supplier.address = req.body.address?.trim() || "";
  supplier.gstNumber = req.body.gstNumber?.trim().toUpperCase() || "";
  if (req.body.pan !== undefined) supplier.pan = normalizePan(req.body.pan);
  if (req.body.tdsKind !== undefined) supplier.tdsKind = normalizeTdsKind(req.body.tdsKind);
  if (req.body.tdsRate !== undefined) supplier.tdsRate = tdsRateOf(req.body.tdsRate);
  Object.assign(supplier, msmeFieldsOf(req.body, supplier));
  supplier.productsSupplied = Array.isArray(req.body.productsSupplied) ? req.body.productsSupplied : [];
  supplier.notes = req.body.notes?.trim() || "";
  supplier.paymentStatus = req.body.paymentStatus || "unpaid";

  await supplier.save();

  res.status(200).json({
    message: "Supplier updated successfully",
    data: supplier,
  });
});

const deleteSupplier = asyncHandler(async (req, res) => {
  const supplier = await Supplier.findOneAndDelete({
    _id: req.params.supplierId,
    businessId: req.tenant.businessId,
  });

  if (!supplier) {
    throw new AppError("Supplier not found", 404);
  }

  res.status(200).json({
    message: "Supplier deleted successfully",
  });
});

module.exports = {
  createSupplier,
  deleteSupplier,
  getSupplierById,
  listSuppliers,
  updateSupplier,
};

