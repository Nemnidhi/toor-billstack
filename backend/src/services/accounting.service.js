const mongoose = require("mongoose");
const Account = require("../models/Account");
const JournalEntry = require("../models/JournalEntry");
const Business = require("../models/Business");
const AppError = require("../utils/appError");
const { SYSTEM_ACCOUNTS } = require("../constants/accounting");
const { fromMinorUnits, toMinorUnits } = require("../utils/money");

/**
 * Ensure default Chart of Accounts exists for a billing entity / businessId.
 * Idempotent, safe to call on every accounting operation.
 */
const ensureDefaultAccounts = async ({ businessId, session }) => {
  const existing = await Account.find({ businessId }).session(session);
  const existingCodeMap = new Map(existing.map((a) => [a.code, a]));

  const missing = SYSTEM_ACCOUNTS.filter((acc) => !existingCodeMap.has(acc.code));

  if (missing.length > 0) {
    try {
      const created = await Account.insertMany(
        missing.map((acc) => ({
          businessId,
          code: acc.code,
          name: acc.name,
          type: acc.type,
          normalBalance: acc.normalBalance,
          description: acc.description,
          isSystem: true,
          isActive: true,
        })),
        { session }
      );
      created.forEach((acc) => existingCodeMap.set(acc.code, acc));
    } catch (err) {
      // In case of concurrent insertion race, re-query
      const reloaded = await Account.find({ businessId }).session(session);
      reloaded.forEach((a) => existingCodeMap.set(a.code, a));
    }
  }

  return existingCodeMap;
};

/**
 * Generate sequential journal entry number for a business.
 */
const nextJournalEntryNumber = async ({ businessId, session }) => {
  const count = await JournalEntry.countDocuments({ businessId }).session(session);
  const year = new Date().getFullYear();
  return `JE-${year}-${String(count + 1).padStart(5, "0")}`;
};

/**
 * Core primitive: Post a balanced double-entry JournalEntry.
 * Server-side rejection of unbalanced entries.
 * Idempotent via { businessId, sourceKey }.
 */
const postJournalEntry = async ({
  businessId,
  userId,
  entryDate = new Date(),
  sourceType,
  sourceId = null,
  sourceKey,
  description,
  lines,
  reversalOfEntryId = null,
  session,
}) => {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new AppError("Journal entry must have at least 2 lines", 400);
  }

  let totalDebitMinor = 0;
  let totalCreditMinor = 0;

  const sanitizedLines = lines.map((line) => {
    const debitMinor = Math.round(Number(line.debitMinor || 0));
    const creditMinor = Math.round(Number(line.creditMinor || 0));

    if (debitMinor < 0 || creditMinor < 0) {
      throw new AppError("Debit and credit amounts cannot be negative", 400);
    }
    if (debitMinor > 0 && creditMinor > 0) {
      throw new AppError("A single journal line cannot have both debit and credit", 400);
    }
    if (debitMinor === 0 && creditMinor === 0) {
      throw new AppError("Journal line must have a non-zero debit or credit amount", 400);
    }

    totalDebitMinor += debitMinor;
    totalCreditMinor += creditMinor;

    return {
      accountId: line.accountId,
      accountCode: line.accountCode,
      accountName: line.accountName,
      debitMinor,
      creditMinor,
      description: line.description || "",
    };
  });

  // Balanced entry validation
  if (totalDebitMinor !== totalCreditMinor) {
    throw new AppError(
      `Balanced entry validation failed: Debits (${fromMinorUnits(totalDebitMinor)}) != Credits (${fromMinorUnits(totalCreditMinor)})`,
      400
    );
  }

  if (totalDebitMinor === 0) {
    throw new AppError("Journal entry total amount must be greater than zero", 400);
  }

  // Idempotency check: return existing if already posted
  if (sourceKey) {
    const existing = await JournalEntry.findOne({ businessId, sourceKey }).session(session);
    if (existing) return existing;
  }

  const entryNumber = await nextJournalEntryNumber({ businessId, session });

  try {
    const [entry] = await JournalEntry.create(
      [
        {
          businessId,
          entryNumber,
          entryDate,
          sourceType,
          sourceId,
          sourceKey,
          description,
          status: "POSTED",
          reversalOfEntryId,
          lines: sanitizedLines,
          totalDebitMinor,
          totalCreditMinor,
          createdBy: userId,
        },
      ],
      { session }
    );
    return entry;
  } catch (err) {
    if (err.code === 11000 && sourceKey) {
      const existing = await JournalEntry.findOne({ businessId, sourceKey }).session(session);
      if (existing) return existing;
    }
    throw err;
  }
};

