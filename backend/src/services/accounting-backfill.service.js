const Business = require("../models/Business");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const PaymentAllocation = require("../models/PaymentAllocation");
const PaymentAllocationReversal = require("../models/PaymentAllocationReversal");
const Expense = require("../models/Expense");
const Purchase = require("../models/Purchase");
const CreditNote = require("../models/CreditNote");
const SalesReturn = require("../models/SalesReturn");
const Account = require("../models/Account");
const JournalEntry = require("../models/JournalEntry");
const AppError = require("../utils/appError");
const {
  ensureDefaultAccounts,
  buildExpensePostingLines,
  netPostingsFor,
  postInvoiceJournalEntry,
  postPaymentReceivedJournalEntry,
  postPaymentPaidJournalEntry,
  postPaymentAllocatedJournalEntry,
  postPaymentAllocationReversalJournalEntry,
  postPaymentReversalJournalEntry,
  postPurchaseJournalEntry,
  postPurchaseAllocationJournalEntry,
  postPurchaseAllocationReversalJournalEntry,
  postCreditNoteJournalEntry,
  postSalesReturnJournalEntry,
  postExpenseJournalEntry,
  postExpenseCancellationJournalEntry,
  repostEditedExpenseJournalEntry,
  postInvoiceCancellationJournalEntry,
  postJournalEntry,
} = require("./accounting.service");

const CATEGORIES = [
  "invoices",
  "cancellations",
  "receipts",
  "supplierPayments",
  "refunds",
  "allocations",
  "allocationReversals",
  "purchases",
  "creditNotes",
  "salesReturns",
  "expenses",
  "expenseCorrections",
];

const netMatches = (netLines, postingLines) => {
  const key = (line) => `${String(line.accountId)}|${String(line.centre || "").trim()}`;
  const want = new Map();
  for (const line of postingLines) want.set(key(line), (want.get(key(line)) || 0) + Number(line.debitMinor || 0) - Number(line.creditMinor || 0));
  for (const [k, value] of [...want.entries()]) if (value === 0) want.delete(k);
  return want.size === netLines.length && netLines.every((row) => want.get(key(row)) === row.netMinor);
};

/**
 * Historical Accounting Backfill Service
 * Posts every money record saved before its journal posting existed: invoices and
 * cancellations, customer receipts, supplier / landlord payments, refunds,
 * allocations to invoices and purchase bills and their reversals, purchase bills,
 * credit notes, sales returns and expenses. It also brings already-posted expenses
 * in line with the expense as it is now (expense head by category, centre, later
 * edits, cancellations). Every posting has a fixed key, so running it again never
 * posts twice. DRY_RUN only counts; EXECUTE posts.
 */
