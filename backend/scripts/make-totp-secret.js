#!/usr/bin/env node
// Makes a secret for the super admin's two-step sign-in. Run it on the server, add the secret to
// the authenticator app (type it in, or open the otpauth link as a QR code), then put it in the
// server's .env as SUPER_ADMIN_TOTP_SECRET and restart. Nothing is saved by this script.
//   node scripts/make-totp-secret.js [account name]
const totp = require("../src/utils/totp");

const secret = totp.generateSecret();
const account = process.argv[2] || "super-admin";
console.log(`Secret (type into the app): ${secret.replace(/(.{4})/g, "$1 ").trim()}`);
console.log(`otpauth link: ${totp.otpauthUrl({ secret, account, issuer: "BillStack super admin" })}`);
console.log(`Then in .env: SUPER_ADMIN_TOTP_SECRET=${secret}`);
