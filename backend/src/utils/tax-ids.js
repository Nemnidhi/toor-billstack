const AppError = require("./appError");
const { PAN_PATTERN, TAN_PATTERN, tdsKind } = require("../constants/tds");

// PAN / TAN as typed: blank is allowed; anything else must be the right shape.
const normalizePan = (value, who = "PAN") => {
  const text = String(value || "").trim().toUpperCase();
  if (text && !PAN_PATTERN.test(text)) throw new AppError(`${who} must be 10 characters like ABCDE1234F`, 400);
  return text;
};

const normalizeTan = (value) => {
  const text = String(value || "").trim().toUpperCase();
  if (text && !TAN_PATTERN.test(text)) throw new AppError("TAN must be 10 characters like BPLA12345B", 400);
  return text;
};

const normalizeTdsKind = (value) => {
  const text = String(value || "").trim().toUpperCase();
  if (text && !tdsKind(text)) throw new AppError("Unknown TDS type", 400);
  return text;
};

module.exports = { normalizePan, normalizeTan, normalizeTdsKind };