/**
 * Automatically post Journal Entry for an issued invoice.
 * TOOR: Posts AR, Revenue, Output GST (CGST/SGST or IGST).
 * Goldhawk: Posts AR, Revenue. GST is strictly ZERO.
 */
const postInvoiceJournalEntry = async ({ invoice, business, userId, session }) => {
  const accounts = await ensureDefaultAccounts({ businessId: invoice.businessId, session });

  const isGoldhawk =
    business?.billingEntityCode === "GOLDHAWK" ||
    invoice?.sellerSnapshot?.billingEntityCode === "GOLDHAWK";

  const arAccount = accounts.get("1100"); // Accounts Receivable

  // Choose appropriate revenue account
  let revAccount = accounts.get("4010"); // Sales / Service Revenue (default)
  const isBrokerage =
    invoice.crmSourceRef?.billingPurpose?.includes("BROKERAGE") ||
    (invoice.lineItems || []).some((li) => /brokerage/i.test(li.productName || ""));
  const isRental =
    invoice.crmSourceRef?.billingPurpose?.includes("RENT") ||
    invoice.crmSourceRef?.billingPurpose?.includes("COWORKING") ||
    (invoice.lineItems || []).some((li) => /coworking|rent|desk/i.test(li.productName || ""));

  if (isBrokerage) revAccount = accounts.get("4030");
  else if (isRental) revAccount = accounts.get("4020");

  const grandTotalMinor = toMinorUnits(invoice.grandTotal);
  let cgstMinor = 0;
  let sgstMinor = 0;
  let igstMinor = 0;

  // Goldhawk MUST NOT post GST amounts
  if (!isGoldhawk && invoice.totalTax > 0) {
    const breakup = invoice.gstBreakup || invoice.gstSnapshot || {};
    cgstMinor = toMinorUnits(breakup.cgst || 0, "CGST", { allowZero: true });
    sgstMinor = toMinorUnits(breakup.sgst || 0, "SGST", { allowZero: true });
    igstMinor = toMinorUnits(breakup.igst || 0, "IGST", { allowZero: true });

    // Fallback if breakup is not split but totalTax > 0
    if (cgstMinor + sgstMinor + igstMinor === 0 && invoice.totalTax > 0) {
      cgstMinor = Math.floor(toMinorUnits(invoice.totalTax) / 2);
      sgstMinor = toMinorUnits(invoice.totalTax) - cgstMinor;
    }
  }

  const taxTotalMinor = cgstMinor + sgstMinor + igstMinor;
  const revenueMinor = grandTotalMinor - taxTotalMinor;

  const lines = [
    {
      accountId: arAccount._id,
      accountCode: arAccount.code,
      accountName: arAccount.name,
      debitMinor: grandTotalMinor,
      creditMinor: 0,
      description: `Invoice ${invoice.invoiceNumber} receivable`,
    },
    {
      accountId: revAccount._id,
      accountCode: revAccount.code,
      accountName: revAccount.name,
      debitMinor: 0,
      creditMinor: revenueMinor,
      description: `Invoice ${invoice.invoiceNumber} revenue`,
    },
  ];

  if (cgstMinor > 0) {
    const cgstAcc = accounts.get("2210");
    lines.push({
      accountId: cgstAcc._id,
      accountCode: cgstAcc.code,
      accountName: cgstAcc.name,
      debitMinor: 0,
      creditMinor: cgstMinor,
      description: `Invoice ${invoice.invoiceNumber} CGST output`,
    });
  }

  if (sgstMinor > 0) {
    const sgstAcc = accounts.get("2220");
    lines.push({
      accountId: sgstAcc._id,
      accountCode: sgstAcc.code,
      accountName: sgstAcc.name,
      debitMinor: 0,
      creditMinor: sgstMinor,
      description: `Invoice ${invoice.invoiceNumber} SGST output`,
    });
  }

  if (igstMinor > 0) {
    const igstAcc = accounts.get("2230");
    lines.push({
      accountId: igstAcc._id,
      accountCode: igstAcc.code,
      accountName: igstAcc.name,
      debitMinor: 0,
      creditMinor: igstMinor,
      description: `Invoice ${invoice.invoiceNumber} IGST output`,
    });
  }

  return postJournalEntry({
    businessId: invoice.businessId,
    userId,
    entryDate: invoice.invoiceDate || new Date(),
    sourceType: "INVOICE",
    sourceId: invoice._id,
    sourceKey: `INVOICE:${invoice._id}:ISSUED`,
    description: `Issue Invoice ${invoice.invoiceNumber}`,
    lines,
    session,
  });
};

