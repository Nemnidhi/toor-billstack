# Books build: phases 1-5 (status and pending decisions)

Owner instruction (21 Nov 2026): build every phase; do not commit or push; any decision
that needs the owner or the client stays PENDING here and the build moves on.
Branch: `feat/books-phase1` (local only, uncommitted). Research: accountant map artifact
https://claude.ai/artifact/9DkBUmGZpezbu1JMfFfjVA

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 books | purchases, supplier payments, refunds, credit notes, returns in the journal; expense heads; centre tag; P&L by centre; backfill | built, tested |
| 2 TDS | TDS deducted by customers (receivable, 26AS/AIS match, certificates); TDS OOR deducts (rent, contractors, professionals, commission), payable, challans, Form 140 data, Form 131 register | built, tested (6 DB tests) |
| 3 GST in | input-credit register, GSTR-2B / IMS import and match, RCM on rent from unregistered landlords with self-invoice, GSTR-3B tables, GSTR-1 JSON | built, tested (7 DB tests) |
| 4 controls | period lock, complete edit log + auditor view, FY invoice series, Goldhawk 20 lakh watch, attachments on bills | built, tested (6 DB tests) |
| 5 year end | deposits, fixed assets + depreciation, Schedule III, GSTR-9 tables, MSME 45-day report, Tally export, payroll posting | built, tested (7 DB tests) |
| payroll (D16) | month's salary sheet finalised in the CRM (attendance, late marks, leave, named deductions, KPI incentive, one-off additions / deductions) sent to BillStack; posted at month end, salaries and PF / ESI / PT / TDS dues paid, staff advances, payslips, salary register | built, tested (4 DB tests here, 5 in the CRM); the CRM side is in the-office-on-rent (not committed) |

## Pending decisions (owner / client / CA) - nothing below blocks the build

