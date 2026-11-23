const crypto = require("crypto");

// Time-based one-time codes (RFC 6238: 30-second steps, 6 digits, HMAC-SHA1) - what Google
// Authenticator, Microsoft Authenticator and similar apps show.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

const base32Decode = (text) => {
  const clean = String(text || "").toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

/** A new random secret (160 bits), base32 as the authenticator apps expect. */
const generateSecret = () => base32Encode(crypto.randomBytes(20));

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

const codeAt = (secret, step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(number).padStart(6, "0");
};

/**
 * The step a code belongs to (the one before, now, or the one after, for clock drift), or null.
 * A step at or before `afterStep` is refused, so one code can't be used twice.
 */
const verifyCode = (secret, code, { now = Date.now(), afterStep = -1 } = {}) => {
  const given = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given) || !secret) return null;
  const step = currentStep(now);
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate <= afterStep) continue;
    const expected = codeAt(secret, candidate);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return candidate;
  }
  return null;
};

const otpauthUrl = ({ secret, account, issuer = "BillStack" }) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

module.exports = { base32Decode, base32Encode, codeAt, currentStep, generateSecret, otpauthUrl, verifyCode };