/**
 * Automatically post reversing Journal Entry when an invoice is cancelled.
 */
const postInvoiceCancellationJournalEntry = async ({ invoice, userId, session }) => {
  const original = await JournalEntry.findOne({
    businessId: invoice.businessId,
    sourceKey: `INVOICE:${invoice._id}:ISSUED`,
  }).session(session);

  if (!original) return null;

  // Reverse every line: debits become credits, credits become debits
  const reversedLines = original.lines.map((l) => ({
    accountId: l.accountId,
    accountCode: l.accountCode,
    accountName: l.accountName,
    debitMinor: l.creditMinor,
    creditMinor: l.debitMinor,
    description: `Cancellation reversal: ${l.description}`,
  }));

  return postJournalEntry({
    businessId: invoice.businessId,
    userId,
    entryDate: new Date(),
    sourceType: "REVERSAL",
    sourceId: invoice._id,
    sourceKey: `INVOICE:${invoice._id}:CANCEL`,
    description: `Cancel Invoice ${invoice.invoiceNumber} (reversal of ${original.entryNumber})`,
    lines: reversedLines,
    reversalOfEntryId: original._id,
    session,
  });
};

/**
 * Automatically post Journal Entry when a payment is received.
 * Direction: RECEIVED
 * Dr Cash/Bank
 * Cr Customer Advances
 */
const postPaymentReceivedJournalEntry = async ({ payment, userId, session }) => {
  if (payment.direction !== "RECEIVED") return null;

  const accounts = await ensureDefaultAccounts({ businessId: payment.businessId, session });
  const isCash = String(payment.paymentMethod || "").toUpperCase() === "CASH";
  const bankAcc = accounts.get(isCash ? "1010" : "1020");
  const advAcc = accounts.get("2100"); // Customer Advances

  const amountMinor = toMinorUnits(payment.amount);

  const lines = [
    {
      accountId: bankAcc._id,
      accountCode: bankAcc.code,
      accountName: bankAcc.name,
      debitMinor: amountMinor,
      creditMinor: 0,
      description: `Payment received ${payment.referenceNumber || payment._id}`,
    },
    {
      accountId: advAcc._id,
      accountCode: advAcc.code,
      accountName: advAcc.name,
      debitMinor: 0,
      creditMinor: amountMinor,
      description: `Customer advance ${payment.referenceNumber || payment._id}`,
    },
  ];

  return postJournalEntry({
    businessId: payment.businessId,
    userId,
    entryDate: payment.paymentDate || new Date(),
    sourceType: "PAYMENT",
    sourceId: payment._id,
    sourceKey: `PAYMENT:${payment._id}:RECEIVED`,
    description: `Payment received: ${payment.referenceNumber || payment._id}`,
    lines,
    session,
  });
};

/**
 * Automatically post Journal Entry when an advance is allocated to an invoice.
 * Dr Customer Advances
 * Cr Accounts Receivable
 */
