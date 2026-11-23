const SYSTEM_ACCOUNTS = [
  // Assets (1000 - 1999)
  { code: "1010", name: "Cash on Hand", type: "ASSET", normalBalance: "DEBIT", description: "Physical cash on hand" },
  { code: "1020", name: "Bank Account", type: "ASSET", normalBalance: "DEBIT", description: "Primary operational bank account" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET", normalBalance: "DEBIT", description: "Trade debtors / customer receivable balances" },
  { code: "1150", name: "Advances to Suppliers", type: "ASSET", normalBalance: "DEBIT", description: "Money paid to suppliers / landlords not yet set against a bill" },
  { code: "1160", name: "Staff Advances & Loans", type: "ASSET", normalBalance: "DEBIT", description: "Salary advances and loans to staff, recovered from their pay" },
  { code: "1210", name: "Security Deposits Given", type: "ASSET", normalBalance: "DEBIT", description: "Rent and other deposits paid to landlords / others, refundable" },
  { code: "1510", name: "Fixed Assets (Gross Block)", type: "ASSET", normalBalance: "DEBIT", description: "Furniture, fit-out, computers, equipment at cost (fixed asset register)" },
  { code: "1590", name: "Accumulated Depreciation", type: "ASSET", normalBalance: "CREDIT", description: "Depreciation charged to date on fixed assets (reduces the gross block)" },
  { code: "1410", name: "TDS Receivable", type: "ASSET", normalBalance: "DEBIT", description: "Income tax deducted by customers from their payments; claimed against tax payable" },
  { code: "1310", name: "CGST Input Tax Credit", type: "ASSET", normalBalance: "DEBIT", description: "Input CGST credit from purchases/expenses" },
  { code: "1320", name: "SGST Input Tax Credit", type: "ASSET", normalBalance: "DEBIT", description: "Input SGST credit from purchases/expenses" },
  { code: "1330", name: "IGST Input Tax Credit", type: "ASSET", normalBalance: "DEBIT", description: "Input IGST credit from inter-state purchases/expenses" },

  // Liabilities (2000 - 2999)
  { code: "2010", name: "Accounts Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Trade creditors / vendor payables" },
  { code: "2060", name: "Credit Card Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Spending on credit cards not yet paid off (pay the card bill from the bank to clear it)" },
  { code: "2100", name: "Customer Advances", type: "LIABILITY", normalBalance: "CREDIT", description: "Unallocated customer receipts and advance payments" },
  { code: "2210", name: "CGST Output Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Central GST collected on taxable sales" },
  { code: "2220", name: "SGST Output Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "State GST collected on taxable sales" },
  { code: "2310", name: "TDS Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Income tax deducted from supplier / landlord payments, to be deposited by challan" },
  { code: "2230", name: "IGST Output Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Integrated GST collected on inter-state sales" },
  { code: "2240", name: "CGST Payable - Reverse Charge", type: "LIABILITY", normalBalance: "CREDIT", description: "CGST we owe on supplies taken under reverse charge (paid in cash, GSTR-3B 3.1(d))" },
  { code: "2250", name: "SGST Payable - Reverse Charge", type: "LIABILITY", normalBalance: "CREDIT", description: "SGST we owe on supplies taken under reverse charge (paid in cash, GSTR-3B 3.1(d))" },
  { code: "2260", name: "IGST Payable - Reverse Charge", type: "LIABILITY", normalBalance: "CREDIT", description: "IGST we owe on supplies taken under reverse charge (paid in cash, GSTR-3B 3.1(d))" },

  { code: "2315", name: "TDS Payable - Salaries (s.192)", type: "LIABILITY", normalBalance: "CREDIT", description: "Income tax deducted from salaries, deposited by challan and filed in Form 24Q" },
  { code: "2320", name: "Salaries Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Net salaries for a finalised month not yet paid to staff" },
  { code: "2330", name: "PF Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Provident fund deducted from salaries, to be deposited with EPFO" },
  { code: "2340", name: "ESI Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "ESI deducted from salaries, to be deposited with ESIC" },
  { code: "2350", name: "Professional Tax Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Professional tax deducted from salaries, to be paid to the state" },
  { code: "2360", name: "Other Payroll Deductions Payable", type: "LIABILITY", normalBalance: "CREDIT", description: "Other amounts held back from salaries and owed to someone else (insurance, welfare fund)" },
  { code: "2410", name: "Security Deposits Received", type: "LIABILITY", normalBalance: "CREDIT", description: "Refundable deposits taken from tenants / members" },

  // Equity (3000 - 3999)
  { code: "3010", name: "Owner Equity / Opening Balance", type: "EQUITY", normalBalance: "CREDIT", description: "Capital introduced and retained equity" },

  // Income / Revenue (4000 - 4999)
  { code: "4010", name: "Sales / Service Revenue", type: "INCOME", normalBalance: "CREDIT", description: "General sales and service earnings" },
  { code: "4020", name: "Coworking Rental Revenue", type: "INCOME", normalBalance: "CREDIT", description: "Desk and private office rental revenue" },
  { code: "4030", name: "Brokerage Revenue", type: "INCOME", normalBalance: "CREDIT", description: "Real estate and commercial transaction brokerage commission" },
  { code: "4100", name: "Other Income", type: "INCOME", normalBalance: "CREDIT", description: "Forfeited deposits, gain on sale of assets and other non-operating income" },
  { code: "4090", name: "Sales Returns & Credit Notes", type: "INCOME", normalBalance: "DEBIT", description: "Credit notes and sales returns, shown as a reduction of income" },

  // Expenses (5000 - 5999)
  { code: "5010", name: "General & Administrative Expenses", type: "EXPENSE", normalBalance: "DEBIT", description: "Operating and general administrative expenses" },
  { code: "5020", name: "Rent Paid", type: "EXPENSE", normalBalance: "DEBIT", description: "Rent and lease paid to landlords" },
  { code: "5030", name: "Electricity & Utilities", type: "EXPENSE", normalBalance: "DEBIT", description: "Electricity, water, DG and other utilities" },
  { code: "5040", name: "Internet & Communication", type: "EXPENSE", normalBalance: "DEBIT", description: "Internet, phone and communication" },
  { code: "5050", name: "Salaries & Wages", type: "EXPENSE", normalBalance: "DEBIT", description: "Staff salaries, wages and allowances" },
  { code: "5055", name: "Staff Incentives & Bonus", type: "EXPENSE", normalBalance: "DEBIT", description: "KPI incentives, bonus and other additions to salary" },
  { code: "5060", name: "Travel & Conveyance", type: "EXPENSE", normalBalance: "DEBIT", description: "Travel, fuel and local conveyance" },
  { code: "5070", name: "Marketing & Advertising", type: "EXPENSE", normalBalance: "DEBIT", description: "Ads, listings, promotions and marketing" },
  { code: "5080", name: "Office Supplies & Pantry", type: "EXPENSE", normalBalance: "DEBIT", description: "Stationery, consumables and pantry" },
  { code: "5090", name: "Software & Subscriptions", type: "EXPENSE", normalBalance: "DEBIT", description: "Software, SaaS and subscriptions" },
  { code: "5100", name: "Purchases", type: "EXPENSE", normalBalance: "DEBIT", description: "Goods bought from suppliers (purchase bills)" },
  { code: "5110", name: "Repairs & Maintenance", type: "EXPENSE", normalBalance: "DEBIT", description: "Repairs, maintenance and AMC" },
  { code: "5120", name: "Housekeeping & Security", type: "EXPENSE", normalBalance: "DEBIT", description: "Housekeeping, cleaning and security services" },
  { code: "5130", name: "Professional & Legal Fees", type: "EXPENSE", normalBalance: "DEBIT", description: "CA, legal and consultancy fees" },
  { code: "5140", name: "Bank Charges", type: "EXPENSE", normalBalance: "DEBIT", description: "Bank and payment gateway charges" },
  { code: "5150", name: "Rates, Taxes & Fees", type: "EXPENSE", normalBalance: "DEBIT", description: "Government fees, property tax and licences" },
  { code: "5160", name: "Commission & Brokerage Paid", type: "EXPENSE", normalBalance: "DEBIT", description: "Commission paid to channel partners and brokers" },
  { code: "5170", name: "Insurance", type: "EXPENSE", normalBalance: "DEBIT", description: "Insurance premiums" },
  { code: "5180", name: "Interest & Late Fees (Statutory)", type: "EXPENSE", normalBalance: "DEBIT", description: "Interest and late fees on TDS / GST; not deductible for income tax" },
  { code: "5200", name: "Depreciation", type: "EXPENSE", normalBalance: "DEBIT", description: "Depreciation on fixed assets (Companies Act, straight line)" },
  { code: "5210", name: "Loss on Sale / Write-off of Assets", type: "EXPENSE", normalBalance: "DEBIT", description: "Loss on assets sold or discarded, and deposits written off" },
  { code: "5990", name: "Payment & Rounding Adjustment", type: "EXPENSE", normalBalance: "DEBIT", description: "Minor fractional paise and invoice rounding differentials" },
];

module.exports = { SYSTEM_ACCOUNTS };
