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

## Client answers (handwritten notes, received 23 Nov 2026)

Transcribed from three notebook photos. Readings marked (?) are uncertain; confirm with the client.

| # | Client's answer | What it means here |
|---|---|---|
| D1 | Yes, the invoice can be cancelled, and deleted if possible | Cancel stays. Deleting an issued invoice breaks the consecutive GST series (rule 46) and the edit log (rule 3(1)); proposal: delete only drafts never issued |
| D2 | "Samjh nahi aaya" (not understood) | Re-explain. Their horizontal / vertical answer below is in effect the answer |
| D5, D7 | We do not cut TDS of anyone; we pay in full (?). Rent: TDS 10%, maintenance 1%; when we receive rent it comes with TDS deducted | Payee side stays off (no supplier TDS). Customers deduct 10% on rent, 1% on maintenance: the receivable side, already built. CA flag: a company paying rent above the 194-I limit must deduct TDS. Reverse charge (D7) is not answered |
| D11 | Yes, the auditor should get view access. The person (owner) should be able to appoint an accountant read-only, and sometimes give them other features too | Build: auditor (read-only) role, and per-person feature grants |
| D12 | Yes | Switch to the FY series from 1 Apr 2027 |
| D13 | Option to create other businesses with separate accounting. Even a personal account: much spending is on credit card, so the founder's accounts should be managed too. Access to be given by Ashish sir manually | Build: any number of businesses with separate books (incl. the founder's personal), access granted by hand |
| D14 | Aashi ma'am and the accountant | The accountant role can close / reopen periods (today owner / admin only) |
| D15 | Yes | Build (a) deposit set-off against unpaid invoices, (b) GST on forfeited deposit / notice recovery |
| D21 | Start everything fresh; old fixed assets not brought in (?) | Nothing to enter |
| D22 | Yes | Switch the KPI incentive on in the CRM with the example bands |
| D24 | Aashi ma'am, by the 5th of every month. As per leaves applied in the CRM, 1 paid leave; otherwise done manually | Payroll finalised by Aashi ma'am (needs a non-admin payroll permission in the CRM); "Paid leave days per month" = 1 (a setting) |
| D25 | Goldhawk staff are paid by Goldhawk only | Build: Goldhawk's people go to Goldhawk's books (second key / company split) |
| D26 | Yes, enter staff advances | Their data entry |

New requests in the same notes:

1. Upload a screenshot / photo of a bill and the expense fills itself in.
2. GST reports exactly to the government format, so they go straight to the CA.
3. Both horizontal and vertical categorisation: businesses (e.g. Workspace, TOOR, ...) against categories C1, C2, C3.
4. The same invoice number series across categories.
5. Report PDF export with pie charts and percentages.
6. Link the bank account to BillStack.

