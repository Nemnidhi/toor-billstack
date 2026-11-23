const mongoose = require("mongoose");
const Account = require("../models/Account");
const JournalEntry = require("../models/JournalEntry");
const Business = require("../models/Business");
const AppError = require("../utils/appError");
const { SYSTEM_ACCOUNTS } = require("../constants/accounting");
const { expenseAccountCodeFor } = require("../constants/expenses");
const { fromMinorUnits, toMinorUnits } = require("../utils/money");

// Paise from a stored rupee amount. Unlike toMinorUnits this never throws on a
// third decimal (old purchase lines can carry one); it rounds to the paisa.
const paise = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100);
const centreOf = (value) => String(value || "").trim();
/**
 * The tags a journal line carries: centre (property), business line and report category.
 * Takes a document (invoice, expense, purchase...), a tags object, or a plain centre name.
 */
const tagsOf = (source = "") =>
  typeof source === "string"
    ? { centre: centreOf(source), businessLine: "", reportCategory: "" }
    : { centre: centreOf(source?.centre), businessLine: centreOf(source?.businessLine), reportCategory: centreOf(source?.reportCategory) };
const postingLine = (account, debitMinor, creditMinor, description, tags = "") => ({
  accountId: account._id,
  accountCode: account.code,
  accountName: account.name,
  debitMinor,
  creditMinor,
  description,
  ...tagsOf(tags),
});
// Goldhawk is kept out of GST while it has no GSTIN. Once it registers (GST on in its settings
// with a GSTIN) its bills post GST like TOOR's.
const gstRegistered = (b) => Boolean(b?.gstConfiguration?.enabled && (b.gstConfiguration.gstin || b.gstTaxId));
const isGoldhawkBusiness = async ({ business, businessId, session }) => {
  let b = business;
  if (!b || b.gstConfiguration === undefined) {
    const id = business?._id || businessId;
    b = id ? await Business.findById(id).select("billingEntityCode gstConfiguration gstTaxId").session(session || null).lean() : business;
  }
  return b?.billingEntityCode === "GOLDHAWK" && !gstRegistered(b);
};
// For an invoice: Goldhawk without GST at the time it was issued (its seller snapshot), or now.
const isNoGstGoldhawkInvoice = async ({ invoice, business, session }) => {
  const snap = invoice?.sellerSnapshot;
  if (snap?.billingEntityCode === "GOLDHAWK") return !(snap.gstConfiguration?.enabled && snap.gstTaxId);
  return isGoldhawkBusiness({ business, businessId: invoice?.businessId, session });
};

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

// The Indian calendar day of a date, YYYY-MM-DD.
const istDay = (value) => new Date(new Date(value).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);

