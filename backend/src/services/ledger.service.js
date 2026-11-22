const CustomerLedger = require("../models/CustomerLedger");
const SupplierLedger = require("../models/SupplierLedger");

const isDuplicateKeyError = (error) => error?.code === 11000;

const createLedgerEntryOnce = async (Model, entry, options = {}) => {
  try {
    const [created] = await Model.create([entry], { session: options.session });
    return created;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    return Model.findOne({
      businessId: entry.businessId,
      ...(entry.sourceKey ? { sourceKey: entry.sourceKey } : {}),
      ...(entry.paymentId ? { paymentId: entry.paymentId } : {}),
      ...(entry.allocationId ? { allocationId: entry.allocationId } : {}),
      ...(entry.reversalId ? { reversalId: entry.reversalId } : {}),
    }).session(options.session || null);
  }
};

const createCustomerLedgerEntryOnce = (entry, options) => {
  // A zero-value invoice (or its cancellation) creates no receivable movement.
  // Keep positive-amount validation for payments and every actual ledger entry.
  if (entry.invoiceId && ['INVOICE', 'REVERSAL'].includes(entry.eventType) && entry.amount === 0) return Promise.resolve(null);
  return createLedgerEntryOnce(CustomerLedger, entry, options);
};

const createSupplierLedgerEntryOnce = (entry, options) =>
  createLedgerEntryOnce(SupplierLedger, entry, options);

const toPaise = (amount) => Math.round(Number(amount || 0) * 100);
const fromPaise = (paise) => Math.round(paise) / 100;

/**
 * What the customer ledger currently says is owed for one invoice (its issue,
 * earlier edits and any cancellation - payments are separate), per customer.
 */
const netInvoiceReceivables = async ({ businessId, invoiceId, session }) => {
  const rows = await CustomerLedger.find({
    businessId,
    invoiceId,
    eventType: { $in: ["INVOICE", "REVERSAL"] },
    paymentId: null,
    allocationId: null,
    reversalId: null,
  }).session(session || null);
  const byCustomer = new Map();
  for (const row of rows) {
    const key = String(row.customerId);
    const current = byCustomer.get(key) || { customerId: row.customerId, netPaise: 0 };
    current.netPaise += (row.direction === "DEBIT" ? 1 : -1) * toPaise(row.amount);
    byCustomer.set(key, current);
  }
  return [...byCustomer.values()].filter((row) => row.netPaise !== 0);
};

/**
 * Make the ledger say the invoice is owed by targetCustomerId for targetAmount
 * (no customer = nothing owed, e.g. on cancellation): reverse what it says now
 * and book the new amount. Keys start with keyPrefix so a retried request
 * writes nothing twice.
 */
const rebookInvoiceReceivable = async ({ businessId, invoiceId, targetCustomerId = null, targetAmount = 0, keyPrefix, singleCreditKey = "", createdBy = null, notes = "", session }) => {
  const current = await netInvoiceReceivables({ businessId, invoiceId, session });
  const targetPaise = targetCustomerId ? toPaise(targetAmount) : 0;
  if (
    targetPaise > 0 &&
    current.length === 1 &&
    String(current[0].customerId) === String(targetCustomerId) &&
    current[0].netPaise === targetPaise
  ) {
    return [];
  }
  const written = [];
  const onlyOne = current.length === 1 && current[0].netPaise > 0;
  for (const row of current) {
    const credit = row.netPaise > 0;
    const sourceKey = credit && onlyOne && singleCreditKey ? singleCreditKey : `${keyPrefix}:${credit ? "CREDIT" : "DEBIT"}:${row.customerId}`;
    written.push(
      await createCustomerLedgerEntryOnce(
        {
          businessId,
          customerId: row.customerId,
          eventType: credit ? "REVERSAL" : "INVOICE",
          amount: fromPaise(Math.abs(row.netPaise)),
          direction: credit ? "CREDIT" : "DEBIT",
          invoiceId,
          sourceKey,
          createdBy,
          notes,
        },
        { session }
      )
    );
  }
  if (targetPaise > 0) {
    written.push(
      await createCustomerLedgerEntryOnce(
        {
          businessId,
          customerId: targetCustomerId,
          eventType: "INVOICE",
          amount: fromPaise(targetPaise),
          direction: "DEBIT",
          invoiceId,
          sourceKey: `${keyPrefix}:DEBIT`,
          createdBy,
          notes,
        },
        { session }
      )
    );
  }
  return written;
};

module.exports = {
  netInvoiceReceivables,
  rebookInvoiceReceivable,
  createCustomerLedgerEntryOnce,
  createSupplierLedgerEntryOnce,
};