const runHistoricalBackfill = async ({
  businessId,
  userId,
  mode = "DRY_RUN",
  fromDate = null,
  toDate = null,
}) => {
  const business = await Business.findById(businessId);
  if (!business) throw new AppError("Business billing entity not found", 404);

  await ensureDefaultAccounts({ businessId });

  const isDryRun = mode.toUpperCase() === "DRY_RUN";

  const dateFilter = {};
  if (fromDate) dateFilter.$gte = new Date(fromDate);
  if (toDate) dateFilter.$lte = new Date(toDate);
  const inRange = (field) => (Object.keys(dateFilter).length ? { [field]: dateFilter } : {});

  const results = {
    business: {
      id: business._id,
      name: business.name,
      code: business.billingEntityCode || "TOOR",
    },
    mode: isDryRun ? "DRY_RUN" : "EXECUTE",
    executedAt: new Date().toISOString(),
    summary: {
      totalCandidates: 0,
      alreadyPosted: 0,
      wouldPost: 0,
      posted: 0,
      unresolved: 0,
      invalid: 0,
    },
    breakdown: Object.fromEntries(CATEGORIES.map((name) => [name, { candidates: 0, alreadyPosted: 0, wouldPost: 0, posted: 0, unresolved: 0 }])),
    unresolvedItems: [],
  };

  const posted = async (sourceKey) => Boolean(await JournalEntry.exists({ businessId, sourceKey }));

  /**
   * One record: count it, skip it if its key is already in the journal, otherwise
   * post it (EXECUTE) or count it as would-post (DRY_RUN).
   * invalidReason: a reason string when the record cannot be posted at all.
   */
  const handle = async ({ category, type, id, number, sourceKey, invalidReason, post }) => {
    const row = results.breakdown[category];
    results.summary.totalCandidates++;
    row.candidates++;
    if (invalidReason) {
      results.summary.invalid++;
      row.unresolved++;
      results.unresolvedItems.push({ type, id, number, reason: invalidReason });
      return;
    }
    if (sourceKey && (await posted(sourceKey))) {
      results.summary.alreadyPosted++;
      row.alreadyPosted++;
      return;
    }
    row.wouldPost++;
    if (isDryRun) return;
    try {
      await post();
      results.summary.posted++;
      row.posted++;
    } catch (err) {
      results.summary.unresolved++;
      row.unresolved++;
      results.unresolvedItems.push({ type, id, number, reason: err.message });
    }
  };

  // 1. INVOICES and their cancellations
  const invoices = await Invoice.find({ businessId, status: { $in: ["issued", "cancelled"] }, ...inRange("invoiceDate") }).sort("invoiceDate");
  const invoiceById = new Map(invoices.map((inv) => [String(inv._id), inv]));
  for (const inv of invoices) {
    await handle({
      category: "invoices",
      type: "INVOICE",
      id: inv._id,
      number: inv.invoiceNumber,
      sourceKey: `INVOICE:${inv._id}:ISSUED`,
      invalidReason: !inv.grandTotal || inv.grandTotal <= 0 ? "Invoice grandTotal must be greater than zero" : null,
      post: () => postInvoiceJournalEntry({ invoice: inv, business, userId }),
    });
    if (inv.status === "cancelled" && inv.grandTotal > 0) {
      await handle({
        category: "cancellations",
        type: "INVOICE_CANCELLATION",
        id: inv._id,
        number: inv.invoiceNumber,
        sourceKey: `INVOICE:${inv._id}:CANCEL`,
        post: () => postInvoiceCancellationJournalEntry({ invoice: inv, userId }),
      });
    }
  }

  // 2. PAYMENTS: customer receipts, supplier / landlord payments, refunds of either
  const payments = await Payment.find({ businessId, ...inRange("paymentDate") }).sort("paymentDate createdAt");
  const paymentById = new Map(payments.map((pay) => [String(pay._id), pay]));
  const findPayment = async (id) => paymentById.get(String(id)) || Payment.findOne({ _id: id, businessId });
  for (const pay of payments) {
    const invalidReason = !pay.amount || pay.amount <= 0 ? "Payment amount must be greater than zero" : null;
    const number = pay.referenceNumber || String(pay._id);
    if (pay.reversalOfPaymentId) {
      await handle({
        category: "refunds",
        type: "PAYMENT_REVERSAL",
        id: pay._id,
        number,
        sourceKey: `PAYMENT_REVERSAL:${pay._id}`,
        invalidReason,
        post: async () => {
          const original = await findPayment(pay.reversalOfPaymentId);
          if (!original) throw new Error("Original payment not found");
          return postPaymentReversalJournalEntry({ reversalPayment: pay, originalPayment: original, userId });
        },
      });
    } else if (pay.direction === "RECEIVED") {
      await handle({
        category: "receipts",
        type: "PAYMENT",
        id: pay._id,
        number,
        sourceKey: `PAYMENT:${pay._id}:RECEIVED`,
        invalidReason,
        post: () => postPaymentReceivedJournalEntry({ payment: pay, userId }),
      });
    } else if (pay.direction === "PAID" && pay.supplierId) {
      await handle({
        category: "supplierPayments",
        type: "SUPPLIER_PAYMENT",
        id: pay._id,
        number,
        sourceKey: `PAYMENT:${pay._id}:PAID`,
        invalidReason,
        post: () => postPaymentPaidJournalEntry({ payment: pay, userId }),
      });
    }
  }

  // 3. ALLOCATIONS of payments to invoices and to purchase bills
  const allocations = await PaymentAllocation.find({ businessId, ...inRange("createdAt") }).sort("createdAt");
  for (const alloc of allocations) {
    const amount = alloc.allocatedAmount ?? alloc.amount;
    if (!alloc.invoiceId && !alloc.purchaseId) continue;
    await handle({
      category: "allocations",
      type: alloc.invoiceId ? "PAYMENT_ALLOCATION" : "PURCHASE_ALLOCATION",
      id: alloc._id,
      sourceKey: `ALLOCATION:${alloc._id}:POSTED`,
      invalidReason: !amount || amount <= 0 ? "Allocation amount must be greater than zero" : null,
      post: async () => {
        if (alloc.purchaseId) return postPurchaseAllocationJournalEntry({ allocation: alloc, userId });
        const parentPayment = await findPayment(alloc.paymentId);
        if (!parentPayment) throw new Error("Parent payment document not found");
        return postPaymentAllocatedJournalEntry({ allocation: alloc, payment: parentPayment, invoiceId: alloc.invoiceId, userId });
      },
    });
  }

  // 4. ALLOCATION REVERSALS
  const reversals = await PaymentAllocationReversal.find({ businessId, ...inRange("createdAt") }).sort("createdAt");
  for (const reversal of reversals) {
    await handle({
      category: "allocationReversals",
      type: "ALLOCATION_REVERSAL",
      id: reversal._id,
      sourceKey: `ALLOCATION_REVERSAL:${reversal._id}`,
      invalidReason: !reversal.amount || reversal.amount <= 0 ? "Reversal amount must be greater than zero" : null,
      post: async () => {
        const allocation = await PaymentAllocation.findOne({ _id: reversal.allocationId, businessId });
        if (!allocation) throw new Error("Reversed allocation not found");
        if (allocation.purchaseId) return postPurchaseAllocationReversalJournalEntry({ reversal, allocation, userId });
        return postPaymentAllocationReversalJournalEntry({ reversal, allocation, userId });
      },
    });
  }

  // 5. PURCHASE BILLS
  const purchases = await Purchase.find({ businessId, ...inRange("purchaseDate") }).sort("purchaseDate");
  for (const purchase of purchases) {
    await handle({
      category: "purchases",
      type: "PURCHASE",
      id: purchase._id,
      number: purchase.purchaseNumber || String(purchase._id),
      sourceKey: `PURCHASE:${purchase._id}:RECORDED`,
      invalidReason: !purchase.totalAmount || purchase.totalAmount <= 0 ? "Purchase total must be greater than zero" : null,
      post: () => postPurchaseJournalEntry({ purchase, business, userId }),
    });
  }

  // 6. CREDIT NOTES and SALES RETURNS
  const findInvoice = async (id) => invoiceById.get(String(id)) || Invoice.findOne({ _id: id, businessId });
  const notes = await CreditNote.find({ businessId, status: "ISSUED", ...inRange("createdAt") }).sort("createdAt");
  for (const note of notes) {
    await handle({
      category: "creditNotes",
      type: "CREDIT_NOTE",
      id: note._id,
      number: note.creditNoteNumber,
      sourceKey: `CREDIT_NOTE:${note._id}:ISSUED`,
      post: async () => {
        const invoice = await findInvoice(note.invoiceId);
        if (!invoice) throw new Error("Invoice for this credit note not found");
        return postCreditNoteJournalEntry({ note, invoice, business, userId });
      },
    });
  }
  const returns = await SalesReturn.find({ businessId, status: "ISSUED", ...inRange("createdAt") }).sort("createdAt");
  for (const ret of returns) {
    await handle({
      category: "salesReturns",
      type: "SALES_RETURN",
      id: ret._id,
      number: ret.returnNumber,
      sourceKey: `SALES_RETURN:${ret._id}:ISSUED`,
      invalidReason: !ret.totalAmount || ret.totalAmount <= 0 ? "Return value must be greater than zero" : null,
      post: async () => {
        const invoice = await findInvoice(ret.invoiceId);
        if (!invoice) throw new Error("Invoice for this return not found");
        return postSalesReturnJournalEntry({ ret, invoice, business, userId });
      },
    });
  }

  // 7. EXPENSES: post the missing ones, then bring posted ones in line with the
  // expense as it is now (expense head, centre, edits saved before edits were
  // posted, cancellations).
  const expenses = await Expense.find({ businessId, ...inRange("expenseDate") }).sort("expenseDate");
  const runStamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  for (const exp of expenses) {
    const firstKey = `EXPENSE:${exp._id}:RECORDED`;
    const hasFirst = await posted(firstKey);
    if (exp.status !== "CANCELLED" && !hasFirst) {
      const totalAmt = exp.totalAmount || exp.amountBeforeTax || 0;
      await handle({
        category: "expenses",
        type: "EXPENSE",
        id: exp._id,
        number: exp.expenseNumber,
        sourceKey: firstKey,
        invalidReason: totalAmt <= 0 ? "Expense amount must be greater than zero" : null,
        post: () => postExpenseJournalEntry({ expense: exp, business, userId }),
      });
      continue;
    }
    if (exp.status !== "CANCELLED") {
      results.summary.totalCandidates++;
      results.breakdown.expenses.candidates++;
      results.summary.alreadyPosted++;
      results.breakdown.expenses.alreadyPosted++;
    }
    if (!hasFirst) continue; // cancelled and never posted: nothing in the books

    const current = await netPostingsFor({ businessId, keyType: "EXPENSE", recordId: exp._id });
    const target = exp.status === "CANCELLED" ? [] : await buildExpensePostingLines({ expense: exp, business });
    if (netMatches(current.lines, target)) continue;
    await handle({
      category: "expenseCorrections",
      type: exp.status === "CANCELLED" ? "EXPENSE_CANCELLATION" : "EXPENSE_CORRECTION",
      id: exp._id,
      number: exp.expenseNumber,
      sourceKey: null,
      post: () =>
        exp.status === "CANCELLED"
          ? postExpenseCancellationJournalEntry({ expense: exp, userId })
          : repostEditedExpenseJournalEntry({ expense: exp, business, previousExpenseDate: current.first?.entryDate || exp.expenseDate, editKey: `BACKFILL-${runStamp}`, userId }),
    });
  }

  results.summary.wouldPost = CATEGORIES.reduce((sum, name) => sum + results.breakdown[name].wouldPost, 0);

  return results;
};

