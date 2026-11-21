// Books phase 5 (21 Nov 2026): year end. Deposits taken and given, the fixed asset register with
// Companies Act depreciation and the Income-tax block, Schedule III with the previous year,
// the MSME 45-day report (s.43B(h)), GSTR-9 tables and the Tally XML export.
// Needs a replica-set MongoDB:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_books_phase5_test?replicaSet=rs0&directConnection=true" node --test tests/books-phase5-yearend.test.js
// The test database is dropped at the end. Never point it at a live database.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const Supplier = require("../src/models/Supplier");
const Expense = require("../src/models/Expense");
const JournalEntry = require("../src/models/JournalEntry");
const expenses = require("../src/services/expense.service");
const deposits = require("../src/services/deposit.service");
const assets = require("../src/services/fixed-asset.service");
const yearEnd = require("../src/services/year-end.service");

const MONGO_URI = process.env.TEST_MONGO_URI;

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const setup = async ({ gst = true } = {}) => {
  const uid = crypto.randomBytes(6).toString("hex");
  const business = await Business.create({
    name: `TOOR ${uid}`, slug: `toor-${uid}`, deploymentMode: "SELF_HOSTED",
    ...(gst ? { gstTaxId: "23CGZPB7175E1Z5", gstConfiguration: { enabled: true, gstin: "23CGZPB7175E1Z5", stateCode: "23" } } : {}),
    invoiceNumbering: { prefix: "INV", format: "INV-{YYYY}-{0001}", nextSequence: 1 },
  });
  const user = await User.create({ businessId: business._id, name: `U ${uid}`, email: `u-${uid}@example.com`, password: "x".repeat(20), role: "owner" });
  return { business, user };
};

// net debit (rupees) of an account over all posted entries
const net = async (businessId, code) => {
  const entries = await JournalEntry.find({ businessId, status: "POSTED" });
  let n = 0;
  for (const e of entries) for (const l of e.lines) if (l.accountCode === code) n += l.debitMinor - l.creditMinor;
  return n / 100;
};
const balanced = async (businessId) => {
  const entries = await JournalEntry.find({ businessId });
  for (const e of entries) assert.equal(e.lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0), 0, `${e.entryNumber} is not balanced`);
};

test("deposits received and given post to their own accounts; refunds, forfeits and rent adjustments close them", async () => {
  const { business, user } = await setup();
  const taken = await deposits.createDeposit({ businessId: business._id, userId: user._id, payload: { direction: "RECEIVED", partyName: "Cabin 4 tenant", amount: 50000, date: "2026-05-01", agreementEnd: "2027-04-30" } });
  assert.equal(taken.depositNumber, "DR/26-27/0001");
  assert.equal(await net(business._id, "2410"), -50000);
  assert.equal(await net(business._id, "1020"), 50000);
  await deposits.addMovement({ businessId: business._id, userId: user._id, depositId: taken._id, payload: { kind: "REFUND", amount: 20000, date: "2026-10-01" } });
  await assert.rejects(() => deposits.addMovement({ businessId: business._id, userId: user._id, depositId: taken._id, payload: { kind: "REFUND", amount: 40000, date: "2026-10-02" } }), /Only 30000 is left/);
  const closed = await deposits.addMovement({ businessId: business._id, userId: user._id, depositId: taken._id, payload: { kind: "FORFEIT", amount: 30000, date: "2026-10-02", note: "notice period not served" } });
  assert.equal(closed.status, "CLOSED");
  assert.equal(await net(business._id, "2410"), 0);
  assert.equal(await net(business._id, "4100"), -30000);
  await assert.rejects(() => deposits.cancelDeposit({ businessId: business._id, userId: user._id, depositId: taken._id }), /closed|refunds/);

  const given = await deposits.createDeposit({ businessId: business._id, userId: user._id, payload: { direction: "GIVEN", partyName: "Landlord, 3rd floor", amount: 300000, date: "2026-04-10", purpose: "RENT" } });
  await deposits.addMovement({ businessId: business._id, userId: user._id, depositId: given._id, payload: { kind: "ADJUST_RENT", amount: 100000, date: "2026-09-30" } });
  await assert.rejects(() => deposits.addMovement({ businessId: business._id, userId: user._id, depositId: given._id, payload: { kind: "FORFEIT", amount: 1, date: "2026-09-30" } }), /can be refunded/);
  assert.equal(await net(business._id, "1210"), 200000);
  assert.equal(await net(business._id, "5020"), 100000);

  const wrong = await deposits.createDeposit({ businessId: business._id, userId: user._id, payload: { direction: "GIVEN", partyName: "Typo", amount: 999, date: "2026-06-01" } });
  await deposits.cancelDeposit({ businessId: business._id, userId: user._id, depositId: wrong._id });
  assert.equal(await net(business._id, "1210"), 200000);

  const register = await deposits.depositRegister({ businessId: business._id, asOf: "2026-10-31" });
  assert.equal(register.totals.received, 0);
  assert.equal(register.totals.given, 200000);
  await balanced(business._id);
});