/** Refuse a posting dated in a closed period (Business.booksLock.lockedUpTo, inclusive). */
const assertPeriodOpen = async ({ businessId, entryDate, session }) => {
  const business = await Business.findById(businessId).select("booksLock").session(session || null).lean();
  const lockedUpTo = business?.booksLock?.lockedUpTo || "";
  if (lockedUpTo && istDay(entryDate || new Date()) <= lockedUpTo) {
    const [y, m, d] = lockedUpTo.split("-");
    throw new AppError(`The books are closed up to ${d}-${m}-${y}. This change would post on ${istDay(entryDate).split("-").reverse().join("-")}. Ask the owner to reopen the period first.`, 409);
  }
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
      ...tagsOf(line),
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

  await assertPeriodOpen({ businessId, entryDate, session });

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
const buildInvoicePostingLines = async ({ invoice, business, session }) => {
  // Issuing a zero-value invoice does not create a debit, revenue or tax posting.
  // Do not relax postJournalEntry's non-zero and balanced-entry requirements.
  if (invoice.grandTotal === 0 && (invoice.totalTax ?? 0) === 0) return [];
  const accounts = await ensureDefaultAccounts({ businessId: invoice.businessId, session });

  const isGoldhawk = await isNoGstGoldhawkInvoice({ invoice, business, session });

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

  const tags = tagsOf(invoice);
  return lines.map((line) => ({ ...line, ...tags }));
};

const postInvoiceJournalEntry = async ({ invoice, business, userId, session, sourceKey, description }) => {
  const lines = await buildInvoicePostingLines({ invoice, business, session });
  if (!lines.length) return null;
  return postJournalEntry({
    businessId: invoice.businessId,
    userId,
    entryDate: invoice.invoiceDate || new Date(),
    sourceType: "INVOICE",
    sourceId: invoice._id,
    sourceKey: sourceKey || `INVOICE:${invoice._id}:ISSUED`,
    description: description || `Issue Invoice ${invoice.invoiceNumber}`,
    lines,
    session,
  });
};

// Record ids are 24-character hex ObjectIds; anything else is refused rather than
// put into a pattern.
const escapeKey = (value) => {
  const text = String(value);
  if (!/^[a-f0-9]{24}$/i.test(text)) throw new AppError("Invalid record id", 400);
  return text;
};

const netLineKey = (line) => {
  const tags = tagsOf(line);
  return `${String(line.accountId)}|${tags.centre}|${tags.businessLine}|${tags.reportCategory}`;
};

/**
 * What the books currently hold for one source record: every journal entry whose
 * key starts <TYPE>:<id>: (the first posting, any edits, a cancellation), netted
 * per account and centre.
 * Returns { lines: [{accountId, accountCode, accountName, centre, netMinor}], first, count }.
 */
const netPostingsFor = async ({ businessId, keyType, recordId, session }) => {
  const entries = await JournalEntry.find({
    businessId,
    sourceKey: { $regex: `^${keyType}:${escapeKey(recordId)}:` },
  })
    .sort({ entryDate: 1, createdAt: 1 })
    .session(session || null);
  const byAccount = new Map();
  for (const entry of entries) {
    for (const line of entry.lines || []) {
      const key = netLineKey(line);
      const row = byAccount.get(key) || { accountId: line.accountId, accountCode: line.accountCode, accountName: line.accountName, ...tagsOf(line), netMinor: 0 };
      row.netMinor += Number(line.debitMinor || 0) - Number(line.creditMinor || 0);
      byAccount.set(key, row);
    }
  }
  return { lines: [...byAccount.values()].filter((row) => row.netMinor !== 0), first: entries[0] || null, count: entries.length };
};

const netInvoicePostings = ({ invoice, session }) =>
  netPostingsFor({ businessId: invoice.businessId, keyType: "INVOICE", recordId: invoice._id, session });

const reversalLinesFor = (netLines, label) =>
  netLines.map((row) => ({
    accountId: row.accountId,
    accountCode: row.accountCode,
    accountName: row.accountName,
    debitMinor: row.netMinor < 0 ? -row.netMinor : 0,
    creditMinor: row.netMinor > 0 ? row.netMinor : 0,
    description: `${label}: ${row.accountName || row.accountCode || "account"}`,
    ...tagsOf(row),
  }));

const sameNetLines = (netLines, postingLines) => {
  const want = new Map();
  for (const line of postingLines) {
    const key = netLineKey(line);
    want.set(key, (want.get(key) || 0) + Number(line.debitMinor || 0) - Number(line.creditMinor || 0));
  }
  for (const [key, value] of [...want.entries()]) if (value === 0) want.delete(key);
  if (want.size !== netLines.length) return false;
  return netLines.every((row) => want.get(netLineKey(row)) === row.netMinor);
};

/**
 * Bring the books for one record in line with what the record says now: reverse
 * whatever is posted under <TYPE>:<id>: (dated on the old date) and post the new
 * lines (dated on the new date). Posts under issueKey when nothing was posted yet.
 * No-op when nothing changed.
 */
const resyncRecordPostings = async ({ businessId, keyType, recordId, newLines, previousDate, newDate, editKey, issueKey, sourceType, label, userId, session }) => {
  const current = await netPostingsFor({ businessId, keyType, recordId, session });
  if (!current.count) {
    if (!newLines.length) return null;
    return postJournalEntry({ businessId, userId, entryDate: newDate || new Date(), sourceType, sourceId: recordId, sourceKey: issueKey, description: label, lines: newLines, session });
  }
  const dateUnchanged = new Date(previousDate || 0).getTime() === new Date(newDate || 0).getTime();
  if (dateUnchanged && sameNetLines(current.lines, newLines)) return null;
  if (current.lines.length) {
    await postJournalEntry({
      businessId,
      userId,
      entryDate: previousDate || newDate || new Date(),
      sourceType: "REVERSAL",
      sourceId: recordId,
      sourceKey: `${keyType}:${recordId}:EDIT:${editKey}:REVERSE`,
      description: `${label}: reverse earlier posting`,
      lines: reversalLinesFor(current.lines, "Edit reversal"),
      reversalOfEntryId: current.first?._id || null,
      session,
    });
  }
  if (!newLines.length) return null;
  return postJournalEntry({
    businessId,
    userId,
    entryDate: newDate || new Date(),
    sourceType,
    sourceId: recordId,
    sourceKey: `${keyType}:${recordId}:EDIT:${editKey}:POSTED`,
    description: `${label}: posting as edited`,
    lines: newLines,
    session,
  });
};

/** Reverse everything posted for one record (cancellation). */
const reverseRecordPostings = async ({ businessId, keyType, recordId, cancelKey, label, userId, entryDate, session }) => {
  const current = await netPostingsFor({ businessId, keyType, recordId, session });
  if (!current.lines.length) return null;
  return postJournalEntry({
    businessId,
    userId,
    entryDate: entryDate || new Date(),
    sourceType: "REVERSAL",
    sourceId: recordId,
    sourceKey: cancelKey,
    description: `${label}${current.first?.entryNumber ? ` (reversal of ${current.first.entryNumber})` : ""}`,
    lines: reversalLinesFor(current.lines, "Cancellation reversal"),
    reversalOfEntryId: current.first?._id || null,
    session,
  });
};

/**
 * An issued invoice with no payments was edited. Bring the books in line with the
 * invoice as it is now: reverse whatever is posted for it (dated on its old invoice
 * date) and post the edited invoice (dated on its new date). If nothing was ever
 * posted, post it now under the normal issue key. No-op when nothing changed.
 */
const repostEditedInvoiceJournalEntry = async ({ invoice, business, previousInvoiceDate, editKey, userId, session }) => {
  const current = await netInvoicePostings({ invoice, session });
  const newLines = await buildInvoicePostingLines({ invoice, business, session });
  if (!current.count) {
    return newLines.length ? postInvoiceJournalEntry({ invoice, business, userId, session }) : null;
  }
  const dateUnchanged = new Date(previousInvoiceDate || 0).getTime() === new Date(invoice.invoiceDate || 0).getTime();
  if (dateUnchanged && sameNetLines(current.lines, newLines)) return null;

  if (current.lines.length) {
    await postJournalEntry({
      businessId: invoice.businessId,
      userId,
      entryDate: previousInvoiceDate || invoice.invoiceDate || new Date(),
      sourceType: "REVERSAL",
      sourceId: invoice._id,
      sourceKey: `INVOICE:${invoice._id}:EDIT:${editKey}:REVERSE`,
      description: `Edit Invoice ${invoice.invoiceNumber}: reverse earlier posting`,
      lines: reversalLinesFor(current.lines, "Edit reversal"),
      reversalOfEntryId: current.first?._id || null,
      session,
    });
  }
  if (!newLines.length) return null;
  return postJournalEntry({
    businessId: invoice.businessId,
    userId,
    entryDate: invoice.invoiceDate || new Date(),
    sourceType: "INVOICE",
    sourceId: invoice._id,
    sourceKey: `INVOICE:${invoice._id}:EDIT:${editKey}:POSTED`,
    description: `Edit Invoice ${invoice.invoiceNumber}: posting as edited`,
    lines: newLines,
    session,
  });
};

/**
 * Automatically post reversing Journal Entry when an invoice is cancelled.
 */
const postInvoiceCancellationJournalEntry = async ({ invoice, userId, session }) => {
  // Reverse the net of everything posted for this invoice (the issue plus any
  // edits), so an edited invoice is cancelled at the amount the books hold.
  const current = await netInvoicePostings({ invoice, session });
  if (!current.lines.length) return null;

  return postJournalEntry({
    businessId: invoice.businessId,
    userId,
    entryDate: new Date(),
    sourceType: "REVERSAL",
    sourceId: invoice._id,
    sourceKey: `INVOICE:${invoice._id}:CANCEL`,
    description: `Cancel Invoice ${invoice.invoiceNumber}${current.first?.entryNumber ? ` (reversal of ${current.first.entryNumber})` : ""}`,
    lines: reversalLinesFor(current.lines, "Cancellation reversal"),
    reversalOfEntryId: current.first?._id || null,
    session,
  });
};

/**
 * Automatically post Journal Entry when a payment is received.
 * Direction: RECEIVED
 * Dr Cash/Bank
 * Cr Customer Advances
 */
// Where a receipt's money is: cash, the bank, or (a set-off) the customer's own deposit with us.
const receiptAccountCode = (method) => {
  const m = String(method || "").toUpperCase();
  return m === "CASH" ? "1010" : m === "DEPOSIT_SET_OFF" ? "2410" : "1020";
};

const postPaymentReceivedJournalEntry = async ({ payment, userId, session }) => {
  if (payment.direction !== "RECEIVED") return null;

  const accounts = await ensureDefaultAccounts({ businessId: payment.businessId, session });
  const bankAcc = accounts.get(receiptAccountCode(payment.paymentMethod));
  const advAcc = accounts.get("2100"); // Customer Advances

  const amountMinor = toMinorUnits(payment.amount);
  const tdsMinor = paise(payment.tdsAmount);

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
      creditMinor: amountMinor + tdsMinor,
      description: `Customer advance ${payment.referenceNumber || payment._id}`,
    },
  ];
  // TDS the customer deducted: we get it back from the tax department, not the customer.
  if (tdsMinor > 0) lines.splice(1, 0, postingLine(accounts.get("1410"), tdsMinor, 0, `TDS deducted by customer ${payment.referenceNumber || payment._id}`));

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
    entryDate: allocation.createdAt || new Date(),
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
    entryDate: reversal.createdAt || new Date(),
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
  const bankAcc = accounts.get(originalPayment?.direction === "PAID"
    ? (String(originalPayment?.paymentMethod || "").toUpperCase() === "CASH" ? "1010" : "1020")
    : receiptAccountCode(originalPayment?.paymentMethod));
  const advAcc = accounts.get("2100");

  const amountMinor = toMinorUnits(reversalPayment.amount);

  if (originalPayment?.direction === "PAID") {
    // A supplier / landlord payment undone: the money comes back to the bank.
    const supAdvAcc = accounts.get("1150");
    return postJournalEntry({
      businessId: reversalPayment.businessId,
      userId,
      entryDate: reversalPayment.paymentDate || new Date(),
      sourceType: "REVERSAL",
      sourceId: reversalPayment._id,
      sourceKey: `PAYMENT_REVERSAL:${reversalPayment._id}`,
      description: `Supplier payment reversed / refunded: ${originalPayment.referenceNumber || originalPayment._id}`,
      lines: [
        postingLine(bankAcc, amountMinor, 0, `Refund of supplier payment ${originalPayment._id}`),
        postingLine(supAdvAcc, 0, amountMinor, `Reversal of supplier advance ${originalPayment._id}`),
      ],
      session,
    });
  }

  const tdsMinor = paise(originalPayment?.tdsAmount);
  const lines = [
    {
      accountId: advAcc._id,
      accountCode: advAcc.code,
      accountName: advAcc.name,
      debitMinor: amountMinor + tdsMinor,
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
  if (tdsMinor > 0) lines.push(postingLine(accounts.get("1410"), 0, tdsMinor, `TDS on reversed payment ${originalPayment?._id}`));

  return postJournalEntry({
    businessId: reversalPayment.businessId,
    userId,
    entryDate: reversalPayment.paymentDate || new Date(),
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
const buildExpensePostingLines = async ({ expense, business, session }) => {
  if (expense.status === "CANCELLED") return [];
  const accounts = await ensureDefaultAccounts({ businessId: expense.businessId, session });

  const isGoldhawk = await isGoldhawkBusiness({ business, businessId: expense.businessId, session });

  const expAcc = accounts.get(expenseAccountCodeFor(expense.category)) || accounts.get("5010");
  const method = String(expense.paymentMethod || "").toUpperCase();
  const isCash = method === "CASH";
  // Paid by credit card: owed to the card (2060) until the card bill is paid from the bank.
  const bankAcc = accounts.get(isCash ? "1010" : method === "CREDIT_CARD" ? "2060" : "1020");
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

  // Reverse charge: no GST on the bill; we owe it (2240-2260) and take the same as input credit.
  const rcm = { cgst: 0, sgst: 0, igst: 0 };
  if (!isGoldhawk && expense.gstType === "REVERSE_CHARGE") {
    const snap = expense.gstSnapshot || {};
    rcm.cgst = paise(snap.cgst);
    rcm.sgst = paise(snap.sgst) + paise(snap.utgst);
    rcm.igst = paise(snap.igst);
    cgstMinor += rcm.cgst;
    sgstMinor += rcm.sgst;
    igstMinor += rcm.igst;
  }

  // Blocked credit (s.17(5)): the GST is part of the cost, not an input credit.
  let blockedMinor = 0;
  if (expense.itcEligible === false) {
    blockedMinor = cgstMinor + sgstMinor + igstMinor;
    cgstMinor = 0;
    sgstMinor = 0;
    igstMinor = 0;
  }

  const lines = [
    {
      accountId: expAcc._id,
      accountCode: expAcc.code,
      accountName: expAcc.name,
      debitMinor: amountBeforeTaxMinor + blockedMinor,
      creditMinor: 0,
      description: `Expense ${expense.expenseNumber}: ${expense.description || expense.category}${blockedMinor ? " (GST not claimable)" : ""}`,
    },
  ];
  if (rcm.cgst) lines.push(postingLine(accounts.get("2240"), 0, rcm.cgst, `Expense ${expense.expenseNumber} CGST payable under reverse charge`));
  if (rcm.sgst) lines.push(postingLine(accounts.get("2250"), 0, rcm.sgst, `Expense ${expense.expenseNumber} SGST payable under reverse charge`));
  if (rcm.igst) lines.push(postingLine(accounts.get("2260"), 0, rcm.igst, `Expense ${expense.expenseNumber} IGST payable under reverse charge`));

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

  // TDS kept back from the supplier is owed to the government, not the supplier.
  const tdsMinor = Math.min(paise(expense.tdsAmount), totalAmountMinor);
  if (tdsMinor > 0) lines.push(postingLine(accounts.get("2310"), 0, tdsMinor, `TDS deducted on expense ${expense.expenseNumber}`));

  // Credit side: Bank/Cash if PAID, AP if UNPAID, or split if PARTIAL (of the bill less TDS)
  const payableMinor = totalAmountMinor - tdsMinor;
  const paidMinor = toMinorUnits(expense.paidAmount || 0, "Paid Amount", { allowZero: true });
  const unpaidMinor = payableMinor - paidMinor;

  if (expense.paymentStatus === "PAID" || (paidMinor > 0 && unpaidMinor === 0)) {
    lines.push({
      accountId: bankAcc._id,
      accountCode: bankAcc.code,
      accountName: bankAcc.name,
      debitMinor: 0,
      creditMinor: payableMinor,
      description: `Disbursement for expense ${expense.expenseNumber}`,
    });
  } else if (expense.paymentStatus === "UNPAID" || paidMinor === 0) {
    lines.push({
      accountId: apAcc._id,
      accountCode: apAcc.code,
      accountName: apAcc.name,
      debitMinor: 0,
      creditMinor: payableMinor,
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

  const tags = tagsOf(expense);
  const kept = lines.filter((line) => line.debitMinor > 0 || line.creditMinor > 0).map((line) => ({ ...line, ...tags }));
  return kept.length >= 2 ? kept : [];
};

const postExpenseJournalEntry = async ({ expense, business, userId, session }) => {
  const lines = await buildExpensePostingLines({ expense, business, session });
  if (!lines.length) return null;
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

/** An expense was edited (amount, tax, category, centre, paid status or date): move the books with it. */
const repostEditedExpenseJournalEntry = async ({ expense, business, previousExpenseDate, editKey, userId, session }) =>
  resyncRecordPostings({
    businessId: expense.businessId,
    keyType: "EXPENSE",
    recordId: expense._id,
    newLines: await buildExpensePostingLines({ expense, business, session }),
    previousDate: previousExpenseDate,
    newDate: expense.expenseDate,
    editKey,
    issueKey: `EXPENSE:${expense._id}:RECORDED`,
    sourceType: "EXPENSE",
    label: `Edit Expense ${expense.expenseNumber}`,
    userId,
    session,
  });

const postExpenseCancellationJournalEntry = async ({ expense, userId, session }) =>
  reverseRecordPostings({
    businessId: expense.businessId,
    keyType: "EXPENSE",
    recordId: expense._id,
    cancelKey: `EXPENSE:${expense._id}:CANCEL`,
    label: `Cancel Expense ${expense.expenseNumber}`,
    userId,
    entryDate: expense.cancelledAt || new Date(),
    session,
  });

/**
 * Purchase bill from a supplier.
 * Dr Purchases (cost) + Input GST (when the business is GST-registered), Cr Accounts Payable.
 * Only the tax that is inside the bill total is taken as input credit.
 */
const buildPurchasePostingLines = async ({ purchase, business, session }) => {
  const totalMinor = paise(purchase.totalAmount);
  if (totalMinor <= 0) return [];
  const accounts = await ensureDefaultAccounts({ businessId: purchase.businessId, session });
  const isGoldhawk = await isGoldhawkBusiness({ business, businessId: purchase.businessId, session });
  const centre = tagsOf(purchase);
  const label = `Purchase ${purchase.purchaseNumber || purchase._id}`;

  let cgstMinor = 0;
  let sgstMinor = 0;
  let igstMinor = 0;
  const breakup = purchase.gstBreakup || {};
  const registered = Boolean(purchase.gstSnapshot) && breakup.inputTaxCreditEligible !== false;
  if (!isGoldhawk && registered) {
    const billTaxMinor = (purchase.productsPurchased || []).reduce((sum, item) => sum + paise(item.tax), 0);
    const snapIgst = paise(breakup.igst);
    const snapLocal = paise(breakup.cgst) + paise(breakup.sgst) + paise(breakup.utgst);
    const taxMinor = Math.min(Math.max(billTaxMinor, 0), totalMinor);
    if (taxMinor > 0) {
      if (snapIgst > 0 && snapLocal === 0) igstMinor = taxMinor;
      else {
        cgstMinor = Math.floor(taxMinor / 2);
        sgstMinor = taxMinor - cgstMinor;
      }
    }
  }
  const costMinor = totalMinor - cgstMinor - sgstMinor - igstMinor;
  const lines = [];
  if (costMinor > 0) lines.push(postingLine(accounts.get("5100"), costMinor, 0, `${label} cost`, centre));
  if (cgstMinor > 0) lines.push(postingLine(accounts.get("1310"), cgstMinor, 0, `${label} CGST input tax credit`, centre));
  if (sgstMinor > 0) lines.push(postingLine(accounts.get("1320"), sgstMinor, 0, `${label} SGST input tax credit`, centre));
  if (igstMinor > 0) lines.push(postingLine(accounts.get("1330"), igstMinor, 0, `${label} IGST input tax credit`, centre));
  lines.push(postingLine(accounts.get("2010"), 0, totalMinor, `${label} payable`, centre));
  return lines;
};

const postPurchaseJournalEntry = async ({ purchase, business, userId, session }) => {
  const lines = await buildPurchasePostingLines({ purchase, business, session });
  if (!lines.length) return null;
  return postJournalEntry({
    businessId: purchase.businessId,
    userId,
    entryDate: purchase.purchaseDate || new Date(),
    sourceType: "PURCHASE",
    sourceId: purchase._id,
    sourceKey: `PURCHASE:${purchase._id}:RECORDED`,
    description: `Purchase bill ${purchase.purchaseNumber || purchase._id}`,
    lines,
    session,
  });
};

/**
 * Money paid to a supplier / landlord. Until it is set against a bill it sits as an advance.
 * Dr Advances to Suppliers, Cr Bank / Cash.
 */
const postPaymentPaidJournalEntry = async ({ payment, userId, session }) => {
  if (payment.direction !== "PAID" || !payment.supplierId || payment.reversalOfPaymentId) return null;
  const accounts = await ensureDefaultAccounts({ businessId: payment.businessId, session });
  const isCash = String(payment.paymentMethod || "").toUpperCase() === "CASH";
  const amountMinor = toMinorUnits(payment.amount);
  const ref = payment.referenceNumber || payment._id;
  return postJournalEntry({
    businessId: payment.businessId,
    userId,
    entryDate: payment.paymentDate || new Date(),
    sourceType: "PAYMENT",
    sourceId: payment._id,
    sourceKey: `PAYMENT:${payment._id}:PAID`,
    description: `Payment made: ${ref}`,
    lines: [
      postingLine(accounts.get("1150"), amountMinor, 0, `Advance to supplier ${ref}`),
      postingLine(accounts.get(isCash ? "1010" : "1020"), 0, amountMinor, `Payment made ${ref}`),
    ],
    session,
  });
};

/** A supplier payment set against a purchase bill. Dr Accounts Payable, Cr Advances to Suppliers. */
const postPurchaseAllocationJournalEntry = async ({ allocation, userId, session }) => {
  if (!allocation.purchaseId) return null;
  const accounts = await ensureDefaultAccounts({ businessId: allocation.businessId, session });
  const amountMinor = toMinorUnits(allocation.allocatedAmount);
  return postJournalEntry({
    businessId: allocation.businessId,
    userId,
    entryDate: allocation.createdAt || new Date(),
    sourceType: "PAYMENT_ALLOCATION",
    sourceId: allocation._id,
    sourceKey: `ALLOCATION:${allocation._id}:POSTED`,
    description: `Payment ${allocation.paymentId} set against purchase ${allocation.purchaseId}`,
    lines: [
      postingLine(accounts.get("2010"), amountMinor, 0, `Settlement of purchase ${allocation.purchaseId}`),
      postingLine(accounts.get("1150"), 0, amountMinor, `Supplier advance used for purchase ${allocation.purchaseId}`),
    ],
    session,
  });
};

const postPurchaseAllocationReversalJournalEntry = async ({ reversal, allocation, userId, session }) => {
  const accounts = await ensureDefaultAccounts({ businessId: reversal.businessId, session });
  const amountMinor = toMinorUnits(reversal.amount);
  return postJournalEntry({
    businessId: reversal.businessId,
    userId,
    entryDate: reversal.createdAt || new Date(),
    sourceType: "REVERSAL",
    sourceId: reversal._id,
    sourceKey: `ALLOCATION_REVERSAL:${reversal._id}`,
    description: `Reversal of purchase payment allocation ${allocation._id}`,
    lines: [
      postingLine(accounts.get("1150"), amountMinor, 0, `Reversal of allocation ${allocation._id} - restore supplier advance`),
      postingLine(accounts.get("2010"), 0, amountMinor, `Reversal of allocation ${allocation._id} - reinstate payable`),
    ],
    session,
  });
};

/**
 * Credit note or sales return against an invoice.
 * Dr Sales Returns & Credit Notes (the part before tax) + Output GST (the tax inside it), Cr Accounts Receivable.
 * creditLines: [{ invoiceLineIndex, amount }] with amounts that include tax, as stored on the note.
 */
const buildSalesCreditLines = async ({ invoice, business, creditLines, label, session }) => {
  const accounts = await ensureDefaultAccounts({ businessId: invoice.businessId, session });
  const isGoldhawk = await isNoGstGoldhawkInvoice({ invoice, business, session });
  const centre = tagsOf(invoice);

  let totalMinor = 0;
  let taxMinor = 0;
  for (const credit of creditLines) {
    const amountMinor = paise(credit.amount);
    totalMinor += amountMinor;
    const sold = (invoice.lineItems || [])[Number(credit.invoiceLineIndex)];
    if (!sold || isGoldhawk) continue;
    const soldTotal = Number(sold.itemTotal || 0);
    const soldTax = Number(sold.taxAmount ?? sold.tax ?? (soldTotal - Number(sold.taxableAmount || soldTotal)));
    if (soldTotal > 0 && soldTax > 0) taxMinor += Math.round((amountMinor * soldTax) / soldTotal);
  }
  if (totalMinor <= 0) return [];
  taxMinor = Math.min(taxMinor, totalMinor);

  let cgstMinor = 0;
  let sgstMinor = 0;
  let igstMinor = 0;
  if (taxMinor > 0) {
    const breakup = invoice.gstBreakup || invoice.gstSnapshot || {};
    const local = paise(breakup.cgst) + paise(breakup.sgst) + paise(breakup.utgst);
    if (paise(breakup.igst) > 0 && local === 0) igstMinor = taxMinor;
    else {
      cgstMinor = Math.floor(taxMinor / 2);
      sgstMinor = taxMinor - cgstMinor;
    }
  }
  const netMinor = totalMinor - taxMinor;
  const lines = [];
  if (netMinor > 0) lines.push(postingLine(accounts.get("4090"), netMinor, 0, `${label} (before tax)`, centre));
  if (cgstMinor > 0) lines.push(postingLine(accounts.get("2210"), cgstMinor, 0, `${label} CGST output reduced`, centre));
  if (sgstMinor > 0) lines.push(postingLine(accounts.get("2220"), sgstMinor, 0, `${label} SGST output reduced`, centre));
  if (igstMinor > 0) lines.push(postingLine(accounts.get("2230"), igstMinor, 0, `${label} IGST output reduced`, centre));
  lines.push(postingLine(accounts.get("1100"), 0, totalMinor, `${label} credited to customer`, centre));
  return lines;
};

const postCreditNoteJournalEntry = async ({ note, invoice, business, userId, session }) => {
  if (note.status === "CANCELLED") return null;
  const label = `Credit note ${note.creditNoteNumber} on invoice ${invoice.invoiceNumber}`;
  const lines = await buildSalesCreditLines({ invoice, business, creditLines: note.lineItems || [], label, session });
  if (!lines.length) return null;
  return postJournalEntry({
    businessId: note.businessId,
    userId,
    entryDate: note.createdAt || new Date(),
    sourceType: "CREDIT_NOTE",
    sourceId: note._id,
    sourceKey: `CREDIT_NOTE:${note._id}:ISSUED`,
    description: label,
    lines,
    session,
  });
};

// Sales return lines carry quantities; their value is the invoice line value for that quantity
// (the same figure the customer ledger was credited with).
const salesReturnCreditLines = ({ ret, invoice }) =>
  (ret.lineItems || []).map((line) => {
    const sold = (invoice.lineItems || [])[Number(line.invoiceLineIndex)] || {};
    const soldQty = Number(sold.quantity || 0);
    const amount = soldQty > 0 ? Math.round((paise(sold.itemTotal) * Number(line.quantity || 0)) / soldQty) / 100 : 0;
    return { invoiceLineIndex: line.invoiceLineIndex, amount };
  });

// Keep the journal equal to the customer ledger credit; put any rounding gap on the first line.
const balancedReturnCreditLines = ({ ret, invoice }) => {
  const creditLines = salesReturnCreditLines({ ret, invoice });
  const sumMinor = creditLines.reduce((sum, line) => sum + paise(line.amount), 0);
  const recordedMinor = paise(ret.totalAmount);
  if (creditLines.length && sumMinor !== recordedMinor) creditLines[0].amount = (paise(creditLines[0].amount) + recordedMinor - sumMinor) / 100;
  return creditLines;
};

const postSalesReturnJournalEntry = async ({ ret, invoice, business, userId, session }) => {
  if (ret.status === "CANCELLED") return null;
  const label = `Sales return ${ret.returnNumber} on invoice ${invoice.invoiceNumber}`;
  const creditLines = balancedReturnCreditLines({ ret, invoice });
  const lines = await buildSalesCreditLines({ invoice, business, creditLines, label, session });
  if (!lines.length) return null;
  return postJournalEntry({
    businessId: ret.businessId,
    userId,
    entryDate: ret.createdAt || new Date(),
    sourceType: "SALES_RETURN",
    sourceId: ret._id,
    sourceKey: `SALES_RETURN:${ret._id}:ISSUED`,
    description: label,
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

/**
 * An invoice was edited or moved to another centre: its credit notes and sales
 * returns follow it (centre, and the tax share if the lines changed).
 */
const resyncInvoiceCredits = async ({ invoice, business, editKey, userId, session }) => {
  const CreditNote = require("../models/CreditNote");
  const SalesReturn = require("../models/SalesReturn");
  const [notes, returns] = await Promise.all([
    CreditNote.find({ businessId: invoice.businessId, invoiceId: invoice._id, status: "ISSUED" }).session(session || null),
    SalesReturn.find({ businessId: invoice.businessId, invoiceId: invoice._id, status: "ISSUED" }).session(session || null),
  ]);
  for (const note of notes) {
    const label = `Credit note ${note.creditNoteNumber} on invoice ${invoice.invoiceNumber}`;
    await resyncRecordPostings({
      businessId: invoice.businessId,
      keyType: "CREDIT_NOTE",
      recordId: note._id,
      newLines: await buildSalesCreditLines({ invoice, business, creditLines: note.lineItems || [], label, session }),
      previousDate: note.createdAt,
      newDate: note.createdAt,
      editKey,
      issueKey: `CREDIT_NOTE:${note._id}:ISSUED`,
      sourceType: "CREDIT_NOTE",
      label,
      userId,
      session,
    });
  }
  for (const ret of returns) {
    const label = `Sales return ${ret.returnNumber} on invoice ${invoice.invoiceNumber}`;
    await resyncRecordPostings({
      businessId: invoice.businessId,
      keyType: "SALES_RETURN",
      recordId: ret._id,
      newLines: await buildSalesCreditLines({ invoice, business, creditLines: balancedReturnCreditLines({ ret, invoice }), label, session }),
      previousDate: ret.createdAt,
      newDate: ret.createdAt,
      editKey,
      issueKey: `SALES_RETURN:${ret._id}:ISSUED`,
      sourceType: "SALES_RETURN",
      label,
      userId,
      session,
    });
  }
};

module.exports = {
  paise,
  postingLine,
  tagsOf,
  assertPeriodOpen,
  isGoldhawkBusiness,
  isNoGstGoldhawkInvoice,
  istDay,
  resyncInvoiceCredits,
  buildExpensePostingLines,
  buildInvoicePostingLines,
  buildPurchasePostingLines,
  buildSalesCreditLines,
  netInvoicePostings,
  netPostingsFor,
  postCreditNoteJournalEntry,
  postExpenseCancellationJournalEntry,
  postPaymentPaidJournalEntry,
  postPurchaseAllocationJournalEntry,
  postPurchaseAllocationReversalJournalEntry,
  postPurchaseJournalEntry,
  postSalesReturnJournalEntry,
  repostEditedExpenseJournalEntry,
  resyncRecordPostings,
  reverseRecordPostings,
  repostEditedInvoiceJournalEntry,
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
