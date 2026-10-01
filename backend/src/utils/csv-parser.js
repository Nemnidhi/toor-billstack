const crypto = require("node:crypto");
const XLSX = require("xlsx");
const AppError = require("./appError");
const { toMinorUnits } = require("./money");

/**
 * Robust CSV Line Parser (handles RFC 4180 quotes, commas inside quotes, CRLF).
 */
const parseCsvLines = (csvText) => {
  const lines = [];
  let currentLine = [];
  let currentCell = "";
  let insideQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (char === "\"" && insideQuotes && nextChar === "\"") {
      currentCell += "\"";
      i++; // skip next quote
    } else if (char === "\"") {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      currentLine.push(currentCell.trim());
      currentCell = "";
    } else if ((char === "\r" || char === "\n") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      currentLine.push(currentCell.trim());
      if (currentLine.some((c) => c !== "")) lines.push(currentLine);
      currentLine = [];
      currentCell = "";
    } else {
      currentCell += char;
    }
  }

  if (currentCell !== "" || currentLine.length > 0) {
    currentLine.push(currentCell.trim());
    if (currentLine.some((c) => c !== "")) lines.push(currentLine);
  }

  return lines;
};

/**
 * Normalizes Date string to UTC Date object.
 * Supports: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD/MM/YY
 */
const parseDateString = (dateVal) => {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    return isNaN(dateVal.getTime()) ? null : dateVal;
  }
  const s = String(dateVal).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.slice(0, 10) + "T00:00:00.000Z");
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const parts = s.split(/[\/\-]/);
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    let year = parseInt(parts[2], 10);
    if (year < 100) year += 2000;

    if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
      const d = new Date(Date.UTC(year, month - 1, day));
      return isNaN(d.getTime()) ? null : d;
    }
  }

  const fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
};

/**
 * Cleans numerical monetary string (strips currency symbols, commas).
 */
const parseNumericAmount = (val) => {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : Math.abs(val);
  const cleaned = String(val).replace(/[^0-9.-]/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.abs(num);
};

/**
 * Shared grid parser for both CSV lines and XLSX worksheets.
 */
const parseBankStatementGrid = ({ rows, bankAccountId }) => {
  if (!rows || rows.length < 2) {
    throw new AppError("Bank statement file must contain headers and at least one transaction row", 400);
  }

  // Locate header index (search for Date and Narration/Particulars/Description)
  let headerRowIndex = -1;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const lower = row.map((c) => String(c || "").toLowerCase());
    const hasDate = lower.some((c) => c.includes("date"));
    const hasDesc = lower.some((c) => c.includes("narrat") || c.includes("desc") || c.includes("particular") || c.includes("remark") || c.includes("detail"));
    if (hasDate && hasDesc) {
      headerRowIndex = r;
      break;
    }
  }

  if (headerRowIndex === -1) {
    headerRowIndex = 0; // Default to first row
  }

  const headers = rows[headerRowIndex].map((h) => String(h || "").toLowerCase());

  const colDate = headers.findIndex((h) => h.includes("date") && !h.includes("value"));
  const colValDate = headers.findIndex((h) => h.includes("value date"));
  const colDesc = headers.findIndex((h) => h.includes("narrat") || h.includes("desc") || h.includes("particular") || h.includes("remark") || h.includes("detail"));
  const colRef = headers.findIndex((h) => h.includes("ref") || h.includes("chq") || h.includes("cheque") || h.includes("utr") || h.includes("txn id"));
  const colDebit = headers.findIndex((h) => h.includes("withdraw") || h.includes("debit") || h === "dr");
  const colCredit = headers.findIndex((h) => h.includes("deposit") || h.includes("credit") || h === "cr");
  const colBalance = headers.findIndex((h) => h.includes("bal"));

  if (colDate === -1 || colDesc === -1 || (colDebit === -1 && colCredit === -1)) {
    throw new AppError("Could not identify required statement columns (Date, Description/Narration, Debit/Credit)", 400);
  }

  const parsedTransactions = [];

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    const rawDate = row[colDate];
    const txnDate = parseDateString(rawDate);
    if (!txnDate) continue; // Skip non-data summary rows

    const description = String(row[colDesc] || "").trim();
    if (!description) continue;

    const reference = colRef !== -1 ? String(row[colRef] || "").trim() : "";
    const rawValDate = colValDate !== -1 ? row[colValDate] : null;
    const valueDate = rawValDate ? parseDateString(rawValDate) : null;

    const debitAmt = colDebit !== -1 ? parseNumericAmount(row[colDebit]) : 0;
    const creditAmt = colCredit !== -1 ? parseNumericAmount(row[colCredit]) : 0;
    const balanceAmt = colBalance !== -1 ? parseNumericAmount(row[colBalance]) : null;

    let direction = "";
    let amount = 0;

    if (debitAmt > 0 && creditAmt === 0) {
      direction = "OUTFLOW";
      amount = debitAmt;
    } else if (creditAmt > 0 && debitAmt === 0) {
      direction = "INFLOW";
      amount = creditAmt;
    } else if (debitAmt > 0) {
      direction = "OUTFLOW";
      amount = debitAmt;
    } else if (creditAmt > 0) {
      direction = "INFLOW";
      amount = creditAmt;
    } else {
      continue; // Skip zero-amount movement
    }

    const amountMinor = toMinorUnits(amount, "Transaction amount");
    const dateStr = txnDate.toISOString().slice(0, 10);

    // Build unique row fingerprint
    const fpString = `${bankAccountId}:${dateStr}:${reference}:${amountMinor}:${direction}:${description.slice(0, 40)}`;
    const importFingerprint = crypto.createHash("sha256").update(fpString).digest("hex");

    parsedTransactions.push({
      transactionDate: txnDate,
      valueDate,
      description,
      reference,
      direction,
      amount,
      amountMinor,
      runningBalance: balanceAmt,
      importFingerprint,
    });
  }

  return parsedTransactions;
};

/**
 * Normalizes bank statement rows from parsed CSV grid.
 */
const parseBankStatementCsv = ({ csvText, bankAccountId }) => {
  const rows = parseCsvLines(csvText);
  return parseBankStatementGrid({ rows, bankAccountId });
};

/**
 * Normalizes bank statement rows from XLSX / XLS binary buffer.
 */
const parseBankStatementXlsx = ({ buffer, bankAccountId, sheetName = null }) => {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  } catch (err) {
    throw new AppError("Invalid or corrupted Excel file: " + err.message, 400);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new AppError("Excel file contains no worksheets", 400);
  }

  const targetSheet = sheetName && workbook.Sheets[sheetName] ? sheetName : workbook.SheetNames[0];
  const worksheet = workbook.Sheets[targetSheet];
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: "" });

  return parseBankStatementGrid({ rows, bankAccountId });
};

module.exports = {
  parseCsvLines,
  parseDateString,
  parseNumericAmount,
  parseBankStatementGrid,
  parseBankStatementCsv,
  parseBankStatementXlsx,
};
