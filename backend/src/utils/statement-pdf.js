const AppError = require("./appError");

// Bank statement PDFs (client request, 23 Nov 2026: "statement upload - Excel / CSV / PDF").
// Net-banking PDFs carry their text, so the table is rebuilt from where each piece of text sits:
// the header line (Date ... Narration ... Balance) gives the columns, every line that starts with
// a date in the date column starts a transaction, and lines without one continue the narration
// above. The result is the same grid an Excel statement gives, so the same column rules apply.
// Scanned PDFs have no text; the caller then falls back to the document reader (Claude).

const loadPdfjs = () => import("pdfjs-dist/legacy/build/pdf.mjs");

const DATE_LIKE = /^(\d{1,2}[/\-. ](\d{1,2}|[A-Za-z]{3,9})[/\-. ,]*\d{2,4}|\d{4}-\d{2}-\d{2})$/;
const MONEY_LIKE = /\d[\d,]*\.\d{2}/;
const STOP_LINE = /(opening|closing)\s+bal|statement\s+summary|^total|grand\s+total|page\s+\d+\s+(of|\/)|computer[- ]generated|end of statement|carried forward|brought forward/i;
const isHeaderText = (text) => /date/.test(text) && /(narration|particular|description|details|remark)/.test(text) && /bal/.test(text);

/** Text pieces of every page, grouped into lines (top to bottom) of cells (left to right). */
const readPages = async (buffer, password) => {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), password: password || undefined, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    if (error?.name === "PasswordException") {
      const wrong = error.code === 2;
      const err = new AppError(wrong ? "The PDF password is not right. Check it and try again." : "This statement PDF is locked with a password. Type the password (the bank's email says what it is) and import again.", 400);
      err.code = wrong ? "PDF_PASSWORD_WRONG" : "PDF_PASSWORD_NEEDED";
      throw err;
    }
    throw new AppError("This PDF could not be opened. Download the statement again, or use the Excel / CSV download.", 400);
  }
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const { items } = await page.getTextContent();
    const pieces = items
      .filter((item) => item.str && item.str.trim())
      .map((item) => ({ text: item.str.trim(), x0: item.transform[4], x1: item.transform[4] + (item.width || 0), y: item.transform[5] }))
      .sort((a, b) => b.y - a.y || a.x0 - b.x0);
    const lines = [];
    for (const piece of pieces) {
      const line = lines.find((l) => Math.abs(l.y - piece.y) <= 2);
      if (line) line.pieces.push(piece);
      else lines.push({ y: piece.y, pieces: [piece] });
    }
    pages.push(lines.sort((a, b) => b.y - a.y).map((line) => ({ y: line.y, cells: mergeCells(line.pieces.sort((a, b) => a.x0 - b.x0)) })));
    page.cleanup();
  }
  await task.destroy();
  return pages;
};

/** Pieces closer than a small gap are one cell ("Closing" + "Balance"). */
const mergeCells = (pieces) => {
  const cells = [];
  for (const piece of pieces) {
    const last = cells[cells.length - 1];
    if (last && piece.x0 - last.x1 < 3) {
      last.text += piece.x0 - last.x1 > 0.8 ? ` ${piece.text}` : piece.text;
      last.x1 = Math.max(last.x1, piece.x1);
    } else cells.push({ ...piece });
  }
  return cells;
};

const overlap = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const gapBetween = (a, b) => (overlap(a, b) >= 0 ? 0 : Math.min(Math.abs(a.x0 - b.x1), Math.abs(b.x0 - a.x1)));
const columnOf = (cell, columns) => {
  let best = 0;
  let bestScore = -Infinity;
  columns.forEach((column, i) => {
    const o = overlap(cell, column);
    const score = o > 0 ? o : -gapBetween(cell, column);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
};

/**
 * The statement as a grid: [header, ...rows] (strings), or null when the PDF has no statement table
 * in its text (a scan, or a layout this cannot follow).
 */
const statementPdfToGrid = async (buffer, { password } = {}) => {
  const pages = await readPages(buffer, password);
  let header = null;
  const rows = [];
  for (const lines of pages) {
    let columns = null;
    let current = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const text = line.cells.map((c) => c.text).join(" ");
      if (!columns) {
        if (!isHeaderText(text.toLowerCase())) continue;
        columns = line.cells.map((c) => ({ ...c }));
        // A header that wraps onto a second line ("Withdrawal" / "Amt."): join it in.
        const next = lines[i + 1];
        if (next && line.y - next.y < 14 && !next.cells.some((c) => DATE_LIKE.test(c.text)) && next.cells.every((c) => columns.some((col) => overlap(c, col) > 0))) {
          for (const cell of next.cells) {
            const col = columns[columnOf(cell, columns)];
            col.text += ` ${cell.text}`;
            col.x0 = Math.min(col.x0, cell.x0);
            col.x1 = Math.max(col.x1, cell.x1);
          }
          i += 1;
        }
        if (!header) header = columns.map((c) => c.text);
        continue;
      }
      const dateCol = columns.findIndex((c) => /date|dt/i.test(c.text) && !/value/i.test(c.text));
      const values = columns.map(() => []);
      for (const cell of line.cells) values[columnOf(cell, columns)].push(cell.text);
      const joined = values.map((v) => v.join(" "));
      if (dateCol >= 0 && DATE_LIKE.test(joined[dateCol].trim())) {
        current = joined;
        rows.push(current);
      } else if (STOP_LINE.test(text)) {
        current = null;
      } else if (current && !joined.some((v, c) => c !== dateCol && MONEY_LIKE.test(v) && /bal|amt|amount|debit|credit|withdraw|deposit/i.test(columns[c].text))) {
        joined.forEach((v, c) => {
          if (v) current[c] = current[c] ? `${current[c]}${/[-/]$/.test(current[c]) ? "" : " "}${v}` : v;
        });
      }
    }
  }
  if (!header || !rows.length) return null;
  return [header, ...rows.map((row) => row.slice(0, header.length))];
};

module.exports = { statementPdfToGrid, isHeaderText };
