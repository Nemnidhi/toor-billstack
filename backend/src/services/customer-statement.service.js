const pdfMake = require("pdfmake/build/pdfmake");
const pdfFonts = require("pdfmake/build/vfs_fonts");
const Business = require("../models/Business");
const Customer = require("../models/Customer");
const CustomerLedger = require("../models/CustomerLedger");
const AppError = require("../utils/appError");

pdfMake.vfs = pdfFonts;

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const formatDate = (value) => new Date(value).toLocaleDateString("en-IN");
const csvEscape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

const getEntryDate = (entry) => entry.createdAt || entry.updatedAt || new Date();

const mapLedgerType = (entry) => {
  if (entry.eventType === "INVOICE") return "INVOICE";
  if (entry.eventType === "PAYMENT") return "PAYMENT";
  if (entry.eventType === "CREDIT") return "CREDIT_NOTE";
  if (entry.eventType === "REVERSAL" && entry.reversalId) return "PAYMENT_REVERSAL";
  if (entry.eventType === "REVERSAL" && entry.invoiceId) return "INVOICE_CANCELLATION";
  return "OTHER_LEDGER_EVENT";
};

const ledgerEventTypeForStatementType = (type) => {
  const normalized = String(type || "").toUpperCase();
  if (!normalized) return "";
  if (normalized === "CREDIT_NOTE") return "CREDIT";
  if (normalized === "PAYMENT_REVERSAL" || normalized === "INVOICE_CANCELLATION") return "REVERSAL";
  if (normalized === "OTHER_LEDGER_EVENT") return "";
  return normalized;
};

const getReference = (entry) =>
  entry.referenceNumber || entry.invoiceId?.invoiceNumber || entry.paymentId?.referenceNumber || entry.sourceKey || "";

const getSourceType = (entry) => {
  if (entry.invoiceId) return "INVOICE";
  if (entry.paymentId) return "PAYMENT";
  if (entry.reversalId) return "PAYMENT_ALLOCATION_REVERSAL";
  return "CUSTOMER_LEDGER";
};

