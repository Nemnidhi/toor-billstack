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
| 5 year end | deposits, fixed assets + depreciation, Schedule III, GSTR-9 tables, MSME 45-day report, Tally export, payroll posting | built, tested (7 DB tests); payroll posting pending (D16) |

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
| D16 | Payroll posting: should BillStack's HR payroll post salaries, PF / ESI, TDS on salary (s.192) to the books, or stay as Salary expenses entered by hand | not built: salaries are entered as Expenses (head 5050) |
| D17 | Fixed asset lives and tax rates (CA to confirm): furniture 10 yrs / 10%, fit-out over the lease (max 10 yrs) / 10%, electrical 10 / 10%, office equipment 5 / 15%, computers 3 / 40%, servers 6 / 40%, software 3 / 40%, vehicles 8 / 15%, plant 15 / 15%; residual 5% (fit-out 0) | as listed; each asset's life, residual and tax rate can be changed when added |
| D18 | Schedule III: the companies' legal form (private limited assumed, Division I), and whether deposits received / given are non-current (assumed) or partly current; tax expense and deferred tax are left to the CA | as stated |
| D19 | RBI bank rate for MSMED interest (3 times it, monthly rests) | 5.5%, editable on the report |
| D20 | Tally: version (TallyPrime or ERP 9), and the company name in Tally (the export uses the BillStack company name); party ledgers vs control accounts | both versions' XML; party ledgers for customers / suppliers |
| D21 | Old fixed assets: enter them as "Owned before (opening)" (posts cost / depreciation to date against capital 3010). If they are already in the opening balances, enter them as opening with care so they are not counted twice | none entered |
| D6 | TDS on purchase bills (goods / contract work entered as Purchases, not Expenses) | not built: TDS is on expense bills only; the limit watch covers expense bills |

## Verification checklist (before deploy)

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
