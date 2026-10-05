const AppError = require("./appError");

/**
 * Get Indian Financial Year for a given Date.
 * Indian FY starts April 1 and ends March 31.
 */
const getIndianFinancialYear = (date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-indexed (1 to 12)

  // If Jan, Feb, Mar (months 1, 2, 3), FY started in previous calendar year
  const fyStartYear = month >= 4 ? year : year - 1;
  const fyEndYear = fyStartYear + 1;
  const shortEnd = String(fyEndYear).slice(-2);

  return {
    fyStartYear,
    fyEndYear,
    label: `FY ${fyStartYear}-${shortEnd}`,
  };
};

/**
 * Resolves date boundaries for Indian Financial Year, Quarters, Months, and Custom ranges.
 * All ranges are inclusive from 00:00:00.000 to 23:59:59.999 UTC.
 */
const resolveIndianPeriod = (query = {}) => {
  const now = new Date();
  const currentFy = getIndianFinancialYear(now);

  let fyStartYear = query.fyYear ? parseInt(query.fyYear, 10) : currentFy.fyStartYear;
  if (isNaN(fyStartYear) || fyStartYear < 2000 || fyStartYear > 2100) {
    fyStartYear = currentFy.fyStartYear;
  }
  const fyEndYear = fyStartYear + 1;
  const shortEnd = String(fyEndYear).slice(-2);
  const fyLabel = `FY ${fyStartYear}-${shortEnd}`;

  const periodRaw = (query.period || "").toUpperCase();

  // 1. Balance Sheet "asOf" or "date" support
  if (query.asOf || (query.date && !query.from) || (query.to && !query.from)) {
    const asOfStr = query.asOf || query.date || query.to;
    const toDate = new Date(`${asOfStr.slice(0, 10)}T23:59:59.999Z`);
    if (isNaN(toDate.getTime())) throw new AppError("Invalid asOf date format. Use YYYY-MM-DD", 400);
    return {
      fromDate: null,
      toDate,
      fromStr: null,
      toStr: asOfStr.slice(0, 10),
      period: "AS_OF",
      periodLabel: `As of ${asOfStr.slice(0, 10)}`,
      fyLabel,
    };
  }

  // 2. Custom date range
  if (query.from || query.to || periodRaw === "CUSTOM") {
    if (!query.from) throw new AppError("From date is required for custom range", 400);
    const fromStr = query.from.slice(0, 10);
    const toStr = (query.to ? query.to.slice(0, 10) : query.from.slice(0, 10));

    const fromDate = new Date(`${fromStr}T00:00:00.000Z`);
    const toDate = new Date(`${toStr}T23:59:59.999Z`);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      throw new AppError("Invalid date format in range. Use YYYY-MM-DD", 400);
    }
    if (fromDate > toDate) {
      throw new AppError("From date must be on or before To date", 400);
    }

    return {
      fromDate,
      toDate,
      fromStr,
      toStr,
      period: "CUSTOM",
      periodLabel: `${fromStr} to ${toStr}`,
      fyLabel,
    };
  }

  // 3. Indian FY Quarters
  if (periodRaw === "Q1") {
    const fromStr = `${fyStartYear}-04-01`;
    const toStr = `${fyStartYear}-06-30`;
    return {
      fromDate: new Date(`${fromStr}T00:00:00.000Z`),
      toDate: new Date(`${toStr}T23:59:59.999Z`),
      fromStr,
      toStr,
      period: "Q1",
      periodLabel: `Q1 (Apr - Jun ${fyStartYear})`,
      fyLabel,
    };
  }

  if (periodRaw === "Q2") {
    const fromStr = `${fyStartYear}-07-01`;
    const toStr = `${fyStartYear}-09-30`;
    return {
      fromDate: new Date(`${fromStr}T00:00:00.000Z`),
      toDate: new Date(`${toStr}T23:59:59.999Z`),
      fromStr,
      toStr,
      period: "Q2",
      periodLabel: `Q2 (Jul - Sep ${fyStartYear})`,
      fyLabel,
    };
  }

  if (periodRaw === "Q3") {
    const fromStr = `${fyStartYear}-10-01`;
    const toStr = `${fyStartYear}-12-31`;
    return {
      fromDate: new Date(`${fromStr}T00:00:00.000Z`),
      toDate: new Date(`${toStr}T23:59:59.999Z`),
      fromStr,
      toStr,
      period: "Q3",
      periodLabel: `Q3 (Oct - Dec ${fyStartYear})`,
      fyLabel,
    };
  }

  if (periodRaw === "Q4") {
    const fromStr = `${fyEndYear}-01-01`;
    const toStr = `${fyEndYear}-03-31`;
    return {
      fromDate: new Date(`${fromStr}T00:00:00.000Z`),
      toDate: new Date(`${toStr}T23:59:59.999Z`),
      fromStr,
      toStr,
      period: "Q4",
      periodLabel: `Q4 (Jan - Mar ${fyEndYear})`,
      fyLabel,
    };
  }

  // 3b. Indian FY Half-Yearly (H1: Apr-Sep, H2: Oct-Mar)
  if (periodRaw === "H1") {
    const fromStr = `${fyStartYear}-04-01`;
    const toStr = `${fyStartYear}-09-30`;
    return {
      fromDate: new Date(`${fromStr}T00:00:00.000Z`),
      toDate: new Date(`${toStr}T23:59:59.999Z`),
      fromStr,
      toStr,
      period: "H1",
      periodLabel: `H1 (Apr - Sep ${fyStartYear})`,
      fyLabel,
    };
  }

  if (periodRaw === "H2") {
    const fromStr = `${fyStartYear}-10-01`;
    const toStr = `${fyEndYear}-03-31`;
    return {
      fromDate: new Date(`${fromStr}T00:00:00.000Z`),
      toDate: new Date(`${toStr}T23:59:59.999Z`),
      fromStr,
      toStr,
      period: "H2",
      periodLabel: `H2 (Oct ${fyStartYear} - Mar ${fyEndYear})`,
      fyLabel,
    };
  }

  // 4. Monthly (Supports THIS_MONTH, LAST_MONTH, or specific months MONTH_1 to MONTH_12)
  if (periodRaw.startsWith("MONTH_") || periodRaw === "THIS_MONTH" || periodRaw === "LAST_MONTH" || periodRaw === "MONTH") {
    let month;
    if (periodRaw.startsWith("MONTH_")) {
      month = parseInt(periodRaw.replace("MONTH_", ""), 10);
    } else if (periodRaw === "LAST_MONTH") {
      month = now.getUTCMonth();
      if (month === 0) month = 12;
    } else {
      month = query.month ? parseInt(query.month, 10) : now.getUTCMonth() + 1;
    }

    const year = query.year ? parseInt(query.year, 10) : (month >= 4 ? fyStartYear : fyEndYear);
    const padMonth = String(month).padStart(2, "0");
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const fromStr = `${year}-${padMonth}-01`;
    const toStr = `${year}-${padMonth}-${String(lastDay).padStart(2, "0")}`;

    const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    return {
      fromDate: new Date(`${fromStr}T00:00:00.000Z`),
      toDate: new Date(`${toStr}T23:59:59.999Z`),
      fromStr,
      toStr,
      period: `MONTH_${month}`,
      periodLabel: `${monthNames[month]} ${year}`,
      fyLabel,
    };
  }

  // 5. Default: Full Financial Year
  const fromStr = `${fyStartYear}-04-01`;
  const toStr = `${fyEndYear}-03-31`;
  return {
    fromDate: new Date(`${fromStr}T00:00:00.000Z`),
    toDate: new Date(`${toStr}T23:59:59.999Z`),
    fromStr,
    toStr,
    period: "FY",
    periodLabel: fyLabel,
    fyLabel,
  };
};

module.exports = {
  getIndianFinancialYear,
  resolveIndianPeriod,
};