/**
 * Opening Balance Posting Primitive:
 * Requires explicit balanced debits and credits.
 * Never creates fake balancing entries.
 */
const postOpeningBalances = async ({
  businessId,
  userId,
  effectiveDate,
  description = "Opening balance entry",
  lines = [],
}) => {
  if (!effectiveDate) throw new AppError("Effective date is required for opening balances", 400);
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new AppError("Opening balance entry must have at least 2 balanced lines", 400);
  }

  await ensureDefaultAccounts({ businessId });

  const accounts = await Account.find({ businessId });
  const accountsMap = new Map(accounts.map((a) => [a._id.toString(), a]));

  const dateObj = new Date(effectiveDate);
  if (isNaN(dateObj.getTime())) throw new AppError("Invalid effective date format", 400);

  const dateStr = dateObj.toISOString().slice(0, 10);
  const sourceKey = "OPENING_BALANCE:" + dateStr;

  const sanitizedLines = lines.map((l) => {
    const acc = accountsMap.get(String(l.accountId));
    if (!acc) throw new AppError("Account not found: " + l.accountId, 404);

    const debitMinor = Math.round(Number(l.debitMinor || 0));
    const creditMinor = Math.round(Number(l.creditMinor || 0));

    return {
      accountId: acc._id,
      accountCode: acc.code,
      accountName: acc.name,
      debitMinor,
      creditMinor,
      description: l.description || ("Opening balance for " + acc.name),
    };
  });

  return postJournalEntry({
    businessId,
    userId,
    entryDate: dateObj,
    sourceType: "OPENING_BALANCE",
    sourceKey,
    description,
    lines: sanitizedLines,
  });
};

module.exports = {
  runHistoricalBackfill,
  postOpeningBalances,
};
