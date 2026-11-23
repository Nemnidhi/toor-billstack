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
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const parseDateString = (dateVal) => {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    if (isNaN(dateVal.getTime())) return null;
    // Excel dates arrive as local midnight; keep the calendar day (in IST, UTC is the day before).
    return new Date(Date.UTC(dateVal.getFullYear(), dateVal.getMonth(), dateVal.getDate()));
  }
  const s = String(dateVal).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.slice(0, 10) + "T00:00:00.000Z");
    return isNaN(d.getTime()) ? null : d;
  }

  // YYYY/MM/DD
  const ymd = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/);
  if (ymd) {
    const d = new Date(Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // DD MMM YYYY / DD-MMM-YY (month written as a word)
  const named = s.match(/^(\d{1,2})[\s\/\-.]+([A-Za-z]{3,9})[\s\/\-.,]+(\d{2,4})$/);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    let year = parseInt(named[3], 10);
    if (year < 100) year += 2000;
    if (month >= 0) {
      const d = new Date(Date.UTC(year, month, parseInt(named[1], 10)));
      return isNaN(d.getTime()) ? null : d;
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const parts = s.split(/[\/\-.]/);
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

  return null;
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
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
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
  // One amount column with a Dr / Cr column (or Dr / Cr written on the amount) instead of two columns.
  const colAmount = colDebit === -1 && colCredit === -1 ? headers.findIndex((h) => /^(txn |transaction )?amount/.test(h.trim()) || h.trim() === "amt") : -1;
  const colDrCr = headers.findIndex((h) => /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|txn type|debit\s*\/\s*credit)$/.test(h.trim()));

  if (colDate === -1 || colDesc === -1 || (colDebit === -1 && colCredit === -1 && colAmount === -1)) {
    throw new AppError("Could not find the statement's columns (Date, Narration / Particulars, and Withdrawal / Deposit or Amount). Check that the file is the bank statement itself.", 400);
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
    const balanceText = colBalance !== -1 ? String(row[colBalance] ?? "").trim() : "";
    // An overdrawn balance is shown as "1,200.00 Dr" or "-1,200.00".
    const balanceAmt = balanceText === "" ? null : (/dr\b|^-/i.test(balanceText) ? -1 : 1) * parseNumericAmount(balanceText);

    let direction = "";
    let amount = 0;

    if (colAmount !== -1) {
      const amountText = String(row[colAmount] ?? "").trim();
      amount = parseNumericAmount(amountText);
      if (amount <= 0) {
        // An opening-balance line: no movement, but its balance tells the next row's direction.
        if (balanceAmt !== null) parsedTransactions.push({ anchor: true, transactionDate: txnDate, amount: 0, direction: "", runningBalance: balanceAmt });
        continue;
      }
      const kind = `${colDrCr !== -1 ? String(row[colDrCr] || "") : ""} ${amountText}`.toLowerCase();
      if (/\bdr\b|debit|withdraw|^\s*-|\s-/.test(kind)) direction = "OUTFLOW";
      else if (/\bcr\b|credit|deposit/.test(kind)) direction = "INFLOW";
      else direction = "?"; // worked out from the running balance below
    } else if (debitAmt > 0 && creditAmt === 0) {
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
      if (balanceAmt !== null) parsedTransactions.push({ anchor: true, transactionDate: txnDate, amount: 0, direction: "", runningBalance: balanceAmt });
      continue; // Skip zero-amount movement
    }

    const amountMinor = toMinorUnits(amount, "Transaction amount");

    parsedTransactions.push({
      transactionDate: txnDate,
      valueDate,
      description,
      reference,
      direction,
      amount,
      amountMinor,
      runningBalance: balanceAmt,
    });
  }

  resolveDirections(parsedTransactions);
  const movements = parsedTransactions.filter((t) => !t.anchor);
  const resolved = movements.filter((t) => t.direction !== "?");

  // Fingerprints make a re-import skip rows already in. Two identical rows in one file (two ₹10
  // charges on the same day) are told apart by their order; the first keeps the plain fingerprint.
  const seen = new Map();
  for (const t of resolved) {
    const dateStr = t.transactionDate.toISOString().slice(0, 10);
    const fpString = `${bankAccountId}:${dateStr}:${t.reference}:${t.amountMinor}:${t.direction}:${t.description.slice(0, 40)}`;
    const n = (seen.get(fpString) || 0) + 1;
    seen.set(fpString, n);
    t.importFingerprint = crypto.createHash("sha256").update(n === 1 ? fpString : `${fpString}#${n}`).digest("hex");
  }
  resolved.unresolvedCount = movements.length - resolved.length;
  return resolved;
};

const signed = (t) => (t.direction === "INFLOW" ? t.amount : -t.amount);
const near = (a, b) => Math.abs(a - b) < 0.011;

/** Statements list oldest first or newest first: the running balance tells which. */
const statementOrder = (rows) => {
  let asc = 0;
  let desc = 0;
  for (let i = 1; i < rows.length; i++) {
    const [prev, cur] = [rows[i - 1], rows[i]];
    if (prev.runningBalance === null || cur.runningBalance === null) continue;
    const delta = cur.runningBalance - prev.runningBalance;
    if (near(Math.abs(delta), cur.amount)) asc++;
    if (near(Math.abs(delta), prev.amount)) desc++;
  }
  return desc > asc ? "DESC" : "ASC";
};

/** Rows whose direction was not printed ("?") take it from how the balance moved. */
const resolveDirections = (rows) => {
  if (!rows.some((t) => t.direction === "?")) return;
  const order = statementOrder(rows);
  rows.forEach((t, i) => {
    if (t.direction !== "?" || t.runningBalance === null) return;
    const other = order === "ASC" ? rows[i - 1] : rows[i + 1];
    if (!other || other.runningBalance === null) return;
    const delta = t.runningBalance - other.runningBalance;
    if (near(Math.abs(delta), t.amount)) t.direction = delta > 0 ? "INFLOW" : "OUTFLOW";
  });
};

/**
 * Checks every row against the running balance printed beside it: a misread amount or a missing
 * row shows up as a break. Returns { checked, matched, order, breaks: [{ date, description, expected, printed }] }.
 */
const checkRunningBalances = (rows) => {
  const order = statementOrder(rows);
  const list = order === "ASC" ? rows : [...rows].reverse();
  const breaks = [];
  let checked = 0;
  for (let i = 1; i < list.length; i++) {
    const [prev, cur] = [list[i - 1], list[i]];
    if (prev.runningBalance === null || cur.runningBalance === null) continue;
    checked++;
    const expected = Math.round((prev.runningBalance + signed(cur)) * 100) / 100;
    if (!near(expected, cur.runningBalance)) {
      breaks.push({ date: cur.transactionDate.toISOString().slice(0, 10), description: cur.description.slice(0, 80), expected, printed: cur.runningBalance });
    }
  }
  return { checked, matched: checked - breaks.length, order, breaks: breaks.slice(0, 10), breakCount: breaks.length };
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
    // Excel files (zip / old binary) keep their real date cells. Text files (CSV, the HTML ".xls"
    // some banks send) are read as typed: parsing "05/11/26" would take it month-first.
    const binary = buffer[0] === 0x50 && buffer[1] === 0x4b ? true : buffer[0] === 0xd0 && buffer[1] === 0xcf;
    workbook = XLSX.read(buffer, binary ? { type: "buffer", cellDates: true } : { type: "buffer", raw: true });
  } catch (err) {
    throw new AppError("Invalid or corrupted Excel file: " + err.message, 400);
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new AppError("Excel file contains no worksheets", 400);
  }

  const targetSheet = sheetName && workbook.Sheets[sheetName] ? sheetName : workbook.SheetNames[0];
  const worksheet = workbook.Sheets[targetSheet];
  // Real date cells come as dates (their display format may be month-first); the rest as shown.
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: true, defval: "" }).map((row) =>
    row.map((cell) => (cell instanceof Date || typeof cell === "string" ? cell : typeof cell === "number" ? cell : String(cell ?? "")))
  );

  return parseBankStatementGrid({ rows, bankAccountId });
};

module.exports = {
  parseCsvLines,
  parseDateString,
  parseNumericAmount,
  parseBankStatementGrid,
  checkRunningBalances,
  parseBankStatementCsv,
  parseBankStatementXlsx,
};
