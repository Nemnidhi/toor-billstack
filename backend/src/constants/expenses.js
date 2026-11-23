const EXPENSE_CATEGORIES = [
  "Rent",
  "Utilities",
  "Internet & Communication",
  "Salary & Wages",
  "Travel",
  "Marketing & Advertising",
  "Office Supplies",
  "Software & Subscriptions",
  "Repairs & Maintenance",
  "Housekeeping & Security",
  "Professional Fees",
  "Bank Charges",
  "Taxes & Fees",
  "Commission & Brokerage Paid",
  "Insurance",
  "Miscellaneous",
];

// The expense account (chart of accounts code) each category posts to.
// Anything not listed goes to 5010 General & Administrative Expenses.
const EXPENSE_CATEGORY_ACCOUNTS = {
  Rent: "5020",
  Utilities: "5030",
  "Internet & Communication": "5040",
  "Salary & Wages": "5050",
  Travel: "5060",
  "Marketing & Advertising": "5070",
  "Office Supplies": "5080",
  "Software & Subscriptions": "5090",
  "Repairs & Maintenance": "5110",
  "Housekeeping & Security": "5120",
  "Professional Fees": "5130",
  "Bank Charges": "5140",
  "Taxes & Fees": "5150",
  "Commission & Brokerage Paid": "5160",
  Insurance: "5170",
  Miscellaneous: "5010",
};

const expenseAccountCodeFor = (category) => EXPENSE_CATEGORY_ACCOUNTS[category] || "5010";

const EXPENSE_PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID"];
// CARD: a debit card (paid from the bank). CREDIT_CARD: owed to the card until its bill is paid.
const EXPENSE_PAYMENT_METHODS = ["", "CASH", "BANK_TRANSFER", "UPI", "CARD", "CREDIT_CARD", "CHEQUE", "OTHER"];
const EXPENSE_STATUSES = ["ACTIVE", "CANCELLED"];
// REVERSE_CHARGE: the supplier charges no GST (e.g. rent from an unregistered landlord to a
// registered business); we pay the GST ourselves and may take it back as input credit.
const EXPENSE_GST_TYPES = ["NONE", "GST_RECORDED", "EXEMPT", "REVERSE_CHARGE"];

module.exports = {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_ACCOUNTS,
  expenseAccountCodeFor,
  EXPENSE_GST_TYPES,
  EXPENSE_PAYMENT_METHODS,
  EXPENSE_PAYMENT_STATUSES,
  EXPENSE_STATUSES,
};
