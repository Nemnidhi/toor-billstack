const crypto = require("crypto");

// Secrets a business keeps in BillStack (its own Razorpay key secret and webhook secret) are stored
// encrypted with BILLSTACK_DATA_KEY (64 hex characters, set on the server only). Without that key no
// such secret can be saved.
const keyFromEnv = () => {
  const hex = String(process.env.BILLSTACK_DATA_KEY || "").trim();
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
};

const canSeal = () => Boolean(keyFromEnv());

/** "v1:<iv>:<tag>:<ciphertext>" (base64 parts), AES-256-GCM. */
const seal = (plain) => {
  const key = keyFromEnv();
  if (!key) throw new Error("BILLSTACK_DATA_KEY is not set on the server");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
};

const open = (sealed) => {
  if (!sealed) return "";
  const key = keyFromEnv();
  if (!key) throw new Error("BILLSTACK_DATA_KEY is not set on the server");
  const [version, iv, tag, body] = String(sealed).split(":");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Stored secret is not readable");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
};

module.exports = { canSeal, open, seal };