const postPaymentAllocatedJournalEntry = async ({ allocation, payment, invoiceId, userId, session }) => {
  if (!allocation.invoiceId && !invoiceId) return null;

  const accounts = await ensureDefaultAccounts({ businessId: allocation.businessId, session });
  const advAcc = accounts.get("2100"); // Customer Advances
  const arAcc = accounts.get("1100");  // Accounts Receivable

  const amountMinor = toMinorUnits(allocation.allocatedAmount);

  const lines = [
    {
      accountId: advAcc._id,
      accountCode: advAcc.code,
      accountName: advAcc.name,
      debitMinor: amountMinor,
      creditMinor: 0,
      description: `Allocation of payment ${allocation.paymentId} to invoice ${allocation.invoiceId || invoiceId}`,
    },
    {
      accountId: arAcc._id,
      accountCode: arAcc.code,
      accountName: arAcc.name,
      debitMinor: 0,
      creditMinor: amountMinor,
      description: `Settlement of invoice ${allocation.invoiceId || invoiceId} via payment ${allocation.paymentId}`,
    },
  ];

  return postJournalEntry({
    businessId: allocation.businessId,
    userId,
    entryDate: new Date(),
    sourceType: "PAYMENT_ALLOCATION",
    sourceId: allocation._id,
    sourceKey: `ALLOCATION:${allocation._id}:POSTED`,
    description: `Payment allocation: ${fromMinorUnits(amountMinor)} to invoice ${allocation.invoiceId || invoiceId}`,
    lines,
    session,
  });
};

/**
 * Automatically post reversing Journal Entry when an allocation is reversed.
 * Dr Accounts Receivable
 * Cr Customer Advances
 */
const postPaymentAllocationReversalJournalEntry = async ({ reversal, allocation, userId, session }) => {
  const accounts = await ensureDefaultAccounts({ businessId: reversal.businessId, session });
  const arAcc = accounts.get("1100");
  const advAcc = accounts.get("2100");

  const amountMinor = toMinorUnits(reversal.amount);

  const lines = [
    {
      accountId: arAcc._id,
      accountCode: arAcc.code,
      accountName: arAcc.name,
      debitMinor: amountMinor,
      creditMinor: 0,
      description: `Reversal of allocation ${allocation._id} - reinstate AR`,
    },
    {
      accountId: advAcc._id,
      accountCode: advAcc.code,
      accountName: advAcc.name,
      debitMinor: 0,
      creditMinor: amountMinor,
      description: `Reversal of allocation ${allocation._id} - restore advance`,
    },
  ];

  return postJournalEntry({
    businessId: reversal.businessId,
    userId,
    entryDate: new Date(),
    sourceType: "REVERSAL",
    sourceId: reversal._id,
    sourceKey: `ALLOCATION_REVERSAL:${reversal._id}`,
    description: `Reversal of payment allocation ${allocation._id}`,
    lines,
    session,
  });
};

/**
 * Automatically post Journal Entry when a payment is refunded / reversed.
 * Dr Customer Advances
 * Cr Bank / Cash
 */
const postPaymentReversalJournalEntry = async ({ reversalPayment, originalPayment, userId, session }) => {
  const accounts = await ensureDefaultAccounts({ businessId: reversalPayment.businessId, session });
  const isCash = String(originalPayment?.paymentMethod || "").toUpperCase() === "CASH";
  const bankAcc = accounts.get(isCash ? "1010" : "1020");
  const advAcc = accounts.get("2100");

  const amountMinor = toMinorUnits(reversalPayment.amount);

  const lines = [
    {
      accountId: advAcc._id,
      accountCode: advAcc.code,
      accountName: advAcc.name,
      debitMinor: amountMinor,
      creditMinor: 0,
      description: `Refund / reversal of payment ${originalPayment?._id}`,
    },
    {
      accountId: bankAcc._id,
      accountCode: bankAcc.code,
      accountName: bankAcc.name,
      debitMinor: 0,
      creditMinor: amountMinor,
      description: `Disbursement for refund of payment ${originalPayment?._id}`,
    },
  ];

  return postJournalEntry({
    businessId: reversalPayment.businessId,
    userId,
    entryDate: new Date(),
    sourceType: "REVERSAL",
    sourceId: reversalPayment._id,
    sourceKey: `PAYMENT_REVERSAL:${reversalPayment._id}`,
    description: `Payment refund / reversal for ${originalPayment?._id}`,
    lines,
    session,
  });
};

/**
 * Automatically post Journal Entry for business expense.
 * TOOR: Posts Expense, Input GST, Bank/AP.
 * Goldhawk: Posts Expense, Bank/AP (strictly ZERO GST).
 */
