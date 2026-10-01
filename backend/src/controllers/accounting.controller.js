const Account = require("../models/Account");
const JournalEntry = require("../models/JournalEntry");
const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const accountingService = require("../services/accounting.service");

const getAccounts = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  await accountingService.ensureDefaultAccounts({ businessId });

  const query = { businessId };
  if (req.query.type) query.type = String(req.query.type).toUpperCase();
  if (req.query.active !== undefined) query.isActive = req.query.active === "true";

  const accounts = await Account.find(query).sort("code");
  res.status(200).json({
    message: "Chart of Accounts fetched successfully",
    data: accounts,
  });
});

const getTrialBalance = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  const { from, to } = req.query;

  const trialBalance = await accountingService.getTrialBalance({
    businessId,
    from,
    to,
  });

  res.status(200).json({
    message: "Trial Balance fetched successfully",
    data: trialBalance,
  });
});

const getAccountLedger = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  const accountId = req.params.accountId || req.query.accountId;

  if (!accountId) {
    throw new AppError("Account ID is required", 400);
  }

  const { from, to } = req.query;
  const ledger = await accountingService.getAccountLedger({
    businessId,
    accountId,
    from,
    to,
  });

  res.status(200).json({
    message: "Account ledger fetched successfully",
    data: ledger,
  });
});

const getJournalEntries = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const skip = (page - 1) * limit;

  const query = { businessId };
  if (req.query.sourceType) query.sourceType = req.query.sourceType;
  if (req.query.status) query.status = req.query.status;

  if (req.query.from || req.query.to) {
    query.entryDate = {};
    if (req.query.from) query.entryDate.$gte = new Date(req.query.from);
    if (req.query.to) {
      const to = new Date(req.query.to);
      to.setHours(23, 59, 59, 999);
      query.entryDate.$lte = to;
    }
  }

  const [total, entries] = await Promise.all([
    JournalEntry.countDocuments(query),
    JournalEntry.find(query).sort("-entryDate -createdAt").skip(skip).limit(limit).populate("createdBy", "name email"),
  ]);

  res.status(200).json({
    message: "Journal entries fetched successfully",
    data: entries,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
});

const postManualJournalEntry = asyncHandler(async (req, res) => {
  const businessId = req.tenant.businessId;
  const { entryDate, description, lines } = req.body;

  if (!description || !description.trim()) {
    throw new AppError("Description is required", 400);
  }

  const sourceKey = `MANUAL:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const entry = await accountingService.postJournalEntry({
    businessId,
    userId: req.user._id,
    entryDate: entryDate ? new Date(entryDate) : new Date(),
    sourceType: "MANUAL",
    sourceKey,
    description: description.trim(),
    lines,
  });

  res.status(201).json({
    message: "Manual journal entry posted successfully",
    data: entry,
  });
});

module.exports = {
  getAccountLedger,
  getAccounts,
  getJournalEntries,
  getTrialBalance,
  postManualJournalEntry,
};
