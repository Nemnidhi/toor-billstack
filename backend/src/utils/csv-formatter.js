/**
 * Clean CSV string generator with RFC 4180 compliance.
 */
const escapeCsvCell = (value) => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes("\"") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replaceAll("\"", "\"\"")}"`;
  }
  return str;
};

const arrayToCsv = (headers = [], rows = []) => {
  const headerLine = headers.map(escapeCsvCell).join(",");
  const rowLines = rows.map((row) => {
    if (Array.isArray(row)) {
      return row.map(escapeCsvCell).join(",");
    }
    return headers.map((h) => escapeCsvCell(row[h] !== undefined ? row[h] : "")).join(",");
  });

  return [headerLine, ...rowLines].join("\r\n");
};

const buildMultiSectionCsv = (sections = []) => {
  return sections
    .map((sec) => {
      const title = sec.title ? `# ${sec.title}\r\n` : "";
      const content = arrayToCsv(sec.headers, sec.rows);
      return `${title}${content}`;
    })
    .join("\r\n\r\n");
};

module.exports = {
  escapeCsvCell,
  arrayToCsv,
  buildMultiSectionCsv,
};
