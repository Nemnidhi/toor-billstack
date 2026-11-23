const Business = require("../models/Business");
const Supplier = require("../models/Supplier");
const AppError = require("../utils/appError");
const { log } = require("../utils/logger");
const { EXPENSE_CATEGORIES } = require("../constants/expenses");
const { validateGstin } = require("../utils/gst");
const claude = require("../utils/claude-client");

// Bill photo -> expense (client request, 23 Nov 2026). A photo or PDF of a supplier's bill is read
// by Claude (vision) and comes back as the fields of the expense form; nothing is saved here - the
// person checks the form and saves it as usual. Needs ANTHROPIC_API_KEY on the server (the owner
// sets it; it is never stored in the database or sent to the browser).

const MAX_BYTES = 5 * 1024 * 1024; // the API takes images up to 5 MB
const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40];

const TYPES = {
  ".jpg": { mime: "image/jpeg", ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".jpeg": { mime: "image/jpeg", ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  ".png": { mime: "image/png", ok: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  ".webp": { mime: "image/webp", ok: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
  ".pdf": { mime: "application/pdf", ok: (b) => b.subarray(0, 5).toString("ascii") === "%PDF-" },
};

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const BILL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isBill", "vendorName", "supplierGstin", "billNumber", "billDate", "currency", "amountBeforeTax", "cgst", "sgst", "igst", "cess", "totalAmount", "gstRate", "reverseCharge", "category", "description", "paidBy", "lineItems", "unclear"],
  properties: {
    isBill: { type: "boolean", description: "true if this is a bill, invoice, receipt or cash memo" },
    vendorName: { type: "string", description: "the seller / supplier as printed; empty if not shown" },
    supplierGstin: nullable({ type: "string", description: "the SELLER's 15-character GSTIN, not the buyer's" }),
    billNumber: nullable({ type: "string" }),
    billDate: nullable({ type: "string", format: "date", description: "YYYY-MM-DD; Indian bills write day first" }),
    currency: { type: "string", description: "ISO code, INR unless the bill says otherwise" },
    amountBeforeTax: nullable({ type: "number", description: "taxable value before GST, after any discount" }),
    cgst: nullable({ type: "number" }),
    sgst: nullable({ type: "number", description: "SGST or UTGST" }),
    igst: nullable({ type: "number" }),
    cess: nullable({ type: "number" }),
    totalAmount: nullable({ type: "number", description: "the grand total payable, including tax and round-off" }),
    gstRate: nullable({ type: "number", description: "the GST rate in percent (CGST + SGST together, or IGST); the main rate if several" }),
    reverseCharge: { type: "boolean", description: "true only if the bill says tax is payable on reverse charge" },
    category: { type: "string", enum: EXPENSE_CATEGORIES },
    description: { type: "string", description: "what was bought, in a few words" },
    paidBy: { type: "string", enum: ["", "CASH", "UPI", "CARD", "CREDIT_CARD", "BANK_TRANSFER", "CHEQUE"], description: "only if the bill shows how it was paid; else empty" },
    lineItems: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["description", "amount"], properties: { description: { type: "string" }, amount: nullable({ type: "number" }) } },
    },
    unclear: { type: "string", description: "anything you could not read or are unsure of; empty if all clear" },
  },
};

const PROMPT = `Read this bill (usually an Indian GST invoice, receipt or cash memo) for the buyer's expense records.
- Copy amounts exactly as printed, in rupees, as plain numbers. Do not work out a figure that is not printed; use null.
- supplierGstin is the seller's GSTIN, never the buyer's (the buyer's appears under "Bill to" / "Buyer" / "Recipient").
- Dates on Indian bills are day first (05/11/2026 is 5 November 2026).
- Pick the closest category from the list. Hotel stays, cabs, flights and fuel are Travel; restaurant food is Miscellaneous unless it is plainly travel.
- If the image is not a bill or receipt, set isBill to false and leave the rest empty or null.
- Say in "unclear" what is cut off, blurred or handwritten.`;

const { isConfigured, setClientFactoryForTests } = claude;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : round2(Number(value)));
const nearestRate = (rate) => GST_RATES.reduce((best, r) => (Math.abs(r - rate) < Math.abs(best - rate) ? r : best), GST_RATES[0]);

