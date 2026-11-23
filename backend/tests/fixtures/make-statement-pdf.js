// Builds a bank-statement-like PDF (bank header, a table that runs over pages with the header
// repeated, wrapped narrations, a summary at the end) for the statement PDF tests.
const pdfMake = require("pdfmake/build/pdfmake");
pdfMake.vfs = require("pdfmake/build/vfs_fonts");

const money = (n) => (n ? Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");

/** rows: [{ date: "05/11/26", narration, ref, debit, credit, balance }] */
const makeStatementPdf = (rows, { userPassword } = {}) =>
  new Promise((resolve) => {
    const body = [
      ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"].map((text) => ({ text, bold: true })),
      ...rows.map((r) => [r.date, r.narration, r.ref || "", r.date, money(r.debit), money(r.credit), money(r.balance)].map((text, i) => ({ text, alignment: i >= 4 ? "right" : "left" }))),
    ];
    const doc = {
      pageSize: "A4",
      pageMargins: [24, 40, 24, 40],
      defaultStyle: { fontSize: 7.5 },
      content: [
        { text: "SAMPLE BANK LTD", fontSize: 12, bold: true },
        { text: "Statement of account  |  A/c No: XXXXXXXX4521  |  From: 01/11/2026 To: 30/11/2026", margin: [0, 2, 0, 2] },
        { text: "Opening Balance: 1,00,000.00", margin: [0, 0, 0, 8] },
        { table: { headerRows: 1, widths: [40, 170, 62, 38, 55, 55, 60], body }, layout: "noBorders" },
        { text: "STATEMENT SUMMARY", bold: true, margin: [0, 12, 0, 2] },
        { text: "Opening Balance 1,00,000.00   Dr Count 3   Cr Count 2   Closing Bal 1,23,450.00" },
        { text: "This is a computer generated statement and does not require a signature." },
      ],
      footer: (page, pages) => ({ text: `Page ${page} of ${pages}`, alignment: "center", fontSize: 7 }),
    };
    if (userPassword) doc.userPassword = userPassword;
    pdfMake.createPdf(doc).getBuffer((buffer) => resolve(Buffer.from(buffer)));
  });

module.exports = { makeStatementPdf };