Not answered (mostly the CA's): D3, D4, D6, D8, D9, D10, D17, D18, D19, D20, D23.

### Built from the answers (branch feat/client-answers-23nov, not deployed)

**More businesses (D13).** The group owner adds any number of businesses in Settings > Businesses & access:
a company (own legal details, GST with a GSTIN or none, own invoice prefix, own ledgers) or personal
books (e.g. the founder's credit-card spending: never GST, open only to their owner and the people given
access, never part of company reports). Rename and archive (books kept; bring back any time). Access is
given by hand per business and role. Goldhawk keeps its place in the CRM link and cannot be archived.
The consolidated statements stay TOOR + Goldhawk; other businesses are reported on their own.
Expenses can be paid by credit card: owed to the card (2060 Credit Card Payable) until the card bill is
paid from the bank (journal entry: Dr 2060, Cr 1020). A bank account can be a credit card; its statement
reconciles against 2060. Deploy note: the server drops the old unique index
`businesses.billingParentId_1_billingEntityCode_1` once at start-up and builds
`billing_entity_code_once_per_group` (still one Goldhawk per group).

**Business line x category (request 3).** Settings > Business lines & categories keeps one list of each for
the whole group (archive, never rename: posted books keep their names). Invoices (create, edit, detail
page, reissue), expenses, purchases and recurring profiles carry a business line and a report category;
journal lines carry them too, so moving a tag moves the books. Accounting > Business lines shows profit,
income or expenses by business line x category, business x either, for one business or all you can see,
with totals, shares and CSV. One invoice series is unchanged (request 4: tags never split numbering).
Old documents show under "Not set" until tagged.

**Auditor and accountant (D11, D14).** Team > invite or change a person to the Auditor role: read-only
everywhere an accountant or staff member can read. The owner can tick areas where that person may also
work like an accountant (invoices, receipts, clients, expenses, purchases, banking, journals, TDS, close /
reopen the books, payroll, year end; constants/auditor-grants.js, middlewares/auditor.js). The accountant
can now close and reopen the books (Accounting > Lock & edit log), with the owner and admins.

**Management report PDF (request 5).** Accounting > Report PDF: the period's profit and loss with each
head's share, pies for where the money came from and went, profit by centre, and the business line x
category split, from the posted books (services/management-report-pdf.service.js).

**Bill photo to expense (request 1).** Expenses > new expense > "Fill from a bill photo": a photo, scan
or PDF of the bill (JPG / PNG / WEBP / PDF, up to 5 MB; photos are shrunk in the browser) is read by
Claude (Anthropic API) and fills in the supplier, GSTIN (checked; a known supplier is linked), bill
number and date, amounts and GST (CGST / SGST or IGST, rate snapped to a standard one, place of supply
from the supplier's GSTIN), category and description, with warnings for anything that does not add up,
a future or old date, cess, or a foreign currency. Nothing is saved until the person checks it and
presses Save; the bill is then attached to the expense as its document. Switched on by setting
`ANTHROPIC_API_KEY` in the server's environment (the owner sets it; never in the repo); without it the
button says it is not switched on. Model `claude-opus-5-5` by default (`BILL_READER_MODEL`, effort
`BILL_READER_EFFORT` = low), with the API's server-side fallback; at most `BILL_READER_DAILY_LIMIT` (200)
reads a day per business. Cost on Opus 5.5 is about Rs 2-3 a bill; on Haiku 5.5
(`BILL_READER_MODEL=claude-haiku-5-5`) well under Rs 1 (the client had expected about Rs 1).

**Bank statements: Excel, CSV and PDF, matched automatically (request 6).** Accounting > Bank
reconciliation > Import statement takes the bank's Excel (.xlsx / .xls, including the HTML ".xls" most
Indian banks send), CSV or PDF. A text PDF is read from its table (a password-protected one asks for the
password, which is used once and never stored); a scanned PDF is read by Claude (same key as above). Dates
in any common form, one amount column with Dr / Cr, balances with Dr / Cr or minus; rows with no
direction take it from the running balance, and the running balance is checked row by row (breaks
listed). Repeated identical rows are kept apart, a re-import skips what is already there. After import,
a row with exactly one sure match (EXACT / HIGH, not wanted by another row) is matched automatically and
shown as "Matched (auto)"; undoing one keeps it from being auto-matched again. Live bank feeds (account
aggregator) are not built: they need an AA licence partner and the client's consent per account.

**Deposits: set off and keep with GST (D15).** Accounting > Year end > Deposits, "Pay invoices / keep with
GST" on a tenant's deposit: (a) pay their unpaid invoices from the deposit (oldest first or by hand; a
receipt by "Deposit set-off", Dr 2410 / Cr 1100, no money through the bank; undo from the deposit's
history, never from Payments); (b) keep part of it with GST: a tax invoice for the amount kept (GST
included; default SAC 997212 at 18%) is raised to the tenant and paid from the deposit, so it shows in
GSTR-1. A deposit typed with a name only is linked to the customer on its first set-off. The rest stays
the tenant's, to refund. CA to confirm GST applies to each case.

**Goldhawk's staff to Goldhawk's books (D25).** In the CRM's payroll sheet each person is "Paid by" TOOR
or Goldhawk (until set, the residential team is Goldhawk's, everyone else TOOR's; the choice is kept for
the coming months). Each company's people are sent as their own part with that company's key: TOOR's
with the existing `BILLSTACK_API_KEY`, Goldhawk's with `BILLSTACK_GOLDHAWK_API_KEY` (made in BillStack
Settings > Integrations with Goldhawk as the active company). Without that key Goldhawk's part is held
with "key not set" and can be sent again once it is there; TOOR's part is not affected. A correction that
moves everyone off a company withdraws that company's month here (reversed if posted, refused once
paid; Accounting > Payroll shows it as withdrawn). Reopening checks both companies' books for payments.

