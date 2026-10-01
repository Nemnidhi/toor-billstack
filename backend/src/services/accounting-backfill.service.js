const mongoose = require("mongoose");
const Business = require("../models/Business");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const PaymentAllocation = require("../models/PaymentAllocation");
const PaymentAllocationReversal = require("../models/PaymentAllocationReversal");
const Expense = require("../models/Expense");
const Account = require("../models/Account");
const JournalEntry = require("../models/JournalEntry");
const AppError = require("../utils/appError");
const { toMinorUnits, fromMinorUnits } = require("../utils/money");
const {
  ensureDefaultAccounts,
  postInvoiceJournalEntry,
  postPaymentReceivedJournalEntry,
  postPaymentAllocatedJournalEntry,
  postPaymentAllocationReversalJournalEntry,
  postPaymentReversalJournalEntry,
  postExpenseJournalEntry,
  postInvoiceCancellationJournalEntry,
  postJournalEntry,
} = require("./accounting.service");

/**
 * Historical Accounting Backfill Service
 * Safely processes historical financial records into double-entry JournalEntry records.
 * Supports DRY_RUN and EXECUTE modes.
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
  if (fromDate && toDate) {
    dateFilter.$gte = new Date(fromDate);
    dateFilter.$lte = new Date(toDate);
  } else if (toDate) {
    dateFilter.$lte = new Date(toDate);
  } else if (fromDate) {
    dateFilter.$gte = new Date(fromDate);
  }

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
    breakdown: {
      invoices: { candidates: 0, alreadyPosted: 0, wouldPost: 0, posted: 0, unresolved: 0 },
      payments: { candidates: 0, alreadyPosted: 0, wouldPost: 0, posted: 0, unresolved: 0 },
      allocations: { candidates: 0, alreadyPosted: 0, wouldPost: 0, posted: 0, unresolved: 0 },
      expenses: { candidates: 0, alreadyPosted: 0, wouldPost: 0, posted: 0, unresolved: 0 },
      cancellations: { candidates: 0, alreadyPosted: 0, wouldPost: 0, posted: 0, unresolved: 0 },
    },
    unresolvedItems: [],
  };

  // 1. INVOICES (Issued / Paid / Partial / Unpaid)
  const invQuery = { businessId, status: { $in: ["issued", "cancelled"] } };
  if (Object.keys(dateFilter).length > 0) invQuery.invoiceDate = dateFilter;
  const invoices = await Invoice.find(invQuery).sort("invoiceDate");

  for (const inv of invoices) {
    results.summary.totalCandidates++;
    results.breakdown.invoices.candidates++;

    // Validation check: must have positive grandTotal
    if (!inv.grandTotal || inv.grandTotal <= 0) {
      results.summary.invalid++;
      results.breakdown.invoices.unresolved++;
      results.unresolvedItems.push({
        type: "INVOICE",
        id: inv._id,
        number: inv.invoiceNumber,
        reason: "Invoice grandTotal must be greater than zero",
      });
      continue;
    }

    const sourceKey = "INVOICE:" + inv._id + ":ISSUED";
    const existing = await JournalEntry.findOne({ businessId, sourceKey });

    if (existing) {
      results.summary.alreadyPosted++;
      results.breakdown.invoices.alreadyPosted++;
    } else {
      results.breakdown.invoices.wouldPost++;
      if (!isDryRun) {
        try {
          await postInvoiceJournalEntry({ invoice: inv, business, userId });
          results.summary.posted++;
          results.breakdown.invoices.posted++;
        } catch (err) {
          results.summary.unresolved++;
          results.breakdown.invoices.unresolved++;
          results.unresolvedItems.push({
            type: "INVOICE",
            id: inv._id,
            number: inv.invoiceNumber,
            reason: err.message,
          });
        }
      }
    }

    // Cancellation check
    if (inv.status === "cancelled") {
      results.summary.totalCandidates++;
      results.breakdown.cancellations.candidates++;
      const cancelSourceKey = "INVOICE:" + inv._id + ":CANCEL";
      const existingCancel = await JournalEntry.findOne({ businessId, sourceKey: cancelSourceKey });

      if (existingCancel) {
        results.summary.alreadyPosted++;
        results.breakdown.cancellations.alreadyPosted++;
      } else {
        results.breakdown.cancellations.wouldPost++;
        if (!isDryRun) {
          try {
            await postInvoiceCancellationJournalEntry({ invoice: inv, userId });
            results.summary.posted++;
            results.breakdown.cancellations.posted++;
          } catch (err) {
            results.summary.unresolved++;
            results.breakdown.cancellations.unresolved++;
            results.unresolvedItems.push({
              type: "INVOICE_CANCELLATION",
              id: inv._id,
              number: inv.invoiceNumber,
              reason: err.message,
            });
          }
        }
      }
    }
  }

  // 2. PAYMENTS (Receipts)
  const payQuery = { businessId, status: { $ne: "cancelled" } };
  if (Object.keys(dateFilter).length > 0) payQuery.paymentDate = dateFilter;
  const payments = await Payment.find(payQuery).sort("paymentDate");

  for (const pay of payments) {
    results.summary.totalCandidates++;
    results.breakdown.payments.candidates++;

    if (!pay.amount || pay.amount <= 0) {
      results.summary.invalid++;
      results.breakdown.payments.unresolved++;
      results.unresolvedItems.push({
        type: "PAYMENT",
        id: pay._id,
        number: pay.referenceNumber || pay._id,
        reason: "Payment amount must be greater than zero",
      });
      continue;
    }

    const sourceKey = "PAYMENT:" + pay._id + ":RECEIVED";
    const existing = await JournalEntry.findOne({ businessId, sourceKey });

    if (existing) {
      results.summary.alreadyPosted++;
      results.breakdown.payments.alreadyPosted++;
    } else {
      results.breakdown.payments.wouldPost++;
      if (!isDryRun) {
        try {
          if (pay.direction === "RECEIVED") {
            await postPaymentReceivedJournalEntry({ payment: pay, userId });
            results.summary.posted++;
            results.breakdown.payments.posted++;
          }
        } catch (err) {
          results.summary.unresolved++;
          results.breakdown.payments.unresolved++;
          results.unresolvedItems.push({
            type: "PAYMENT",
            id: pay._id,
            number: pay.referenceNumber,
            reason: err.message,
          });
        }
      }
    }
  }

  // 3. PAYMENT ALLOCATIONS
  const allocQuery = { businessId };
  if (Object.keys(dateFilter).length > 0) allocQuery.allocatedAt = dateFilter;
  const allocations = await PaymentAllocation.find(allocQuery).sort("allocatedAt createdAt");

  for (const alloc of allocations) {
    results.summary.totalCandidates++;
    results.breakdown.allocations.candidates++;

    const allocAmount = alloc.allocatedAmount ?? alloc.amount;
    if (!allocAmount || allocAmount <= 0 || !alloc.invoiceId) {
      continue; // Skip non-invoice or zero allocations
    }

    const sourceKey = "ALLOCATION:" + alloc._id + ":POSTED";
    const existing = await JournalEntry.findOne({ businessId, sourceKey });

    if (existing) {
      results.summary.alreadyPosted++;
      results.breakdown.allocations.alreadyPosted++;
    } else {
      results.breakdown.allocations.wouldPost++;
      if (!isDryRun) {
        try {
          const parentPayment = await Payment.findById(alloc.paymentId);
          if (!parentPayment) throw new Error("Parent payment document not found");
          await postPaymentAllocatedJournalEntry({
            allocation: alloc,
            payment: parentPayment,
            invoiceId: alloc.invoiceId,
            userId,
          });
          results.summary.posted++;
          results.breakdown.allocations.posted++;
        } catch (err) {
          results.summary.unresolved++;
          results.breakdown.allocations.unresolved++;
          results.unresolvedItems.push({
            type: "PAYMENT_ALLOCATION",
            id: alloc._id,
            reason: err.message,
          });
        }
      }
    }
  }

  // 4. EXPENSES
  const expQuery = { businessId, status: { $ne: "CANCELLED" } };
  if (Object.keys(dateFilter).length > 0) expQuery.expenseDate = dateFilter;
  const expenses = await Expense.find(expQuery).sort("expenseDate");

  for (const exp of expenses) {
    results.summary.totalCandidates++;
    results.breakdown.expenses.candidates++;

    const totalAmt = exp.totalAmount || exp.amountBeforeTax || 0;
    if (totalAmt <= 0) {
      results.summary.invalid++;
      results.breakdown.expenses.unresolved++;
      results.unresolvedItems.push({
        type: "EXPENSE",
        id: exp._id,
        number: exp.expenseNumber,
        reason: "Expense amount must be greater than zero",
      });
      continue;
    }

    const sourceKey = "EXPENSE:" + exp._id + ":RECORDED";
    const existing = await JournalEntry.findOne({ businessId, sourceKey });

    if (existing) {
      results.summary.alreadyPosted++;
      results.breakdown.expenses.alreadyPosted++;
    } else {
      results.breakdown.expenses.wouldPost++;
      if (!isDryRun) {
        try {
          await postExpenseJournalEntry({ expense: exp, business, userId });
          results.summary.posted++;
          results.breakdown.expenses.posted++;
        } catch (err) {
          results.summary.unresolved++;
          results.breakdown.expenses.unresolved++;
          results.unresolvedItems.push({
            type: "EXPENSE",
            id: exp._id,
            number: exp.expenseNumber,
            reason: err.message,
          });
        }
      }
    }
  }

  results.summary.wouldPost =
    results.breakdown.invoices.wouldPost +
    results.breakdown.cancellations.wouldPost +
    results.breakdown.payments.wouldPost +
    results.breakdown.allocations.wouldPost +
    results.breakdown.expenses.wouldPost;

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
