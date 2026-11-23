const Anthropic = require("@anthropic-ai/sdk");
const AppError = require("./appError");

// One place for the Claude API: reading bill photos (expenses) and scanned bank statements.
// The key is ANTHROPIC_API_KEY in the server's environment (set by the owner); it is never stored
// in the database or sent to the browser.

const MODEL = process.env.BILL_READER_MODEL || "claude-opus-5-5";
// Reading documents needs little reasoning; low effort keeps each read cheap and quick.
const EFFORT = process.env.BILL_READER_EFFORT || "low";

const makeClient = () => new Anthropic({ timeout: 10 * 60_000, maxRetries: 2 });
let clientFactory = makeClient;
/** Tests replace the API client. */
const setClientFactoryForTests = (factory) => {
  clientFactory = factory || makeClient;
};
const getClient = () => clientFactory();
const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** Request fields shared by every read: model, effort, a JSON schema answer, server-side fallback. */
const baseRequest = ({ schema, maxTokens }) => {
  const request = { model: MODEL, max_tokens: maxTokens, output_config: { effort: EFFORT, format: { type: "json_schema", schema } } };
  // If the model declines, the API retries on Anthropic's recommended model in the same call.
  // Haiku has no server-side fallback, so it is left out there.
  if (!/haiku/.test(MODEL)) Object.assign(request, { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
  return request;
};

/** Turns SDK errors into messages a person can act on. */
const friendlyError = (error) => {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AppError("Reading documents is not working: the server's Anthropic key was refused. Ask the owner to check it.", 503);
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.OverloadedError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) {
    return new AppError("The document reader is busy. Try again in a minute.", 503);
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.ContentTooLargeError) {
    return new AppError("This file could not be read. Try a clearer copy.", 422);
  }
  return error;
};

/** The JSON answer of a finished response, or a clear error. */
const jsonAnswer = (response, what = "document") => {
  if (response.stop_reason === "refusal") throw new AppError(`The reader would not read this ${what}.`, 422);
  if (response.stop_reason === "max_tokens") throw new AppError(`The ${what} was too long to read in one go. Split it and try again.`, 422);
  const text = (response.content || []).filter((block) => block.type === "text").map((block) => block.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("The reader gave an answer that could not be used. Try again.", 502);
  }
};

module.exports = { Anthropic, MODEL, EFFORT, baseRequest, friendlyError, getClient, isConfigured, jsonAnswer, setClientFactoryForTests };