const fileOf = ({ fileBase64, fileName }) => {
  const ext = String(fileName || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
  const type = TYPES[ext];
  if (!type) throw new AppError("Upload a photo (JPG, PNG, WEBP) or a PDF of the bill", 400);
  const buffer = Buffer.from(String(fileBase64 || ""), "base64");
  if (!buffer.length) throw new AppError("The file is empty", 400);
  if (buffer.length > MAX_BYTES) throw new AppError("The file is larger than 5 MB. Take the photo again at a lower size.", 413);
  if (!type.ok(buffer)) throw new AppError("The file's content does not match its type", 400);
  return { mime: type.mime, data: buffer.toString("base64") };
};

const ask = async ({ mime, data }) => {
  const source = { type: "base64", media_type: mime, data };
  const fileBlock = mime === "application/pdf" ? { type: "document", source } : { type: "image", source };
  const request = { ...claude.baseRequest({ schema: BILL_SCHEMA, maxTokens: 4000 }), messages: [{ role: "user", content: [fileBlock, { type: "text", text: PROMPT }] }] };
  let response;
  try {
    response = await claude.getClient().beta.messages.create(request);
  } catch (error) {
    throw claude.friendlyError(error);
  }
  return { bill: claude.jsonAnswer(response, "bill"), model: response.model, usage: response.usage };
};

/**
 * The expense form's fields from what was read, with warnings for anything to check.
 * Pure: exported for tests.
 */
const toExpenseFields = (bill, { businessStateCode = "", today = new Date() } = {}) => {
  const warnings = [];
  const gstin = String(bill.supplierGstin || "").replace(/\s+/g, "").toUpperCase();
  const gstinOk = gstin && validateGstin(gstin);
  if (gstin && !gstinOk) warnings.push(`The GSTIN read from the bill (${gstin}) is not a valid GSTIN; check it.`);

  const [cgst, sgst, igst, cess] = [bill.cgst, bill.sgst, bill.igst, bill.cess].map((v) => num(v) || 0);
  const gstTotal = round2(cgst + sgst + igst);
  let base = num(bill.amountBeforeTax);
  const total = num(bill.totalAmount);
  if (base === null && total !== null) {
    base = round2(total - gstTotal - cess);
    warnings.push("The amount before GST was not printed; it was worked out from the total.");
  }

  let rate = num(bill.gstRate);
  if ((rate === null || rate === 0) && gstTotal > 0 && base > 0) rate = nearestRate((gstTotal / base) * 100);
  if (rate !== null && !GST_RATES.includes(rate)) {
    warnings.push(`The GST rate read (${rate}%) is not a standard rate; check it.`);
  }
  if (gstTotal > 0 && base > 0 && rate) {
    const expected = round2((base * rate) / 100);
    if (Math.abs(expected - gstTotal) > Math.max(1, gstTotal * 0.02)) warnings.push(`GST on the bill (₹${gstTotal}) is not ${rate}% of ₹${base}; the bill may have items at more than one rate. Check the rate.`);
  }
  if (total !== null && base !== null && Math.abs(round2(base + gstTotal + cess) - total) > 1) {
    warnings.push(`Amount before GST + GST (₹${round2(base + gstTotal + cess)}) does not match the bill's total (₹${total}); there may be a discount, round-off or charge not read.`);
  }
  if (cess > 0) warnings.push(`The bill has cess of ₹${cess}; add it to the notes or the amount as your accountant prefers.`);
  if (bill.currency && String(bill.currency).toUpperCase() !== "INR") warnings.push(`The bill is in ${bill.currency}; convert it to rupees before saving.`);

  const gstType = bill.reverseCharge ? "REVERSE_CHARGE" : gstTotal > 0 ? "GST_RECORDED" : "NONE";
  // IGST on the bill means the supplier is in another state: record the place of supply as theirs.
  const supplierState = gstinOk ? gstin.slice(0, 2) : "";
  const placeOfSupplyCode = igst > 0 && supplierState && supplierState !== businessStateCode ? supplierState : "";
  if (igst > 0 && !placeOfSupplyCode) warnings.push("The bill charges IGST but the supplier's state could not be told apart from yours; check the GST split after saving.");
  if ((cgst > 0 || sgst > 0) && supplierState && businessStateCode && supplierState !== businessStateCode) warnings.push("The bill charges CGST + SGST but the supplier is in another state; check it with your accountant.");

  let billDate = /^\d{4}-\d{2}-\d{2}$/.test(String(bill.billDate || "")) ? bill.billDate : "";
  if (billDate) {
    const days = (today - new Date(`${billDate}T00:00:00+05:30`)) / 86_400_000;
    if (days < -1) {
      warnings.push(`The bill date read (${billDate}) is in the future; check it.`);
    } else if (days > 400) warnings.push(`The bill date read (${billDate}) is more than a year old; check it.`);
  } else {
    warnings.push("No bill date could be read; today's date is used.");
  }
  if (bill.unclear) warnings.push(`Not clear on the bill: ${String(bill.unclear).slice(0, 300)}`);

  const items = (bill.lineItems || []).filter((item) => item?.description).slice(0, 8);
  const description = String(bill.description || items.map((i) => i.description).join(", ")).slice(0, 200);
  const fields = {
    expenseDate: billDate || today.toISOString().slice(0, 10),
    category: EXPENSE_CATEGORIES.includes(bill.category) ? bill.category : "Miscellaneous",
    vendorName: String(bill.vendorName || "").slice(0, 120),
    description,
    amountBeforeTax: base ?? "",
    gstEnabled: gstType === "GST_RECORDED",
    gstType,
    gstRate: gstType === "NONE" ? "" : rate ?? "",
    supplierInvoiceNumber: String(bill.billNumber || "").slice(0, 40),
    supplierInvoiceDate: billDate,
    supplierGstin: gstinOk ? gstin : "",
    placeOfSupplyCode,
    paymentMethod: bill.paidBy || "",
    notes: items.length > 1 ? items.map((i) => `${i.description}${i.amount !== null && i.amount !== undefined ? `: ₹${i.amount}` : ""}`).join("; ").slice(0, 500) : "",
  };
  return { fields, warnings, read: { cgst, sgst, igst, cess, totalAmount: total } };
};

// Each read is paid for: a business can read at most BILL_READER_DAILY_LIMIT bills a day (200).
const reads = new Map();
const countRead = (businessId) => {
  const day = new Date().toISOString().slice(0, 10);
  const key = String(businessId);
  const entry = reads.get(key)?.day === day ? reads.get(key) : { day, count: 0 };
  if (entry.count >= Number(process.env.BILL_READER_DAILY_LIMIT || 200)) throw new AppError("The day's limit for reading bills is used up. Type the bill in, or try tomorrow.", 429);
  entry.count += 1;
  reads.set(key, entry);
};

const readBill = async ({ businessId, userId, fileBase64, fileName }) => {
  if (!isConfigured()) {
    throw new AppError("Reading bills from a photo is not switched on. The owner adds an Anthropic API key on the server (ANTHROPIC_API_KEY) to turn it on.", 503);
  }
  const file = fileOf({ fileBase64, fileName });
  countRead(businessId);
  const startedAt = Date.now();
  const { bill, model, usage } = await ask(file);
  if (!bill.isBill) throw new AppError("This does not look like a bill or receipt. Upload a photo of the bill itself.", 422);

  const business = await Business.findById(businessId).select("gstConfiguration").lean();
  const result = toExpenseFields(bill, { businessStateCode: business?.gstConfiguration?.stateCode || "" });
  if (result.fields.supplierGstin) {
    const supplier = await Supplier.findOne({ businessId, gstNumber: result.fields.supplierGstin }).select("_id supplierName").lean();
    if (supplier) {
      result.fields.supplierId = String(supplier._id);
      result.supplierName = supplier.supplierName;
    }
  }
  log("info", "bill read", { businessId: String(businessId), userId: String(userId), model, ms: Date.now() - startedAt, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens });
  return { ...result, model };
};

module.exports = { readBill, toExpenseFields, isConfigured, setClientFactoryForTests, BILL_SCHEMA };