const postExpenseJournalEntry = async ({ expense, business, userId, session }) => {
  const accounts = await ensureDefaultAccounts({ businessId: expense.businessId, session });

  const isGoldhawk =
    business?.billingEntityCode === "GOLDHAWK" ||
    (await Business.findById(expense.businessId).session(session))?.billingEntityCode === "GOLDHAWK";

  const expAcc = accounts.get("5010"); // General Expenses
  const isCash = String(expense.paymentMethod || "").toUpperCase() === "CASH";
  const bankAcc = accounts.get(isCash ? "1010" : "1020");
  const apAcc = accounts.get("2010"); // Accounts Payable

  const totalAmountMinor = toMinorUnits(expense.totalAmount);
  const amountBeforeTaxMinor = toMinorUnits(expense.amountBeforeTax);

  let cgstMinor = 0;
  let sgstMinor = 0;
  let igstMinor = 0;

  if (!isGoldhawk && expense.gstEnabled && expense.taxAmount > 0) {
    const snap = expense.gstSnapshot || {};
    cgstMinor = toMinorUnits(snap.cgst || 0, "CGST", { allowZero: true });
    sgstMinor = toMinorUnits(snap.sgst || 0, "SGST", { allowZero: true });
    igstMinor = toMinorUnits(snap.igst || 0, "IGST", { allowZero: true });

    if (cgstMinor + sgstMinor + igstMinor === 0 && expense.taxAmount > 0) {
      cgstMinor = Math.floor(toMinorUnits(expense.taxAmount) / 2);
      sgstMinor = toMinorUnits(expense.taxAmount) - cgstMinor;
    }
  }

  const lines = [
    {
      accountId: expAcc._id,
      accountCode: expAcc.code,
      accountName: expAcc.name,
      debitMinor: amountBeforeTaxMinor,
      creditMinor: 0,
      description: `Expense ${expense.expenseNumber}: ${expense.description || expense.category}`,
    },
  ];

  if (cgstMinor > 0) {
    const cgstAcc = accounts.get("1310");
    lines.push({
      accountId: cgstAcc._id,
      accountCode: cgstAcc.code,
      accountName: cgstAcc.name,
      debitMinor: cgstMinor,
      creditMinor: 0,
      description: `Expense ${expense.expenseNumber} CGST input tax credit`,
    });
  }

  if (sgstMinor > 0) {
    const sgstAcc = accounts.get("1320");
    lines.push({
      accountId: sgstAcc._id,
      accountCode: sgstAcc.code,
      accountName: sgstAcc.name,
      debitMinor: sgstMinor,
      creditMinor: 0,
      description: `Expense ${expense.expenseNumber} SGST input tax credit`,
    });
  }

  if (igstMinor > 0) {
    const igstAcc = accounts.get("1330");
    lines.push({
      accountId: igstAcc._id,
      accountCode: igstAcc.code,
      accountName: igstAcc.name,
      debitMinor: igstMinor,
      creditMinor: 0,
      description: `Expense ${expense.expenseNumber} IGST input tax credit`,
    });
  }

  // Credit side: Bank/Cash if PAID, AP if UNPAID, or split if PARTIAL
  const paidMinor = toMinorUnits(expense.paidAmount || 0, "Paid Amount", { allowZero: true });
  const unpaidMinor = totalAmountMinor - paidMinor;

  if (expense.paymentStatus === "PAID" || (paidMinor > 0 && unpaidMinor === 0)) {
    lines.push({
      accountId: bankAcc._id,
      accountCode: bankAcc.code,
      accountName: bankAcc.name,
      debitMinor: 0,
      creditMinor: totalAmountMinor,
      description: `Disbursement for expense ${expense.expenseNumber}`,
    });
  } else if (expense.paymentStatus === "UNPAID" || paidMinor === 0) {
    lines.push({
      accountId: apAcc._id,
      accountCode: apAcc.code,
      accountName: apAcc.name,
      debitMinor: 0,
      creditMinor: totalAmountMinor,
      description: `Payable for expense ${expense.expenseNumber}`,
    });
  } else {
    // PARTIAL: part Bank, part AP
    if (paidMinor > 0) {
      lines.push({
        accountId: bankAcc._id,
        accountCode: bankAcc.code,
        accountName: bankAcc.name,
        debitMinor: 0,
        creditMinor: paidMinor,
        description: `Disbursement for expense ${expense.expenseNumber}`,
      });
    }
    if (unpaidMinor > 0) {
      lines.push({
        accountId: apAcc._id,
        accountCode: apAcc.code,
        accountName: apAcc.name,
        debitMinor: 0,
        creditMinor: unpaidMinor,
        description: `Payable for expense ${expense.expenseNumber}`,
      });
    }
  }

  return postJournalEntry({
    businessId: expense.businessId,
    userId,
    entryDate: expense.expenseDate || new Date(),
    sourceType: "EXPENSE",
    sourceId: expense._id,
    sourceKey: `EXPENSE:${expense._id}:RECORDED`,
    description: `Expense ${expense.expenseNumber}: ${expense.description || expense.category}`,
    lines,
    session,
  });
};