| # | Decision | Built default until decided |
|---|---|---|
| D1 | Can an invoice that has a credit note or return be cancelled? Today it can, and the customer is left with a credit equal to the credit note (ledger and journal agree). | unchanged: allowed |
| D2 | Expense heads and centre list | 15 heads (5020-5170) mapped from categories; centre is free text |
| D3 | TDS rates and limits for FY 2026-27 (constants/tds.js: 194-I 10%/2% above 50k a month, 194C 1%/2% above 30k a bill or 1 lakh a year, 194J 10%/2% above 50k, 194H 2% above 20k, no PAN 20%) - CA to confirm | built as listed; every bill's rate and amount can be changed |
| D4 | 26AS / AIS file: which download the CA uses (26AS text, AIS CSV / JSON). The reader takes a table with a TAN and tax-deducted column, or the 26AS deductor-then-lines layout; it is tested on a sample built from the published layout, not a real file | send one real file (any year) to test against |
| D5 | Which landlords / payees get TDS and from when (set "TDS we deduct" on each supplier). Old bills are not changed | none set; bills without a supplier type carry no TDS |
| D7 | Which landlords are unregistered (reverse charge on commercial rent, from 10 Oct 2024) and whether any is a composition dealer (excluded). The user picks "Reverse charge" on each rent bill | per bill; nothing switched on for old bills |
| D8 | Monthly or quarterly (QRMP) GST filing for TOOR. GSTR-3B is built month by month | monthly |
| D9 | GSTR-1 portal JSON: the CA to load one month into the GST offline tool before it is used for upload (schema version GST3.2.1, HSN split B2B / B2C) | download offered next to the Excel |
| D10 | GSTR-2B file: send one real JSON or Excel download (any month) to test the reader against | built from the published layout |
| D11 | Auditor access to the edit log: a separate read-only "auditor" login, or the accountant role | owner, admin and accountant can view and export; no auditor role yet |
| D12 | Switch the invoice series to the financial-year format (e.g. TOOR/{FY}/{0001}) and from when (best from 1 Apr 2027, a new FY). Old numbers stay as they are | not switched: format unchanged; the {FY} token and 16-character check are ready in Settings > Invoice & Payment |
| D13 | Goldhawk GST: limit Rs 20 lakh (services, MP), and the date its registration takes effect once it registers | watch with alerts at 75 / 90 / 100%; Goldhawk stays without GST until "GST registration effective from" is set in its settings |
| D14 | Period lock: who closes the books and when (e.g. after each GSTR-3B is filed, and after the audit for the year) | nothing closed; owner / admin can close or reopen in Accounting > Lock & edit log |
| D15 | Deposits: (a) may a tenant's deposit be set off against unpaid invoices (today: refund or forfeit only; set-off is a refund plus a receipt); (b) GST on forfeited deposits / notice-period recovery (18% as a supply?) | (a) not built; (b) forfeit posts to Other income with no GST |
| D16 | Payroll: salaries come from the CRM's finalised month into the books | built (see "Payroll as built"); stop entering salaries as Expenses from the first month sent, or they are counted twice (the run shows a warning) |
| D22 | KPI incentive rule: which score (target score, or the overall KPI score - which already includes attendance and punctuality, so late marks would count twice), the bands and the amounts (% of salary or fixed). Commission on deal value is not in the CRM (its revenue figure is closed deals x Rs 50,000, a placeholder) | built switched off in the CRM; example bands 95+ 10%, 90+ 7.5%, 85+ 5%, 80+ 2.5% on the target score. Owner 21 Nov: salary, KPI score and incentive are the admin's call - all three are editable per person on the payroll sheet (blank = the CRM's figure; a typed incentive replaces the rule's amount, a typed KPI score drives the band). The rule stays only as a suggestion |
| D23 | Statutory payroll (owner 21 Nov: not sure yet whether PF / ESI / TDS apply): PF, ESI, professional tax and TDS on salary are optional boxes per person on the CRM payroll sheet ("Deductions & more"), blank = none, typed by the admin; they can also be named deductions in Salary > Deduction rules (the sheet warns if both are set for one person). Not worked out by law (PF 12% of basic up to the 15,000 ceiling, ESI 0.75% under 21,000 gross, MP professional tax slabs, s.192 TDS projection). Employer's PF (12%) and ESI (3.25%) share is not added. CA to say what is needed | optional per-person amounts typed by the admin; employer share not posted |
| D24 | Who finalises payroll (CRM admin only today) and by which day; leavers' final settlement (people switched off in the CRM after the month began are included with a warning; no notice-pay / leave encashment / gratuity) | admin only; final settlement by one-off additions / deductions |
| D25 | Goldhawk staff: the CRM sends to one BillStack company (the integration key's). Do Goldhawk's people get paid by Goldhawk (a second key and department split) or all by TOOR | all to the key's company (TOOR) |
| D26 | Staff advances paid before this: enter them in Payroll > Staff advances with their old date, or as an opening balance on 1160, so recoveries do not leave a minus balance | none entered |
| D17 | Fixed asset lives and tax rates (CA to confirm): furniture 10 yrs / 10%, fit-out over the lease (max 10 yrs) / 10%, electrical 10 / 10%, office equipment 5 / 15%, computers 3 / 40%, servers 6 / 40%, software 3 / 40%, vehicles 8 / 15%, plant 15 / 15%; residual 5% (fit-out 0) | as listed; each asset's life, residual and tax rate can be changed when added |
| D18 | Schedule III: the companies' legal form (private limited assumed, Division I), and whether deposits received / given are non-current (assumed) or partly current; tax expense and deferred tax are left to the CA | as stated |
| D19 | RBI bank rate for MSMED interest (3 times it, monthly rests) | 5.5%, editable on the report |
| D20 | Tally: version (TallyPrime or ERP 9), and the company name in Tally (the export uses the BillStack company name); party ledgers vs control accounts | both versions' XML; party ledgers for customers / suppliers |
| D21 | Old fixed assets: enter them as "Owned before (opening)" (posts cost / depreciation to date against capital 3010). If they are already in the opening balances, enter them as opening with care so they are not counted twice | none entered |
| D6 | TDS on purchase bills (goods / contract work entered as Purchases, not Expenses) | not built: TDS is on expense bills only; the limit watch covers expense bills |

## Verification checklist (before deploy)

- Payroll: in BillStack Settings > Integrations, the CRM's existing key is used (no new key). In the CRM, Salary > Payroll: pick last month, check the sheet against attendance, set the KPI incentive (D22) or leave it off, Finalise. In BillStack Accounting > Payroll (TOOR): map each deduction (PF, PT, advance...), Post, pay, pay dues. Cancel any hand-entered salary expense for the same month.

- Full server suite (`npm test`), every DB test with TEST_MONGO_URI, client build + tests.
- After deploy: Accounting > Historical Backfill (dry run, then execute).
- GST in: enter the supplier's bill number on bills with GST (needed to match GSTR-2B); Reports > GSTR-3B & input; mark rent from unregistered landlords as Reverse charge.
- Controls: open Accounting > Lock & edit log for TOOR, check the log lists today's changes, export the CSV; close the books up to a past day on a test entity and confirm a back-dated bill is refused, then reopen.
- Documents: attach a PDF rent agreement with dates to a landlord (Suppliers > Documents), a bill to a purchase and an expense; open each. Files are stored in backend uploads/documents (add to the server backup).
- Year end: Accounting > Year end. Enter deposits taken / given; add fixed assets (or move asset bills from Expenses); after 31 March charge depreciation for the year, then read Schedule III, MSME 45-day and GSTR-9; mark MSME suppliers (Suppliers > MSME status). Tally: import ledgers, then vouchers, into a test company first.
- TDS: set PAN / TDS type on landlords and other payees (Suppliers), TAN on customers who deduct TDS; enter TDS on receipts (Record payment) and on bills (Expenses); deposit with Accounting > TDS > Record challan.

## Phase 4 as built

- Period lock: Business.booksLock.lockedUpTo (IST day), enforced in postJournalEntry, so any posting dated on or before it is refused (409). Editing a record in a closed period is refused, because its reversal is dated on the original day; a cancellation posts on the cancel day. GET / PUT /api/accounting/period-lock (closing and reopening: owner / admin; both are in the edit log).
- Edit log: the EditLog collection refuses every update and delete. A Mongoose plugin on 16 book models records create, change (field before / after) and delete with the user, IP and request id, inside the same transaction, so a rolled-back change leaves no line. Viewer, filters and CSV export at Accounting > Lock & edit log (/api/accounting/edit-log, /edit-log/export). Not seen: raw collection writes and bulkWrite (book code uses neither), and scripts run outside a request are logged as "system".
- FY invoice series: {FY} token (26-27). The number restarts at 1 when the FY changes (invoiceNumbering.sequenceFy) in every place that issues numbers: invoice create / reissue, integration, quote conversion and the workflow / shared-operations helpers. A GST business cannot save a format longer than 16 characters, or with characters other than letters, digits, - and /.
- Goldhawk: GET /api/accounting/goldhawk-watch (FY billing before GST against Rs 20 lakh); a banner on the accounting page at 75 / 90 / 100%. Goldhawk can carry GST only once Business.gstRegisteredFrom is set; until then GST stays off (model, settings, invoice guard). Postings and the GST summary follow the invoice's seller snapshot, so old no-GST bills stay no-GST.
- Documents: PDF / JPG / PNG up to 5 MB, content checked against the type. Stored in uploads/documents (not public) and read only through /api/documents/<purchase|expense|supplier>/<id>/<docId> by a signed-in user of the same business. Agreements carry valid from / to; /api/documents/agreements/expiring lists those ending within 60 days. Removing a document takes it off the record; the file stays on disk and the edit log keeps the change.

## Phase 5 as built

- Accounts added (created for each company on first use): 1210 Security Deposits Given, 1510 Fixed Assets (Gross Block), 1590 Accumulated Depreciation, 2410 Security Deposits Received, 4100 Other Income, 5200 Depreciation, 5210 Loss on Sale / Write-off of Assets.
- Deposits (models/Deposit.js, services/deposit.service.js): numbered DR/26-27/0001 (received) and DG/26-27/0001 (given); refund, forfeit (received), adjust against rent / write off (given); a deposit with no movements can be cancelled (reversal). Register as on a day, with agreements ending within 60 days. /api/accounting/deposits.
- Fixed assets (models/FixedAsset.js, services/fixed-asset.service.js): FA-0001 numbers; source = paid now, owed, a bill already entered (moved from its expense head; that bill then cannot be cancelled), or opening. Companies Act straight line by the day; fit-out over the lease. "Charge depreciation for FY" posts one entry on 31 March (only after the year ends; years in order). Sale / discard: depreciation to the day of sale, then gain to 4100 or loss to 5210. Income-tax block register (WDV, 180-day half rate, s.50 note). /api/accounting/fixed-assets.
- Schedule III (services/year-end.service.js): balance sheet and P&L for the year and the previous year; payables split micro / small vs others; receivable and payable ageing as at 31 March from the payment dates; PPE note by class; a note if the sides do not agree or depreciation is not charged.
- MSME 45-day (s.43B(h)): Supplier.msmeType / udyamNumber / msmeCreditDays / msmeTrader; Expense.paidOn records when a bill is fully paid (older paid bills use their last update). Disallowed, paid-late with MSMED interest, pay-by-due-date, allowed-this-year lists.
- GSTR-9: tables 4, 5, 6 (6A from the monthly 3B working; 6B split into inputs = purchases, capital goods = bills in the asset register, input services = other expenses), 9 (cash vs credit), 17, 18, with notes on what the CA fills from the portal.
- Tally XML: ledgers (Tally groups) and vouchers, two downloads. /api/accounting/year-end/tally?part=masters|vouchers.

## Payroll as built (D16)

- CRM (the-office-on-rent, not committed): Salary > Payroll tab (admin). The month's sheet is the Salary page's own calculation (services/payroll.calc.js: absent, unapproved / unpaid leave, half days, leave beyond the paid entitlement, late marks after the grace, days before joining, named deductions) plus the Performance page's KPI score and target score, the KPI incentive (services/payrollRun.calc.js, PayrollPolicy.kpiIncentive, off by default) and what the admin sets per person on the sheet: this month's salary (attendance cuts are worked out on it; people with no salary set can be given one), KPI score, incentive, optional PF / ESI / professional tax / TDS, and other one-off additions / deductions (blank = the CRM's own figure; kept on the version, so a reopened month starts from them; the CRM's own figures are kept beside them; neither is sent to BillStack). Deductions never take pay below zero (what does not fit is left out and flagged). Finalise freezes it as a version (models/PayrollRun.js) and sends it (services/billstack.service.js sendPayrollRun); a failed send is kept with BillStack's reason and can be sent again. Reopen is refused once BillStack has paid any salary or due of that version. Routes /api/client/salary/runs..., /salary/kpi-incentive. Tests: test/payroll-run.test.cjs.
- BillStack: POST /api/integrations/payroll/runs (integration key) checks every figure adds up per person (earned = salary - attendance cut, gross = earned + additions, net = gross - deductions) and keeps the sheet (models/PayrollRun.js). Same run again = unchanged; a new version replaces the old while nothing of it is paid (a posted one is reversed on its own date); once paid it is refused ("put the correction in next month's sheet"). GET /api/integrations/payroll/runs/:runId tells the CRM whether it is locked.
- Accounting > Payroll (per company): sheet with attendance / KPI per person, payslip (print / PDF), salary register CSV, how each deduction is booked (guessed from its name: PF, ESI, PT, TDS, advance / loan; else reduces salary cost), journal preview, Post (dated the month's last day; period lock applies), Take out of the books (until paid), pay all / picked people (bank / cash, reference), pay PF / ESI / PT / TDS dues by challan, staff advances with balances.
- Accounts added: 1160 Staff Advances & Loans, 2315 TDS Payable - Salaries (s.192), 2320 Salaries Payable, 2330 PF Payable, 2340 ESI Payable, 2350 Professional Tax Payable, 2360 Other Payroll Deductions Payable, 5055 Staff Incentives & Bonus (Schedule III: employee benefits / other current liabilities / short-term advances).
