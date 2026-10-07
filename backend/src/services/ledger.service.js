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

module.exports = {
  createCustomerLedgerEntryOnce,
  createSupplierLedgerEntryOnce,
};
