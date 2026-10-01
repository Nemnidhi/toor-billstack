const SYSTEM_ACCOUNTS = [
  // Assets (1000 - 1999)
  { code: "1010", name: "Cash on Hand", type: "ASSET", normalBalance: "DEBIT", description: "Physical cash on hand" },
  { code: "1020", name: "Bank Account", type: "ASSET", normalBalance: "DEBIT", description: "Primary operational bank account" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT", description: "Trade debtors / customer receivable balances" },
  { code: "1310", name: "CGST Input Tax Credit", type: "ASSET", normalBalance: "DEBIT", description: "Input CGST credit from purchases/expenses" },
  { code: "1320", name: "SGST Input Tax Credit", type: "ASSET", normalBalance: "DEBIT", description: "Input SGST credit from purchases/expenses" },
  { code: "1330", name: "IGST Input Tax Credit", type: "ASSET", normalBalance: "DEBIT", description: "Input IGST credit from inter-state purchases/expenses" },

  // Liabilities (2000 - 2999)
  { code: "2010", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Trade creditors / vendor payables" },
  { code: "2100", name: "Customer Advances", type: "LIABILITY", normalBalance: "CREDIT", description: "Unallocated customer receipts and advance payments" },
  { code: "2210", name: "CGST Output Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Central GST collected on taxable sales" },
  { code: "2220", name: "SGST Output Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "State GST collected on taxable sales" },
  { code: "2230", name: "IGST Output Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Integrated GST collected on inter-state sales" },

  // Equity (3000 - 3999)
  { code: "3010", name: "Owner Equity / Opening Balance", type: "EQUITY", normalBalance: "CREDIT", description: "Capital introduced and retained equity" },

  // Income / Revenue (4000 - 4999)
  { code: "4010", name: "Sales / Service Revenue", type: "INCOME", normalBalance: "CREDIT", description: "General sales and service earnings" },
  { code: "4020", name: "Coworking Rental Revenue", type: "INCOME", normalBalance: "CREDIT", description: "Desk and private office rental revenue" },
  { code: "4030", name: "Brokerage Revenue", type: "INCOME", normalBalance: "CREDIT", description: "Real estate and commercial transaction brokerage commission" },

  // Expenses (5000 - 5999)
  { code: "5010", name: "General & Administrative Expenses", type: "EXPENSE", normalBalance: "DEBIT", description: "Operating and general administrative expenses" },
  { code: "5990", name: "Payment & Rounding Adjustment", type: "EXPENSE", normalBalance: "DEBIT", description: "Minor fractional paise and invoice rounding differentials" },
];

module.exports = { SYSTEM_ACCOUNTS };