const buildCustomerStatement = async ({ businessId, customerId, query = {} }) => {
  const Business = require("../models/Business");
  const bus = await Business.findById(businessId);
  const allowedBusinessIds = [businessId];
  if (bus?.billingParentId) allowedBusinessIds.push(bus.billingParentId);
  const childBusinesses = await Business.find({ billingParentId: businessId }).select("_id");
  childBusinesses.forEach((cb) => allowedBusinessIds.push(cb._id));

  const [customer, business] = await Promise.all([
    Customer.findOne({ _id: customerId, businessId: { $in: allowedBusinessIds } }),
    Business.findById(businessId),
  ]);

  if (!customer) throw new AppError("Customer not found", 404);
  if (!business) throw new AppError("Business not found", 404);

  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  if (from && Number.isNaN(from.getTime())) throw new AppError("Invalid statement from date", 400);
  if (to && Number.isNaN(to.getTime())) throw new AppError("Invalid statement to date", 400);
  if (to) to.setHours(23, 59, 59, 999);

  const typeFilter = query.type ? String(query.type).toUpperCase() : "";
  const sortDirection = String(query.sort || "asc").toLowerCase() === "desc" ? -1 : 1;
  const limit = Math.min(Math.max(Number(query.limit || 100), 1), 500);
  const page = Math.max(Number(query.page || 1), 1);

  const baseFilter = { businessId, customerId };
  const periodFilter = { ...baseFilter };
  if (from || to) {
    periodFilter.createdAt = {};
    if (from) periodFilter.createdAt.$gte = from;
    if (to) periodFilter.createdAt.$lte = to;
  }
  if (typeFilter) {
    const eventType = ledgerEventTypeForStatementType(typeFilter);
    if (eventType) periodFilter.eventType = eventType;
  }

  const openingEntries = from
    ? await CustomerLedger.find({ ...baseFilter, createdAt: { $lt: from } })
    : [];
  const openingBalance = roundMoney(openingEntries.reduce((sum, entry) => sum + (entry.direction === "DEBIT" ? Number(entry.amount || 0) : -Number(entry.amount || 0)), 0));

  const allPeriodEntries = await CustomerLedger.find(periodFilter)
    .populate("invoiceId", "invoiceNumber status")
    .populate("paymentId", "referenceNumber status")
    .sort({ createdAt: sortDirection, _id: sortDirection });

  let runningBalance = openingBalance;
  const transactions = allPeriodEntries.map((entry) => {
    const amount = roundMoney(entry.amount);
    const debit = entry.direction === "DEBIT" ? amount : 0;
    const credit = entry.direction === "CREDIT" ? amount : 0;
    runningBalance = roundMoney(runningBalance + debit - credit);
    return {
      id: entry._id,
      date: getEntryDate(entry),
      type: mapLedgerType(entry),
      reference: getReference(entry),
      description: entry.notes || entry.eventType,
      debit,
      credit,
      runningBalance,
      sourceId: entry.invoiceId?._id || entry.paymentId?._id || entry.reversalId || entry._id,
      sourceType: getSourceType(entry),
      status: entry.invoiceId?.status || entry.paymentId?.status || "",
    };
  });

  const totalDebit = roundMoney(transactions.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = roundMoney(transactions.reduce((sum, row) => sum + row.credit, 0));
  const closingBalance = roundMoney(openingBalance + totalDebit - totalCredit);
  const total = transactions.length;
  const pageItems = transactions.slice((page - 1) * limit, page * limit);

  return {
    customer: {
      id: customer._id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      gstNumber: customer.gstNumber,
      billingAddress: customer.billingAddress,
    },
    business: {
      id: business._id,
      name: business.name,
      email: business.email || business.billingEmail,
      phone: business.phone,
      address: business.address,
      gstin: business.gstConfiguration?.gstin || business.gstTaxId,
    },
    period: { from, to },
    openingBalance,
    totalDebit,
    totalCredit,
    closingBalance,
    transactions: pageItems,
    pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  };
};

const buildStatementCsv = (statement) => {
  const rows = [["Date", "Type", "Reference", "Description", "Debit", "Credit", "Balance"]];
  statement.transactions.forEach((row) => rows.push([
    formatDate(row.date),
    row.type,
    row.reference,
    row.description,
    row.debit.toFixed(2),
    row.credit.toFixed(2),
    row.runningBalance.toFixed(2),
  ]));
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
};

const buildStatementPdfBuffer = (statement) =>
  new Promise((resolve) => {
    const body = [
      ["Date", "Particulars", "Reference", "Debit", "Credit", "Balance"],
      ...statement.transactions.map((row) => [
        formatDate(row.date),
        row.description || row.type,
        row.reference || "-",
        row.debit ? row.debit.toFixed(2) : "-",
        row.credit ? row.credit.toFixed(2) : "-",
        row.runningBalance.toFixed(2),
      ]),
    ];
    const definition = {
      pageSize: "A4",
      pageMargins: [36, 42, 36, 52],
      footer: (currentPage, pageCount) => ({
        columns: [
          { text: "Computer-generated customer account statement.", fontSize: 8, color: "#64748b" },
          { text: `Page ${currentPage} of ${pageCount}`, alignment: "right", fontSize: 8, color: "#64748b" },
        ],
        margin: [36, 14],
      }),
      content: [
        { text: "Customer Statement", style: "title" },
        { text: statement.business.name, style: "business" },
        { text: [statement.business.address, statement.business.email, statement.business.phone, statement.business.gstin ? `GSTIN: ${statement.business.gstin}` : ""].filter(Boolean).join(" | "), style: "muted" },
        { text: "\nBill To", style: "section" },
        { text: statement.customer.name, bold: true },
        { text: [statement.customer.billingAddress, statement.customer.email, statement.customer.phone, statement.customer.gstNumber ? `GSTIN: ${statement.customer.gstNumber}` : ""].filter(Boolean).join(" | "), style: "muted" },
        { text: `Period: ${statement.period.from ? formatDate(statement.period.from) : "Beginning"} to ${statement.period.to ? formatDate(statement.period.to) : "Today"}`, margin: [0, 12, 0, 8] },
        {
          columns: [
            { text: `Opening: ₹${statement.openingBalance.toFixed(2)}`, style: "summary" },
            { text: `Debit: ₹${statement.totalDebit.toFixed(2)}`, style: "summary" },
            { text: `Credit: ₹${statement.totalCredit.toFixed(2)}`, style: "summary" },
            { text: `Closing: ₹${statement.closingBalance.toFixed(2)}`, style: "summary" },
          ],
          columnGap: 8,
          margin: [0, 0, 0, 12],
        },
        { table: { headerRows: 1, widths: [58, "*", 72, 58, 58, 64], body }, layout: "lightHorizontalLines" },
      ],
      styles: {
        title: { fontSize: 20, bold: true, margin: [0, 0, 0, 8] },
        business: { fontSize: 12, bold: true },
        section: { fontSize: 11, bold: true, color: "#2563eb" },
        muted: { fontSize: 8, color: "#64748b" },
        summary: { fontSize: 9, bold: true, color: "#0f172a" },
      },
      defaultStyle: { fontSize: 8.5, color: "#0f172a" },
    };
    pdfMake.createPdf(definition).getBuffer((buffer) => resolve(Buffer.from(buffer)));
  });

module.exports = {
  buildCustomerStatement,
  buildStatementCsv,
  buildStatementPdfBuffer,
  ledgerEventTypeForStatementType,
};