/**
 * Trial Balance Engine: Derived strictly from JournalEntry lines.
 * Returns opening, period, and closing debits & credits.
 * Total debit and credit balance is guaranteed.
 */
const getTrialBalance = async ({ businessId, from, to }) => {
  // Ensure default accounts exist so Chart of Accounts is complete
  const accountsMap = await ensureDefaultAccounts({ businessId });
  const allAccounts = Array.from(accountsMap.values());

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  // Fetch all posted journal entries for this billing entity
  const query = { businessId, status: "POSTED" };
  const entries = await JournalEntry.find(query).sort("entryDate createdAt");

  // Track per-account debit/credit accumulation
  const openingMap = new Map(); // accountId -> { debitMinor, creditMinor }
  const periodMap = new Map();  // accountId -> { debitMinor, creditMinor }

  allAccounts.forEach((acc) => {
    openingMap.set(acc._id.toString(), { debitMinor: 0, creditMinor: 0 });
    periodMap.set(acc._id.toString(), { debitMinor: 0, creditMinor: 0 });
  });

  entries.forEach((entry) => {
    const isPrior = fromDate && entry.entryDate < fromDate;
    const isPeriod = (!fromDate || entry.entryDate >= fromDate) && (!toDate || entry.entryDate <= toDate);

    entry.lines.forEach((line) => {
      const accId = line.accountId.toString();
      if (!openingMap.has(accId)) {
        openingMap.set(accId, { debitMinor: 0, creditMinor: 0 });
        periodMap.set(accId, { debitMinor: 0, creditMinor: 0 });
      }

      if (isPrior) {
        const o = openingMap.get(accId);
        o.debitMinor += line.debitMinor;
        o.creditMinor += line.creditMinor;
      } else if (isPeriod) {
        const p = periodMap.get(accId);
        p.debitMinor += line.debitMinor;
        p.creditMinor += line.creditMinor;
      }
    });
  });

  let totalOpeningDebitMinor = 0;
  let totalOpeningCreditMinor = 0;
  let totalPeriodDebitMinor = 0;
  let totalPeriodCreditMinor = 0;
  let totalClosingDebitMinor = 0;
  let totalClosingCreditMinor = 0;

  const rows = allAccounts.map((acc) => {
    const accId = acc._id.toString();
    const op = openingMap.get(accId) || { debitMinor: 0, creditMinor: 0 };
    const pe = periodMap.get(accId) || { debitMinor: 0, creditMinor: 0 };

    totalOpeningDebitMinor += op.debitMinor;
    totalOpeningCreditMinor += op.creditMinor;
    totalPeriodDebitMinor += pe.debitMinor;
    totalPeriodCreditMinor += pe.creditMinor;

    // Net closing position
    let closingDebitMinor = 0;
    let closingCreditMinor = 0;

    const netDebitMinor = (op.debitMinor + pe.debitMinor) - (op.creditMinor + pe.creditMinor);

    if (acc.normalBalance === "DEBIT") {
      if (netDebitMinor >= 0) {
        closingDebitMinor = netDebitMinor;
      } else {
        closingCreditMinor = Math.abs(netDebitMinor);
      }
    } else {
      // CREDIT normal
      const netCreditMinor = -netDebitMinor;
      if (netCreditMinor >= 0) {
        closingCreditMinor = netCreditMinor;
      } else {
        closingDebitMinor = Math.abs(netCreditMinor);
      }
    }

    totalClosingDebitMinor += closingDebitMinor;
    totalClosingCreditMinor += closingCreditMinor;

    return {
      accountId: acc._id,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      normalBalance: acc.normalBalance,
      opening: {
        debit: fromMinorUnits(op.debitMinor),
        credit: fromMinorUnits(op.creditMinor),
      },
      period: {
        debit: fromMinorUnits(pe.debitMinor),
        credit: fromMinorUnits(pe.creditMinor),
      },
      closing: {
        debit: fromMinorUnits(closingDebitMinor),
        credit: fromMinorUnits(closingCreditMinor),
      },
    };
  });

  return {
    businessId,
    period: { from, to },
    accounts: rows,
    totals: {
      opening: {
        debit: fromMinorUnits(totalOpeningDebitMinor),
        credit: fromMinorUnits(totalOpeningCreditMinor),
      },
      period: {
        debit: fromMinorUnits(totalPeriodDebitMinor),
        credit: fromMinorUnits(totalPeriodCreditMinor),
      },
      closing: {
        debit: fromMinorUnits(totalClosingDebitMinor),
        credit: fromMinorUnits(totalClosingCreditMinor),
      },
      isBalanced: totalClosingDebitMinor === totalClosingCreditMinor,
    },
  };
};

