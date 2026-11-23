// Client answers (23 Nov 2026), item 6: bank statements as PDF (text PDFs read from their own text,
// scans by the document reader), single-amount-column Excel / CSV, the running-balance check.
// The Claude API is replaced by a fake client; nothing here calls Anthropic. The import through the
// service needs a throw-away database:
//   TEST_MONGO_URI="mongodb://127.0.0.1:27027/billstack_statement_pdf_test?replicaSet=rs0&directConnection=true" node --test tests/bank-statement-pdf.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const pdfMake = require("pdfmake/build/pdfmake");
pdfMake.vfs = require("pdfmake/build/vfs_fonts");

const { makeStatementPdf } = require("./fixtures/make-statement-pdf");
const { statementPdfToGrid } = require("../src/utils/statement-pdf");
const { parseBankStatementGrid, parseBankStatementXlsx, checkRunningBalances } = require("../src/utils/csv-parser");
const claude = require("../src/utils/claude-client");

const statementRows = (count, start = 100000) => {
  let balance = start;
  return Array.from({ length: count }, (_, i) => {
    const debit = i % 3 ? 1000 + i : 0;
    const credit = i % 3 ? 0 : 25000 + i;
    balance = balance - debit + credit;
    const narration = i % 4 === 0 ? `UPI-SHARMA STATIONERS-sharma@okhdfc-HDFC0001234-63124578${i}-PAYMENT FOR TONER AND PAPER` : `NEFT CR-ICIC0000104-ACME TECH ${i}`;
    return { date: `${String(1 + (i % 28)).padStart(2, "0")}/11/26`, narration, ref: `REF${i}`, debit, credit, balance };
  });
};
const scanLikePdf = () =>
  new Promise((resolve) => pdfMake.createPdf({ content: [{ canvas: [{ type: "rect", x: 0, y: 0, w: 300, h: 200, color: "#dddddd" }] }] }).getBuffer((b) => resolve(Buffer.from(b))));

test("a text PDF over several pages: every row, wrapped narrations joined, balances all agree", async () => {
  const rows = statementRows(70);
  const grid = await statementPdfToGrid(await makeStatementPdf(rows));
  assert.deepEqual(grid[0], ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]);
  assert.equal(grid.length - 1, 70, "the header repeated on later pages and the summary are not rows");
  assert.equal(grid[1][1], "UPI-SHARMA STATIONERS-sharma@okhdfc-HDFC0001234-631245780-PAYMENT FOR TONER AND PAPER");
  const parsed = parseBankStatementGrid({ rows: grid, bankAccountId: "acc" });
  assert.equal(parsed.length, 70);
  assert.equal(parsed[0].direction, "INFLOW");
  assert.equal(parsed[1].direction, "OUTFLOW");
  assert.equal(parsed[1].amount, 1001);
  assert.equal(parsed[0].reference, "REF0");
  const check = checkRunningBalances(parsed);
  assert.equal(check.checked, 69);
  assert.equal(check.breakCount, 0);
});

test("a password-locked statement PDF asks for the password and opens with it", async () => {
  const locked = await makeStatementPdf(statementRows(3), { userPassword: "ab12c" });
  await assert.rejects(statementPdfToGrid(locked), (e) => e.code === "PDF_PASSWORD_NEEDED");
  await assert.rejects(statementPdfToGrid(locked, { password: "wrong" }), (e) => e.code === "PDF_PASSWORD_WRONG");
  assert.equal((await statementPdfToGrid(locked, { password: "ab12c" })).length - 1, 3);
});

test("a scan has no text table; the balance check finds a misread amount", async () => {
  assert.equal(await statementPdfToGrid(await scanLikePdf()), null);

  const csv = "Date,Narration,Withdrawal,Deposit,Balance\n01/11/2026,A,,1000.00,11000.00\n02/11/2026,B,500.00,,10500.00\n03/11/2026,C,250.00,,10200.00\n";
  const check = checkRunningBalances(parseBankStatementXlsx({ buffer: Buffer.from(csv), bankAccountId: "acc" }));
  assert.equal(check.breakCount, 1);
  assert.deepEqual(check.breaks[0], { date: "2026-11-03", description: "C", expected: 10250, printed: 10200 });
});

