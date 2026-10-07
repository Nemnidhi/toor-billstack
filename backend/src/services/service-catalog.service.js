const Product = require("../models/Product");
const AppError = require("../utils/appError");

const escapeRegex = (str) => String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cleanText = (str) => String(str || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().replace(/\s+/g, " ");

/** Extract a clean canonical service name from raw item title or explicit name. */
function extractCanonicalServiceName(rawName, explicitServiceName) {
  if (explicitServiceName && typeof explicitServiceName === "string" && explicitServiceName.trim()) {
    return cleanText(explicitServiceName);
  }
  if (!rawName || typeof rawName !== "string") return "General Service";
  const text = cleanText(rawName);

  if (/^coworking\s+space\s+rental/i.test(text)) {
    return "Coworking Space Rental";
  }
  if (/^brokerage\s+services\s*-\s*commercial/i.test(text)) {
    return "Brokerage Services - Commercial";
  }
  if (/^brokerage\s+services\s*-\s*residential/i.test(text)) {
    return "Brokerage Services - Residential";
  }
  if (/^coworking\s+booking/i.test(text)) {
    return "Coworking Booking";
  }

  // Check if string contains detailed cabin or period suffix after hyphen delimiter
  const hyphenParts = text.split(/\s+-\s+/);
  if (hyphenParts.length > 1 && hyphenParts[0].length >= 3) {
    const prefix = hyphenParts[0].trim();
    if (/^(coworking|brokerage|office|desk|cabin|rent|service|consulting)/i.test(prefix)) {
      return prefix;
    }
  }
  return text;
}

/** Case-insensitive, whitespace-normalized lookup for an existing product/service. */
async function findMatchingCatalogService({ businessId, name, session }) {
  if (!businessId || !name) return null;
  const normalized = cleanText(name);
  if (!normalized) return null;

  const query = Product.findOne({
    businessId,
    name: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, "i") },
  });
  if (session) query.session(session);
  return query;
}

/** Deterministically resolve or persist a reusable service for invoice/quote creation. */
async function resolveOrCreateCatalogService({ businessId, item = {}, session = null }) {
  if (!businessId) throw new AppError("businessId is required to resolve catalog service", 400);
  const canonicalName = extractCanonicalServiceName(item.productName || item.name, item.serviceName || item.catalogName);

  // 1. Check if matching service/product already exists
  const existing = await findMatchingCatalogService({ businessId, name: canonicalName, session });
  if (existing) {
    return { product: existing, created: false };
  }

  // 2. If not found, persist once as an active service in catalog
  const productData = {
    businessId,
    name: canonicalName,
    description: cleanText(item.description || `Catalog service: ${canonicalName}`),
    itemType: "service",
    sellingPrice: Number(item.rate || 0),
    taxRate: Number(item.taxRate !== undefined ? item.taxRate : 18),
    hsnSac: cleanText(item.hsnSac || ""),
    gstClassification: String(item.gstClassification || "TAXABLE").toUpperCase(),
    unitType: "service",
    trackInventory: false,
    status: "active",
    currentStock: 0,
    openingStock: 0,
    minimumStockLevel: 0,
    isLowStock: false,
    isOutOfStock: false,
  };

  try {
    const created = session
      ? (await Product.create([productData], { session }))[0]
      : await Product.create(productData);
    return { product: created, created: true };
  } catch (error) {
    // If duplicate error occurs due to concurrent race, re-query existing item
    if (error.code === 11000) {
      const found = await findMatchingCatalogService({ businessId, name: canonicalName, session });
      if (found) return { product: found, created: false };
    }
    throw error;
  }
}

/** Search catalog services and products for Quotation and Invoice selector. */
async function listCatalogServices({ businessId, search = "", status = "active", session = null }) {
  const filter = { businessId };
  if (status) filter.status = status;
  if (search && cleanText(search)) {
    filter.name = { $regex: new RegExp(escapeRegex(cleanText(search)), "i") };
  }
  const query = Product.find(filter).sort("name").limit(100);
  if (session) query.session(session);
  return query;
}

module.exports = {
  cleanText,
  escapeRegex,
  extractCanonicalServiceName,
  findMatchingCatalogService,
  resolveOrCreateCatalogService,
  listCatalogServices,
};