test("fixed assets: straight-line depreciation by the day, fit-out over the lease, the tax block with the 180-day rule, and a sale", async () => {
  const { business, user } = await setup();
  const furniture = await assets.createAsset({ businessId: business._id, userId: user._id, payload: { name: "Workstations (40)", assetClass: "FURNITURE", source: "PAID", cost: 100000, purchaseDate: "2025-04-01", putToUseDate: "2025-04-01" } });
  const fitout = await assets.createAsset({ businessId: business._id, userId: user._id, payload: { name: "3rd floor fit-out", assetClass: "FIT_OUT", source: "PAYABLE", cost: 300000, purchaseDate: "2025-04-01", leaseEndDate: "2028-03-31" } });
  const laptops = await assets.createAsset({ businessId: business._id, userId: user._id, payload: { name: "Laptops (2)", assetClass: "COMPUTERS", source: "PAID", cost: 60000, purchaseDate: "2025-12-01" } });
  assert.equal(furniture.assetNumber, "FA-0001");
  assert.equal(fitout.residualPercent, 0);
  assert.equal(await net(business._id, "1510"), 460000);
  assert.equal(await net(business._id, "2010"), -300000);

  await assert.rejects(() => assets.runDepreciation({ businessId: business._id, userId: user._id, fy: "26-27" }), /not over yet/);
  const run = await assets.runDepreciation({ businessId: business._id, userId: user._id, fy: "25-26" });
  const byName = Object.fromEntries(run.assets.map((a) => [a.name, a.amount]));
  assert.ok(Math.abs(byName["Workstations (40)"] - 9500) < 10, `furniture ${byName["Workstations (40)"]}`); // 95,000 over 10 years
  assert.ok(Math.abs(byName["3rd floor fit-out"] - 100000) < 100, `fit-out ${byName["3rd floor fit-out"]}`); // 3-year lease, no residual
  assert.ok(Math.abs(byName["Laptops (2)"] - 60000 * 0.95 / 3 * 121 / 365) < 30, `laptops ${byName["Laptops (2)"]}`); // 121 days of 3 years
  assert.equal(await net(business._id, "5200"), run.total);
  const again = await assets.runDepreciation({ businessId: business._id, userId: user._id, fy: "25-26" });
  assert.equal(again.posted, false);

  const blocks = await assets.itBlocks({ businessId: business._id, fy: "25-26" });
  const block10 = blocks.blocks.find((b) => b.rate === 10);
  const block40 = blocks.blocks.find((b) => b.rate === 40);
  assert.equal(block10.depreciation, 40000); // furniture + fit-out, full year
  assert.equal(block40.addHalf, 60000);
  assert.equal(block40.depreciation, 12000); // used under 180 days: half of 40%
  const next = await assets.itBlocks({ businessId: business._id, fy: "26-27" });
  assert.equal(next.blocks.find((b) => b.rate === 40).opening, 48000);

  const register = await assets.assetRegister({ businessId: business._id, fy: "25-26" });
  assert.equal(register.totals.additions, 460000);
  assert.equal(register.depreciationCharged, true);

  // sold on 1 Jun 2026 for 30,000: depreciation to the day of sale, then the gain or loss
  const sold = await assets.disposeAsset({ businessId: business._id, userId: user._id, assetId: laptops._id, payload: { date: "2026-06-01", amount: 30000 } });
  assert.equal(sold.status, "DISPOSED");
  const dep = sold.depreciation.reduce((s, d) => s + d.amount, 0);
  assert.ok(Math.abs(sold.disposal.gainOrLoss - (30000 - (60000 - dep))) < 0.02);
  assert.equal(await net(business._id, "1510"), 400000);
  await assert.rejects(() => assets.cancelAsset({ businessId: business._id, userId: user._id, assetId: furniture._id }), /sell or discard/);
  await balanced(business._id);
});