test("Excel / CSV shapes: account details above the header, one Amount column, newest first, month names", () => {
  const top = Array.from({ length: 18 }, (_, i) => `Account detail line ${i},,,,`).join("\n");
  const csv = `${top}\nTxn Date,Description,Amount,Dr/Cr,Balance\n05-Nov-2026,NEFT CR,500.00,CR,1300.00\n04-Nov-2026,ATM WDL,200.00,DR,800.00\n03-Nov-2026,CHARGES,,,\n03-Nov-2026,UPI,100.00,,1000.00\n02-Nov-2026,OPENING,,,1100.00\n`;
  const rows = parseBankStatementXlsx({ buffer: Buffer.from(csv), bankAccountId: "acc" });
  assert.deepEqual(rows.map((r) => [r.transactionDate.toISOString().slice(0, 10), r.direction, r.amount]), [
    ["2026-11-05", "INFLOW", 500],
    ["2026-11-04", "OUTFLOW", 200],
    ["2026-11-03", "OUTFLOW", 100], // no Dr / Cr printed: the balance fell 1,100 -> 1,000
  ]);
  assert.equal(checkRunningBalances(rows).order, "DESC");
});

test("two identical rows in one file are both kept; a re-import still skips them", () => {
  const csv = "Date,Narration,Withdrawal,Deposit,Balance\n02/11/2026,UPI CHARGES,10.00,,990.00\n02/11/2026,UPI CHARGES,10.00,,980.00\n";
  const a = parseBankStatementXlsx({ buffer: Buffer.from(csv), bankAccountId: "acc" });
  const b = parseBankStatementXlsx({ buffer: Buffer.from(csv), bankAccountId: "acc" });
  assert.equal(new Set(a.map((r) => r.importFingerprint)).size, 2);
  assert.deepEqual(a.map((r) => r.importFingerprint), b.map((r) => r.importFingerprint));
});

test("import through the service: text PDF, scan read by a fake Claude, and a scan without the reader", { skip: !process.env.TEST_MONGO_URI && "TEST_MONGO_URI not set" }, async () => {
  const mongoose = require("mongoose");
  assert.ok(!/27018\/billstack(\?|$)/.test(process.env.TEST_MONGO_URI), "Refusing to run against the live BillStack database");
  await mongoose.connect(process.env.TEST_MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  const savedKey = process.env.ANTHROPIC_API_KEY;
  try {
    const Business = require("../src/models/Business");
    const BankAccount = require("../src/models/BankAccount");
    const { importBankStatementFile } = require("../src/services/bank-reconciliation.service");
    const uid = crypto.randomBytes(5).toString("hex");
    const business = await Business.create({ name: `Bank ${uid}`, slug: `bank-${uid}`, deploymentMode: "SELF_HOSTED" });
    const bank = await BankAccount.create({ businessId: business._id, accountName: "Current", bankName: "Sample", accountNumber: `00${uid}` });

    const pdf = await makeStatementPdf(statementRows(12));
    const first = await importBankStatementFile({ businessId: business._id, bankAccountId: bank._id, fileBase64: pdf.toString("base64"), fileName: "statement.pdf" });
    assert.equal(first.source, "PDF_TEXT");
    assert.equal(first.importedCount, 12);
    assert.equal(first.balanceCheck.breakCount, 0);
    const again = await importBankStatementFile({ businessId: business._id, bankAccountId: bank._id, fileBase64: pdf.toString("base64"), fileName: "statement.pdf" });
    assert.equal(again.importedCount, 0);
    assert.equal(again.duplicateCount, 12);

    const scan = (await scanLikePdf()).toString("base64");
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(importBankStatementFile({ businessId: business._id, bankAccountId: bank._id, fileBase64: scan, fileName: "scan.pdf" }), /is a scan/);

    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    let request;
    claude.setClientFactoryForTests(() => ({
      beta: {
        messages: {
          stream: (req) => {
            request = req;
            const answer = { isStatement: true, unclear: "row 2 smudged", rows: [
              { date: "2026-12-01", description: "NEFT CR ACME", reference: "", debit: null, credit: 5000, balance: 15000 },
              { date: "2026-12-02", description: "ATM WDL", reference: "", debit: 2000, credit: null, balance: 13000 },
            ] };
            return { finalMessage: async () => ({ stop_reason: "end_turn", model: "claude-opus-5-5", usage: {}, content: [{ type: "text", text: JSON.stringify(answer) }] }) };
          },
        },
      },
    }));
    const read = await importBankStatementFile({ businessId: business._id, bankAccountId: bank._id, fileBase64: scan, fileName: "scan.pdf" });
    assert.equal(read.source, "PDF_READ_BY_AI");
    assert.equal(read.importedCount, 2);
    assert.equal(read.unclear, "row 2 smudged");
    assert.equal(read.balanceCheck.breakCount, 0);
    assert.equal(request.messages[0].content[0].type, "document");
    assert.equal(request.max_tokens, 64000);
  } finally {
    claude.setClientFactoryForTests(null);
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
