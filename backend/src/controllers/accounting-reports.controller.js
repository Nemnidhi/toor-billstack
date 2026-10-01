const asyncHandler = require("../utils/asyncHandler");
const AppError = require("../utils/appError");
const reportsService = require("../services/accounting-reports.service");

/**
 * Controller: Profit & Loss Account
 */
const getProfitAndLoss = asyncHandler(async (req, res) => {
  const { isConsolidated, businessId, homeBusinessId } = req.accountingScope;

  const data = isConsolidated
    ? await reportsService.getConsolidatedReport({
        reportType: "PROFIT_AND_LOSS",
        homeBusinessId,
        query: req.query,
      })
    : await reportsService.getProfitAndLossReport({
        businessId,
        query: req.query,
      });

  res.status(200).json({ success: true, data });
});

/**
 * Controller: Balance Sheet
 */
const getBalanceSheet = asyncHandler(async (req, res) => {
  const { isConsolidated, businessId, homeBusinessId } = req.accountingScope;

  const data = isConsolidated
    ? await reportsService.getConsolidatedReport({
        reportType: "BALANCE_SHEET",
        homeBusinessId,
        query: req.query,
      })
    : await reportsService.getBalanceSheetReport({
        businessId,
        query: req.query,
      });

  res.status(200).json({ success: true, data });
});

/**
 * Controller: Bank Book / Bank Ledger
 */
const getBankBook = asyncHandler(async (req, res) => {
  const { isConsolidated, businessId, homeBusinessId } = req.accountingScope;

  const data = isConsolidated
    ? await reportsService.getConsolidatedReport({
        reportType: "BANK_BOOK",
        homeBusinessId,
        query: req.query,
      })
    : await reportsService.getLedgerBookReport({
        businessId,
        bookType: "BANK",
        query: req.query,
      });

  res.status(200).json({ success: true, data });
});

/**
 * Controller: Cash Book / Cash Ledger
 */
const getCashBook = asyncHandler(async (req, res) => {
  const { isConsolidated, businessId, homeBusinessId } = req.accountingScope;

  const data = isConsolidated
    ? await reportsService.getConsolidatedReport({
        reportType: "CASH_BOOK",
        homeBusinessId,
        query: req.query,
      })
    : await reportsService.getLedgerBookReport({
        businessId,
        bookType: "CASH",
        query: req.query,
      });

  res.status(200).json({ success: true, data });
});

/**
 * Controller: Historical Data Audit / Warning
 */
const getHistoricalWarning = asyncHandler(async (req, res) => {
  const { isConsolidated, businessId, homeBusinessId } = req.accountingScope;

  if (isConsolidated) {
    const Business = require("../models/Business");
    const gh = await Business.findOne({ billingParentId: homeBusinessId, billingEntityCode: "GOLDHAWK" });
    const [toorW, ghW] = await Promise.all([
      reportsService.getHistoricalWarning({ businessId: homeBusinessId, fromDate: req.query.from, toDate: req.query.to }),
      gh ? reportsService.getHistoricalWarning({ businessId: gh._id, fromDate: req.query.from, toDate: req.query.to }) : { hasUnpostedLegacyData: false },
    ]);

    const hasUnposted = toorW.hasUnpostedLegacyData || ghW.hasUnpostedLegacyData;
    return res.status(200).json({
      success: true,
      data: {
        hasUnpostedLegacyData: hasUnposted,
        warning: hasUnposted ? "Historical accounting data incomplete / backfill required in one or more entities" : null,
        entities: { toor: toorW, goldhawk: ghW },
      },
    });
  }

  const data = await reportsService.getHistoricalWarning({
    businessId,
    fromDate: req.query.from,
    toDate: req.query.to,
  });

  res.status(200).json({ success: true, data });
});

/**
 * Controller: Accountant Export Pack
 * Supports:
 * - format=json: returns complete structured JSON pack containing all 10 reports and CSV data
 * - format=csv: downloads direct CSV for selected reportType or combined CSV
 */
const exportAccountantPack = asyncHandler(async (req, res) => {
  const { isConsolidated, businessId, homeBusinessId } = req.accountingScope;
  const { format = "json", reportType } = req.query;

  const pack = await reportsService.getAccountantExportPack({
    businessId,
    isConsolidated,
    homeBusinessId,
    query: req.query,
  });

    if (format === "xlsx") {
    const buffer = reportsService.buildAccountantExportXlsxBuffer(pack);
    const filename = `accountant-pack-${pack.metadata.period.periodLabel.toLowerCase().replace(/[^a-z0-9]/g, "-")}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
  }

  if (format === "csv") {
    let csvContent = "";
    let filename = `accountant-pack-${pack.metadata.period.periodLabel.toLowerCase().replace(/[^a-z0-9]/g, "-")}.csv`;

    if (reportType === "trial-balance") {
      csvContent = pack.files.trialBalanceCsv;
      filename = `trial-balance-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "profit-loss") {
      csvContent = pack.files.profitLossCsv;
      filename = `profit-and-loss-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "balance-sheet") {
      csvContent = pack.files.balanceSheetCsv;
      filename = `balance-sheet-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "bank-book") {
      csvContent = pack.files.bankBookCsv;
      filename = `bank-book-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "cash-book") {
      csvContent = pack.files.cashBookCsv;
      filename = `cash-book-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "sales-register") {
      csvContent = pack.files.salesRegisterCsv;
      filename = `sales-register-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "expense-register") {
      csvContent = pack.files.expenseRegisterCsv;
      filename = `expense-register-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "receivables") {
      csvContent = pack.files.receivablesCsv;
      filename = `customer-receivables-${pack.metadata.period.periodLabel}.csv`;
    } else if (reportType === "gst-summary") {
      csvContent = pack.files.gstSummaryCsv;
      filename = `gst-summary-${pack.metadata.period.periodLabel}.csv`;
    } else {
      csvContent = pack.files.combinedCsv;
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  }

  res.status(200).json({ success: true, data: pack });
});

module.exports = {
  getProfitAndLoss,
  getBalanceSheet,
  getBankBook,
  getCashBook,
  getHistoricalWarning,
  exportAccountantPack,
};