**Who finalises payroll (D24).** CRM Salary > Payroll > "Who finalises payroll" (admin): tick the
people who may finalise, send and reopen months besides admins (Aashi ma'am). They get the Payroll tab;
the KPI incentive and this list stay with admins. Last month is due by the 5th: a push on the 3rd, the
5th and the day after while it is not finalised, to admins and the people ticked (days can be changed;
push needs the CRM's VAPID keys). Paid leave: "Paid leave days per month" is already a CRM setting
(Salary > Deduction rules), default 1, per person if needed.

Deploy notes for this branch: `npm install` in backend (new: `@anthropic-ai/sdk`, `pdfjs-dist`); the
businesses index change above runs itself at start-up; nginx `client_max_body_size` at least 8m (bill
and statement uploads). CRM (branch feat/payroll, worktree changes): set `BILLSTACK_GOLDHAWK_API_KEY`
in its environment; no migration (old runs count as TOOR's).

### Built after the answers (23 Nov 2026, evening; same branch, not deployed)

- **WhatsApp through the company's WhatsApp app.**
  - With `WHATSAPP_APP_URL` and `WHATSAPP_APP_SECRET` set, BillStack's WhatsApp messages go through
    the oor-whatsapp app: one number, Meta-approved templates, the customer's chat. This covers
    invoice issued, reminders by due date, and payment received, both from the Communications rules
    and from the invoice page.
  - Calls are signed (caller "billstack"). Status comes back signed to
    `/api/communications/webhooks/whatsapp-app/status` and only moves forward.
  - A message goes only to a customer ticked **"Agreed to WhatsApp messages"**. The tick records when,
    how and by whom. Otherwise the message is skipped with the reason; a reminder is skipped, not retried.
  - Quotes and credit notes do not go through the app.
- **Customer payment links (Razorpay, the company's own account).**
  - Settings > Invoice & Payment > Online payments: key ID, key secret and webhook secret. The secrets
    are encrypted with `BILLSTACK_DATA_KEY` and never shown again; the keys are checked with Razorpay
    when the feature is switched on.
  - One open link per invoice, for what is due. It is made when the invoice or a reminder goes out
    (WhatsApp / email `{{payment_link}}`) or from the invoice page. A changed amount replaces the link.
  - Webhook: `/api/online-payments/webhooks/razorpay/<business id>`, events `payment_link.paid` and
    `settlement.processed`. A paid link is recorded once:
    - the payment ("RAZORPAY", by Razorpay's payment id), allocated to the invoice;
    - Dr 1030 Razorpay - Settlements Due;
    - Razorpay's fee Dr 5140 Bank Charges / Cr 1030.
  - A settlement posts Dr 1020 / Cr 1030 with the UTR, so the bank line matches it exactly.
  - Paid while the books are closed for that day: the invoice shows "Paid online but not recorded"
    with "Record it now".
- **GSTR-1 JSON checked against the portal's upload rules** (`utils/gstr1-json-check.js`), before each
  download (Reports > GSTR-1, list on the page). It checks:
  - formats and lengths, dd-mm-yyyy dates in the period, numbers used twice;
  - rates (incl. 40%), IGST vs CGST + SGST by place of supply, tax within Rs 1 of rate x value;
  - B2CL above Rs 1 lakh inter-state only, B2CS rows;
  - Table 12 split B2B / B2C with the B2B tab filled, SAC unit NA, 4 / 6 digit codes, Table 12
    tying to the invoice tables;
  - Table 13 present.

  GSTN publishes no formal JSON schema, so the last check is still the offline tool (D9).

  Today's export passes it (tests/books-phase3-gst.test.js).
- **Not built: live bank feeds.** These need an RBI account-aggregator partner (e.g. Setu, Finvu,
  OneMoney) under a contract the company signs, and each bank's consent flow. Statement import (Excel
  / CSV / PDF) stays the way in.
- Tests:
  - `tests/whatsapp-app-and-payment-links.test.js` (DB, 7);
  - `tests/gstr1-json-check.test.js` (4);
  - in the WhatsApp app, integrations.e2e has a BillStack test (76 pass).

### Audit fixes (23 Nov 2026, night; same branch, not deployed)

From the four-system audit (OOR_Four_System_Audit_23Nov2026.pdf).

- **Most receipts are bank transfer or cash; Razorpay is the exception.** Record payment already covers
  them: cash to 1010, bank transfer / UPI / cheque / card to 1020, TDS deducted, UTR, part payments,
  advances, and the bank statement import matching by UTR or amount and date. New: method
  **"Razorpay (online, settles later)"** for a Razorpay payment taken outside a BillStack link. It
  goes to 1030 like a link payment, so the settlement can clear it (before, it had no method and would
  have been booked to the bank twice).
- **Razorpay settlements (BS-02).** `settlement.processed` reads Razorpay's settlement recon for the
  day. It posts Dr 1020 / Cr 1030 only when every line is a payment BillStack recorded and the lines
  add up to the settlement. Otherwise it waits in Settings > Online payments > Settlements as "Needs
  review" with the unknown lines. The accountant records them (method Razorpay) and posts, or marks
  it recorded by hand.
- **Razorpay refunds (BS-02).** `refund.processed` puts an amber box on the invoice. Choose "Reverse
  the payment" (full refunds: allocations and payment reversed, the invoice is due again) or "I
  recorded it myself".
- **Webhook events are claimed once (BS-03).** Two copies of the same event arriving together record
  one payment. A failed event is marked FAILED and Razorpay retries it.
- **Signatures compared in constant time (BS-04)**, and the internal WhatsApp status route needs owner
  / admin (BS-05).
- **Reprinted invoices keep the seller as issued (BS-06).** The PDF used the company's current
  profile; it now uses the invoice's seller snapshot (name, GSTIN, address, logo, signature).
  `tests/multi-billing-entity.test.js` is in `npm test`.
- **Two-step sign-in (BS-01).**
  - Each user can switch it on: user menu > Sign-in security, using an authenticator app. Ten one-time
    recovery codes are shown once.
  - Sign-in (password or Google) then asks for the 6-digit code. Each code works once, and five
    wrong codes pause it for 15 minutes.
  - Switching it off needs a code. An owner / admin can reset someone else's from Team; only an owner
    can reset an owner's.
  - The secret is encrypted with `BILLSTACK_DATA_KEY`.
  - Super admin: set `SUPER_ADMIN_TOTP_SECRET` (make one with `node scripts/make-totp-secret.js`) and
    the super-admin login asks for the code.
- **The access token is no longer saved in the browser.** Only who is signed in is kept. A page load
  gets a fresh token from the httpOnly refresh cookie.
- Tests: `tests/two-factor.test.js` (DB, 3); the payment-links file adds concurrent events, a mixed
  settlement and a refund.

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
| D11 | Auditor access (answered 23 Nov: view access, plus features given per person) | built: Auditor role, read-only, with per-person grants |
| D12 | Switch the invoice series to the financial-year format (e.g. TOOR/{FY}/{0001}) and from when (best from 1 Apr 2027, a new FY). Old numbers stay as they are | not switched: format unchanged; the {FY} token and 16-character check are ready in Settings > Invoice & Payment |
| D13 | Goldhawk GST: limit Rs 20 lakh (services, MP), and the date its registration takes effect once it registers | watch with alerts at 75 / 90 / 100%; Goldhawk stays without GST until "GST registration effective from" is set in its settings |
| D14 | Period lock: who closes the books (answered: Aashi ma'am and the accountant) and when (e.g. after each GSTR-3B is filed, and after the audit for the year) | nothing closed; owner / admin / accountant can close or reopen in Accounting > Lock & edit log |
| D15 | Deposits (answered yes): CA to confirm GST at 18% on each kind of amount kept (notice-period recovery, damages) | built: (a) set-off against invoices, (b) keep with GST as a tax invoice; plain forfeit (no GST) is still there |
| D16 | Payroll: salaries come from the CRM's finalised month into the books | built (see "Payroll as built"); stop entering salaries as Expenses from the first month sent, or they are counted twice (the run shows a warning) |
| D22 | KPI incentive rule: which score (target score, or the overall KPI score - which already includes attendance and punctuality, so late marks would count twice), the bands and the amounts (% of salary or fixed). Commission on deal value is not in the CRM (its revenue figure is closed deals x Rs 50,000, a placeholder) | built switched off in the CRM; example bands 95+ 10%, 90+ 7.5%, 85+ 5%, 80+ 2.5% on the target score. Owner 21 Nov: salary, KPI score and incentive are the admin's call - all three are editable per person on the payroll sheet (blank = the CRM's figure; a typed incentive replaces the rule's amount, a typed KPI score drives the band). The rule stays only as a suggestion |
| D23 | Statutory payroll (owner 21 Nov: not sure yet whether PF / ESI / TDS apply): PF, ESI, professional tax and TDS on salary are optional boxes per person on the CRM payroll sheet ("Deductions & more"), blank = none, typed by the admin; they can also be named deductions in Salary > Deduction rules (the sheet warns if both are set for one person). Not worked out by law (PF 12% of basic up to the 15,000 ceiling, ESI 0.75% under 21,000 gross, MP professional tax slabs, s.192 TDS projection). Employer's PF (12%) and ESI (3.25%) share is not added. CA to say what is needed | optional per-person amounts typed by the admin; employer share not posted |
| D24 | Leavers' final settlement (people switched off in the CRM after the month began are included with a warning; no notice-pay / leave encashment / gratuity). Answered: Aashi ma'am finalises by the 5th; 1 paid leave | built: named finalisers + reminders; final settlement by one-off additions / deductions |
| D25 | Goldhawk staff (answered: paid by Goldhawk only). Confirm the default: the residential team is Goldhawk's until someone is set otherwise | built: "Paid by" per person, Goldhawk's part with Goldhawk's key |
| D26 | Staff advances paid before this: enter them in Payroll > Staff advances with their old date, or as an opening balance on 1160, so recoveries do not leave a minus balance | none entered |
| D17 | Fixed asset lives and tax rates (CA to confirm): furniture 10 yrs / 10%, fit-out over the lease (max 10 yrs) / 10%, electrical 10 / 10%, office equipment 5 / 15%, computers 3 / 40%, servers 6 / 40%, software 3 / 40%, vehicles 8 / 15%, plant 15 / 15%; residual 5% (fit-out 0) | as listed; each asset's life, residual and tax rate can be changed when added |
| D18 | Schedule III: the companies' legal form (private limited assumed, Division I), and whether deposits received / given are non-current (assumed) or partly current; tax expense and deferred tax are left to the CA | as stated |
| D19 | RBI bank rate for MSMED interest (3 times it, monthly rests) | 5.5%, editable on the report |
| D20 | Tally: version (TallyPrime or ERP 9), and the company name in Tally (the export uses the BillStack company name); party ledgers vs control accounts | both versions' XML; party ledgers for customers / suppliers |
| D21 | Old fixed assets: enter them as "Owned before (opening)" (posts cost / depreciation to date against capital 3010). If they are already in the opening balances, enter them as opening with care so they are not counted twice | none entered |
| D27 | Razorpay fee GST: the fee with its GST goes to 5140 Bank Charges. If the company claims the GST on Razorpay's fee as input credit (Razorpay's monthly tax invoice), the CA moves the GST part to input IGST from that invoice | all to 5140 |
| D28 | Which companies send WhatsApp from the OOR number (WHATSAPP_APP_BUSINESS_IDS), and whether Goldhawk's customers get them from it too | all businesses |
| D29 | WhatsApp templates 5-7 (invoice, reminder, received) in the WhatsApp app's docs/META_TEMPLATES.md: owner submits to Meta; Meta may refuse the link inside the text | drafted, not submitted |
| D30 | Is the company's Razorpay account used only for BillStack payment links? If payments also come from elsewhere (website, POS), record them with method "Razorpay" so settlements post themselves | either way works: unknown lines wait for review |
| D6 | TDS on purchase bills (goods / contract work entered as Purchases, not Expenses) | not built: TDS is on expense bills only; the limit watch covers expense bills |

## Verification checklist (before deploy)

- Payroll: TOOR's people use the CRM's existing key. For Goldhawk's people, switch BillStack to Goldhawk, Settings > Integrations > new key, and set it on the CRM server as BILLSTACK_GOLDHAWK_API_KEY (at a hidden prompt). In the CRM, Salary > Payroll: check each person's "Paid by", pick last month, check the sheet against attendance, set the KPI incentive (D22) or leave it off, Finalise. In BillStack Accounting > Payroll (TOOR, then Goldhawk): map each deduction (PF, PT, advance...), Post, pay, pay dues. Cancel any hand-entered salary expense for the same month. Tick Aashi ma'am under "Who finalises payroll".
- Bill photo and scanned statements: set ANTHROPIC_API_KEY on the BillStack server (owner, at a hidden prompt), restart, read one real bill and check every field before Save.
- Bank: import one real statement of each bank in Excel and in PDF; check the balance check says all rows agree and the automatic matches.
- Deposits: on a test tenant, pay one invoice from the deposit and undo it; check Accounting > Bank & Cash Book shows no bank movement.

- WhatsApp app: on the server set `WHATSAPP_APP_URL`, `WHATSAPP_APP_SECRET` (the same secret as the
  app's `BILLSTACK_SHARED_SECRET`) and `BILLSTACK_DATA_KEY` (64 hex), all at hidden prompts.
  - Tick "Agreed to WhatsApp messages" on one test customer.
  - From an invoice, use Send invoice: check it arrives on the Meta test number and the invoice's
    message log turns Delivered / Read.
- Payment links: in Razorpay **test mode** first.
  - Enter the test keys and webhook secret in Settings > Invoice & Payment > Online payments.
  - Add the webhook in Razorpay with the URL shown, for payment_link.paid, refund.processed and
    settlement.processed.
  - Pay a test link: the invoice turns paid, 1030 holds the amount less the fee, 5140 the fee.
  - Then switch to the live keys.
- Two-step sign-in: owner switches it on first (Sign-in security) and keeps the recovery codes
  offline; then each admin / accountant. Super admin: `node scripts/make-totp-secret.js` on the
  server, add the key to the app, put SUPER_ADMIN_TOTP_SECRET in .env (hidden prompt), restart.
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
