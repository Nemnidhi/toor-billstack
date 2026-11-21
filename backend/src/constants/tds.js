// TDS (tax deducted at source) kinds BillStack knows, FY 2026-27.
//
// From 1 April 2026 the Income-tax Act 2025 is in force and payments to residents are
// covered by one section (393) with a table; the old section numbers (194-I, 194C, ...)
// are kept here because statements, 26AS / AIS and most accountants still use them.
// Rates and limits are from the Income Tax Department FAQ and published guides; the CA
// must confirm them (pending decision D3 in docs/BOOKS_PHASES_STATUS.md). They are
// suggestions in the app: the user can always change the rate or the amount.
//
// limit: { perPayment, perYear, perMonth } in rupees - TDS is due once any limit is crossed.
const TDS_KINDS = [
  { key: "RENT_BUILDING", label: "Rent - land, building, office, furniture", oldSection: "194-I(b)", newSection: "393(1)", rate: 10, limit: { perMonth: 50000 } },
  { key: "RENT_PLANT", label: "Rent - plant, machinery, equipment", oldSection: "194-I(a)", newSection: "393(1)", rate: 2, limit: { perMonth: 50000 } },
  { key: "CONTRACTOR_INDIVIDUAL", label: "Contractor - individual / HUF", oldSection: "194C", newSection: "393(1)", rate: 1, limit: { perPayment: 30000, perYear: 100000 } },
  { key: "CONTRACTOR_OTHER", label: "Contractor - company, firm, others", oldSection: "194C", newSection: "393(1)", rate: 2, limit: { perPayment: 30000, perYear: 100000 } },
  { key: "PROFESSIONAL", label: "Professional fees (CA, legal, consultants)", oldSection: "194J(b)", newSection: "393(1)", rate: 10, limit: { perYear: 50000 } },
  { key: "TECHNICAL", label: "Technical services / call centre", oldSection: "194J(a)", newSection: "393(1)", rate: 2, limit: { perYear: 50000 } },
  { key: "COMMISSION", label: "Commission / brokerage", oldSection: "194H", newSection: "393(1)", rate: 2, limit: { perYear: 20000 } },
];

// Without a valid PAN of the payee the rate is at least 20% (old section 206AA).
const TDS_NO_PAN_RATE = 20;

const tdsKind = (key) => TDS_KINDS.find((kind) => kind.key === key) || null;

// Indian financial year and quarter of a date: { fy: "2026-27", quarter: "Q3", quarterIndex: 3 }.
const indianQuarterOf = (value) => {
  const date = new Date(value);
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  const fyStart = month >= 4 ? year : year - 1;
  const quarterIndex = month >= 4 && month <= 6 ? 1 : month >= 7 && month <= 9 ? 2 : month >= 10 && month <= 12 ? 3 : 4;
  return { fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`, fyStart, quarter: `Q${quarterIndex}`, quarterIndex };
};

const quarterRange = (fyStart, quarterIndex) => {
  const startMonth = [3, 6, 9, 0][quarterIndex - 1]; // 0-based month: Apr, Jul, Oct, Jan
  const year = quarterIndex === 4 ? fyStart + 1 : fyStart;
  const from = new Date(Date.UTC(year, startMonth, 1));
  const to = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59, 999));
  return { from, to };
};

// Quarterly TDS statement (Form 140, formerly 26Q) due dates for a quarter.
const TDS_RETURN_DUE = { Q1: "31 Jul", Q2: "31 Oct", Q3: "31 Jan", Q4: "31 May" };

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

module.exports = { TDS_KINDS, TDS_NO_PAN_RATE, TDS_RETURN_DUE, PAN_PATTERN, TAN_PATTERN, tdsKind, indianQuarterOf, quarterRange };