test("an asset bought on an expense bill is moved out of the expense head, and the bill cannot then be cancelled", async () => {
  const { business, user } = await setup();
  const bill = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Office Supplies", amountBeforeTax: 45000, paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2026-07-15", description: "Air conditioner" } });
  const before = await net(business._id, "5080");
  assert.equal(before, 45000);
  const ac = await assets.createAsset({ businessId: business._id, userId: user._id, payload: { name: "Split AC", assetClass: "OFFICE_EQUIPMENT", source: "BILL", expenseId: bill._id } });
  assert.equal(ac.cost, 45000);
  assert.equal(new Date(ac.purchaseDate).toISOString().slice(0, 10), new Date(bill.expenseDate).toISOString().slice(0, 10));
  assert.equal(await net(business._id, "5080"), 0);
  assert.equal(await net(business._id, "1510"), 45000);
  await assert.rejects(() => assets.createAsset({ businessId: business._id, userId: user._id, payload: { name: "Again", assetClass: "OFFICE_EQUIPMENT", source: "BILL", expenseId: bill._id } }), /already in the register/);
  await assert.rejects(() => expenses.cancelExpense({ businessId: business._id, userId: user._id, expenseId: bill._id }), /fixed asset register/);
  await assets.cancelAsset({ businessId: business._id, userId: user._id, assetId: ac._id });
  assert.equal(await net(business._id, "5080"), 45000);
});

test("Schedule III balances, carries the previous year, and splits payables to micro / small suppliers", async () => {
  const { business, user } = await setup({ gst: false });
  const micro = await Supplier.create({ businessId: business._id, supplierName: "Housekeeping (micro)", phone: "9876500001", msmeType: "MICRO", udyamNumber: "UDYAM-MP-00-0000001" });
  await deposits.createDeposit({ businessId: business._id, userId: user._id, payload: { direction: "RECEIVED", partyName: "Tenant A", amount: 80000, date: "2025-06-01" } });
  await assets.createAsset({ businessId: business._id, userId: user._id, payload: { name: "Chairs", assetClass: "FURNITURE", source: "OPENING", cost: 200000, openingAccumulated: 50000, openingDate: "2025-04-01", putToUseDate: "2022-04-01", purchaseDate: "2022-04-01", openingItWdv: 130000 } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Office Supplies", supplierId: micro._id, amountBeforeTax: 12000, expenseDate: "2026-02-10" } });
  await assets.runDepreciation({ businessId: business._id, userId: user._id, fy: "25-26" });

  const s = await yearEnd.scheduleIII({ businessId: business._id, fy: "25-26" });
  assert.equal(s.previousFy, "24-25");
  assert.ok(Math.abs(s.current.totals.difference) < 0.01, `difference ${s.current.totals.difference}`);
  assert.equal(s.current.bs.LT_OTHER.amount, 80000);
  assert.equal(s.current.bs.TRADE_PAYABLES_MSE.amount, 12000);
  assert.equal(s.current.bs.TRADE_PAYABLES.amount, 0);
  const dep = s.current.pl.DEPRECIATION.amount;
  assert.ok(dep > 0);
  assert.equal(s.current.bs.PPE.amount, 200000 - 50000 - dep);
  assert.equal(s.previous.totals.assets, 0);
  assert.equal(s.current.payablesAgeing.mse[0].amount, 12000);

  const blocks = await assets.itBlocks({ businessId: business._id, fy: "25-26" });
  assert.equal(blocks.blocks[0].opening, 130000);
  assert.equal(blocks.blocks[0].depreciation, 13000);
});

test("MSME 45-day report: late and unpaid bills of micro / small suppliers are disallowed, with MSMED interest; medium suppliers and traders are left out", async () => {
  const { business, user } = await setup({ gst: false });
  const micro = await Supplier.create({ businessId: business._id, supplierName: "Electrician (micro)", phone: "9876500002", msmeType: "MICRO", msmeCreditDays: 30 });
  const small = await Supplier.create({ businessId: business._id, supplierName: "Printer (small)", phone: "9876500003", msmeType: "SMALL" });
  const medium = await Supplier.create({ businessId: business._id, supplierName: "Big vendor (medium)", phone: "9876500004", msmeType: "MEDIUM" });
  const trader = await Supplier.create({ businessId: business._id, supplierName: "Stationery shop (trader)", phone: "9876500005", msmeType: "MICRO", msmeTrader: true });

  const unpaid = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Repairs & Maintenance", supplierId: micro._id, amountBeforeTax: 40000, expenseDate: "2026-01-05" } });
  const late = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Office Supplies", supplierId: small._id, amountBeforeTax: 10000, expenseDate: "2025-06-01" } });
  await Expense.collection.updateOne({ _id: late._id }, { $set: { paidAmount: 10000, balanceAmount: 0, paymentStatus: "PAID", paidOn: new Date("2025-08-15T10:00:00+05:30") } });
  const onTime = await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Office Supplies", supplierId: small._id, amountBeforeTax: 5000, paymentStatus: "PAID", paymentMethod: "CASH", expenseDate: "2025-07-01" } });
  assert.ok(onTime.paidOn, "a bill paid when entered is paid on its date");
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Office Supplies", supplierId: medium._id, amountBeforeTax: 90000, expenseDate: "2025-05-01" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Office Supplies", supplierId: trader._id, amountBeforeTax: 7000, expenseDate: "2025-05-01" } });

  const r = await yearEnd.msmeReport({ businessId: business._id, fy: "25-26", bankRate: 5.5 });
  const byNo = Object.fromEntries(r.rows.map((x) => [x.number, x]));
  assert.equal(byNo[unpaid.expenseNumber].status, "DISALLOWED");
  assert.equal(byNo[unpaid.expenseNumber].disallowed, 40000);
  assert.equal(new Date(byNo[unpaid.expenseNumber].dueDate).toISOString().slice(0, 10), "2026-02-04"); // 30 agreed days
  assert.equal(byNo[late.expenseNumber].status, "PAID_LATE"); // 15 days without an agreement
  assert.ok(byNo[late.expenseNumber].interest > 0);
  assert.equal(r.rows.length, 2, "on-time, medium and trader bills are not listed");
  assert.equal(r.totals.disallowed, 40000);
});