/**
 * Account Ledger Engine: Returns date-ordered transactional activity and running balance.
 */
const getAccountLedger = async ({ businessId, accountId, from, to }) => {
  const account = await Account.findOne({ _id: accountId, businessId });
  if (!account) throw new AppError("Account not found", 404);

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  // Fetch all posted journal entries containing this account
  const entries = await JournalEntry.find({
    businessId,
    status: "POSTED",
    "lines.accountId": account._id,
  }).sort("entryDate createdAt");

  let openingDebitMinor = 0;
  let openingCreditMinor = 0;
  const transactions = [];

  entries.forEach((entry) => {
    const isPrior = fromDate && entry.entryDate < fromDate;
    const isPeriod = (!fromDate || entry.entryDate >= fromDate) && (!toDate || entry.entryDate <= toDate);

    // An entry can theoretically have multiple lines for the same account; sum them
    const matchingLines = entry.lines.filter((l) => l.accountId.toString() === account._id.toString());
    const debitMinor = matchingLines.reduce((s, l) => s + l.debitMinor, 0);
    const creditMinor = matchingLines.reduce((s, l) => s + l.creditMinor, 0);

    if (isPrior) {
      openingDebitMinor += debitMinor;
      openingCreditMinor += creditMinor;
    } else if (isPeriod) {
      transactions.push({
        journalEntryId: entry._id,
        entryNumber: entry.entryNumber,
        entryDate: entry.entryDate,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        description: entry.description,
        debitMinor,
        creditMinor,
        debit: fromMinorUnits(debitMinor),
        credit: fromMinorUnits(creditMinor),
      });
    }
  });

  // Calculate running balance
  let runningNetMinor =
    account.normalBalance === "DEBIT"
      ? openingDebitMinor - openingCreditMinor
      : openingCreditMinor - openingDebitMinor;

  const openingBalance = fromMinorUnits(runningNetMinor);

  const enrichedTransactions = transactions.map((tx) => {
    const delta =
      account.normalBalance === "DEBIT"
        ? tx.debitMinor - tx.creditMinor
        : tx.creditMinor - tx.debitMinor;
    runningNetMinor += delta;
    return {
      ...tx,
      runningBalance: fromMinorUnits(runningNetMinor),
    };
  });

  return {
    account: {
      _id: account._id,
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: account.normalBalance,
    },
    period: { from, to },
    openingBalance,
    transactions: enrichedTransactions,
    closingBalance: fromMinorUnits(runningNetMinor),
  };
};

module.exports = {
  ensureDefaultAccounts,
  getAccountLedger,
  getTrialBalance,
  nextJournalEntryNumber,
  postExpenseJournalEntry,
  postInvoiceCancellationJournalEntry,
  postInvoiceJournalEntry,
  postJournalEntry,
  postPaymentAllocatedJournalEntry,
  postPaymentAllocationReversalJournalEntry,
  postPaymentReceivedJournalEntry,
  postPaymentReversalJournalEntry,
};
