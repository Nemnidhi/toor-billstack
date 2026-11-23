// The auditor role (client, D11, 23 Nov 2026): "the auditor should get view access ... appoint an
// accountant read-only, and sometimes give them other features too".
//
// An auditor reads everything an accountant or staff member can read, and writes nothing - except
// in the areas the owner grants that person here. A grant lets them do there what an accountant can.
// Paths are matched against the full API path (e.g. /api/expenses/123).

const AUDITOR_GRANTS = [
  { key: "invoices", label: "Invoices, quotes, credit notes", paths: [/^\/api\/invoices(\/|$)/, /^\/api\/quotes(\/|$)/, /^\/api\/sales(\/|$)/] },
  { key: "payments", label: "Receipts and payments", paths: [/^\/api\/payments(\/|$)/] },
  { key: "customers", label: "Clients", paths: [/^\/api\/customers(\/|$)/] },
  { key: "expenses", label: "Expenses (and their documents)", paths: [/^\/api\/expenses(\/|$)/, /^\/api\/documents\/expense(\/|$)/] },
  { key: "purchases", label: "Purchases and suppliers", paths: [/^\/api\/purchases(\/|$)/, /^\/api\/suppliers(\/|$)/, /^\/api\/documents\/(purchase|supplier)(\/|$)/] },
  { key: "banking", label: "Bank accounts and reconciliation", paths: [/^\/api\/accounting\/(bank-accounts|bank-statements|bank-reconciliation)(\/|$)/] },
  { key: "journals", label: "Journal entries and opening balances", paths: [/^\/api\/accounting\/(journal-entries|opening-balances|backfill)(\/|$)/] },
  { key: "tds", label: "TDS (challans, 26AS)", paths: [/^\/api\/accounting\/tds(\/|$)/] },
  { key: "period_lock", label: "Close / reopen the books", paths: [/^\/api\/accounting\/period-lock(\/|$)/] },
  { key: "payroll", label: "Payroll (post, pay, advances)", paths: [/^\/api\/accounting\/payroll(\/|$)/] },
  { key: "year_end", label: "Year end (deposits, fixed assets)", paths: [/^\/api\/accounting\/(deposits|fixed-assets)(\/|$)/] },
];

const GRANT_KEYS = AUDITOR_GRANTS.map((grant) => grant.key);

// Writes an auditor may always make: their own sign-in, sign-out and password.
const ALWAYS_ALLOWED = [/^\/api\/auth(\/|$)/];

const cleanGrants = (value) => [...new Set((Array.isArray(value) ? value : []).filter((key) => GRANT_KEYS.includes(key)))];

module.exports = { AUDITOR_GRANTS, GRANT_KEYS, ALWAYS_ALLOWED, cleanGrants };