test("GSTR-9: reverse-charge rent in 4G and 6C, input credit by kind in 6B", async () => {
  const { business, user } = await setup();
  const landlord = await Supplier.create({ businessId: business._id, supplierName: "Unregistered landlord", phone: "9876500006" });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", supplierId: landlord._id, amountBeforeTax: 100000, gstType: "REVERSE_CHARGE", paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2025-11-03" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Software", amountBeforeTax: 10000, gstEnabled: true, gstRate: 18, paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2025-12-03", supplierGstin: "27AAAAA0000A1Z5", supplierInvoiceNumber: "S-1" } });
  const r = await yearEnd.gstr9({ businessId: business._id, fy: "25-26" });
  assert.equal(r.table4.G.taxableValue, 100000);
  assert.equal(r.table4.G.cgst + r.table4.G.sgst + r.table4.G.igst, 18000);
  assert.equal(r.table6.C.taxableValue, 100000);
  assert.equal(r.table6.B_services.taxableValue, 10000);
  const cgst = r.table9.find((x) => x.head === "CGST");
  assert.equal(cgst.paidInCash, 9000); // reverse charge is paid in cash
  assert.ok(r.notes.some((n) => /optional/.test(n)));
});

test("Tally export: ledgers with Tally groups, one voucher per journal entry, debits negative", async () => {
  const { business, user } = await setup({ gst: false });
  await deposits.createDeposit({ businessId: business._id, userId: user._id, payload: { direction: "RECEIVED", partyName: "Tenant & Co <B>", amount: 25000, date: "2026-05-01" } });
  await expenses.createExpense({ businessId: business._id, userId: user._id, payload: { category: "Rent", vendorName: "Landlord", amountBeforeTax: 40000, paymentStatus: "PAID", paymentMethod: "BANK_TRANSFER", expenseDate: "2026-05-05" } });
  const out = await yearEnd.tallyXml({ businessId: business._id, from: "2026-04-01", to: "2027-03-31" });
  const entries = await JournalEntry.countDocuments({ businessId: business._id, status: "POSTED" });
  assert.equal(out.counts.vouchers, entries);
  assert.equal((out.vouchersXml.match(/<VOUCHER /g) || []).length, entries);
  assert.match(out.mastersXml, /<LEDGER NAME="Security Deposits Received" ACTION="Create">.*?<PARENT>Current Liabilities<\/PARENT>/s);
  assert.match(out.mastersXml, /<PARENT>Bank Accounts<\/PARENT>/);
  assert.match(out.vouchersXml, /<LEDGERNAME>Bank Account<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><AMOUNT>-25000.00<\/AMOUNT>/);
  assert.match(out.vouchersXml, /Tenant &amp; Co &lt;B&gt;/);
  assert.match(out.vouchersXml, /<DATE>20260501<\/DATE>/);
});
