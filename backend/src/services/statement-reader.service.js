const AppError = require("../utils/appError");
const { log } = require("../utils/logger");
const claude = require("../utils/claude-client");

// Scanned bank statements (a PDF with no text) read by Claude into the same grid an Excel statement
// gives. Only used when the PDF's own text has no statement table and the owner has switched on
// document reading (ANTHROPIC_API_KEY). Every row is then checked against the running balance.

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isStatement", "rows", "unclear"],
  properties: {
    isStatement: { type: "boolean" },
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "description", "reference", "debit", "credit", "balance"],
        properties: {
          date: { type: "string", format: "date", description: "transaction date, YYYY-MM-DD (Indian statements write day first)" },
          description: { type: "string", description: "the narration / particulars in full" },
          reference: { type: "string", description: "cheque / reference / UTR number if in its own column; else empty" },
          debit: nullable({ type: "number", description: "withdrawal amount" }),
          credit: nullable({ type: "number", description: "deposit amount" }),
          balance: nullable({ type: "number", description: "balance after the row; negative if marked Dr / overdrawn" }),
        },
      },
    },
    unclear: { type: "string" },
  },
};

const PROMPT = `This is a bank statement. List every transaction row in the order printed, across all pages.
- Copy amounts exactly as printed, as plain numbers. Do not skip, merge or invent rows.
- Leave out opening / closing balance lines, page totals and summaries.
- Dates are day first (05/11/26 is 5 November 2026).
- If this is not a bank statement, set isStatement to false and rows to [].
- Say in "unclear" which rows are hard to read.`;

/** A scanned statement PDF as a grid: [header, ...rows]. */
const readScannedStatement = async ({ buffer }) => {
  if (!claude.isConfigured()) {
    throw new AppError("This PDF is a scan, with no text to read. Download the statement as Excel or CSV from net banking, or ask the owner to switch on document reading (an Anthropic API key on the server).", 400);
  }
  const request = {
    ...claude.baseRequest({ schema: SCHEMA, maxTokens: 64000 }),
    messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } }, { type: "text", text: PROMPT }] }],
  };
  const startedAt = Date.now();
  let response;
  try {
    // A long statement is a long answer: stream it so the request does not time out.
    response = await claude.getClient().beta.messages.stream(request).finalMessage();
  } catch (error) {
    throw claude.friendlyError(error);
  }
  const answer = claude.jsonAnswer(response, "statement");
  if (!answer.isStatement) throw new AppError("This PDF does not look like a bank statement.", 422);
  log("info", "statement read", { model: response.model, ms: Date.now() - startedAt, rows: answer.rows.length, inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens });
  const cell = (n) => (n === null || n === undefined ? "" : String(n));
  return {
    grid: [["Date", "Narration", "Ref No", "Withdrawal", "Deposit", "Balance"], ...answer.rows.map((r) => [r.date, r.description, r.reference, cell(r.debit), cell(r.credit), cell(r.balance)])],
    unclear: answer.unclear || "",
  };
};

module.exports = { readScannedStatement };
