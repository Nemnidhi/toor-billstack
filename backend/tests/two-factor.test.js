// Two-step sign-in (authenticator app). DB test: TEST_MONGO_URI=<throw-away replica set> node --test tests/two-factor.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
process.env.BILLSTACK_DEPLOYMENT_MODE = "SELF_HOSTED";
process.env.NODE_ENV = "test";
process.env.BILLSTACK_DATA_KEY = crypto.randomBytes(32).toString("hex");

const mongoose = require("mongoose");
const Business = require("../src/models/Business");
const User = require("../src/models/User");
const { hashPassword, signAccessToken } = require("../src/services/auth.service");
const totp = require("../src/utils/totp");

const MONGO_URI = process.env.TEST_MONGO_URI;
let server;
let base;

test.before(async () => {
  assert.ok(MONGO_URI, "Set TEST_MONGO_URI to a throw-away replica-set database");
  assert.ok(!/27018\/billstack(\?|$)/.test(MONGO_URI), "Refusing to run against the live BillStack database");
  const app = require("../src/app");
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await require("../src/config/db").ensureBusinessIndexes();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  server?.close();
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const call = async (method, path, body, token) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const setup = async () => {
  const uid = crypto.randomBytes(5).toString("hex");
  const business = await Business.create({ name: `TOOR ${uid}`, slug: `toor-${uid}`, deploymentMode: "SELF_HOSTED", onboardingCompleted: true });
  const password = `Pw-${crypto.randomBytes(9).toString("base64url")}9`;
  const owner = await User.create({ businessId: business._id, name: "Owner", email: `owner-${uid}@example.com`, password: await hashPassword(password), role: "owner" });
  business.ownerUserId = owner._id;
  await business.save();
  const staff = await User.create({ businessId: business._id, name: "Staff", email: `staff-${uid}@example.com`, password: await hashPassword(password), role: "accountant" });
  return { business, owner, staff, password };
};

// The code for a step other than the one just used (each code works once).
const codeFor = (secret, offset = 0) => totp.codeAt(secret, totp.currentStep() + offset);

test("switching on: a pending secret, proved with a code from the app, gives ten one-time recovery codes", async () => {
  const { owner, password } = await setup();
  const token = signAccessToken(owner);
  assert.equal((await call("GET", "/auth/2fa", undefined, token)).json.data.enabled, false);
  const started = await call("POST", "/auth/2fa/setup", {}, token);
  assert.equal(started.status, 200, started.json.message);
  assert.match(started.json.data.otpauthUrl, /^otpauth:\/\/totp\//);
  const secret = started.json.data.secret;
  const stored = await User.findById(owner._id).select("+twoFactor.pendingSecretSealed").lean();
  assert.match(stored.twoFactor.pendingSecretSealed, /^v1:/, "sealed, not plain");
  assert.ok(!stored.twoFactor.pendingSecretSealed.includes(secret));

  assert.equal((await call("POST", "/auth/2fa/enable", { code: "000000" }, token)).status, 400);
  const enabled = await call("POST", "/auth/2fa/enable", { code: codeFor(secret) }, token);
  assert.equal(enabled.status, 200, enabled.json.message);
  assert.equal(enabled.json.data.recoveryCodes.length, 10);

  // Sign-in now stops after the password.
  const first = await call("POST", "/auth/login", { email: owner.email, password });
  assert.equal(first.status, 200, first.json.message);
  assert.equal(first.json.data.twoFactorRequired, true);
  assert.equal(first.json.data.accessToken, undefined, "no session before the code");
  const challenge = first.json.data.challengeToken;
  assert.equal((await call("GET", "/auth/me", undefined, challenge)).status, 401, "the challenge is not an access token");

  assert.equal((await call("POST", "/auth/login/2fa", { challengeToken: challenge, code: "123456" })).status, 401);
  const reused = await call("POST", "/auth/login/2fa", { challengeToken: challenge, code: codeFor(secret) });
  assert.equal(reused.status, 401, "the code used to switch on can't be used again");
  const done = await call("POST", "/auth/login/2fa", { challengeToken: challenge, code: codeFor(secret, 1) });
  assert.equal(done.status, 200, done.json.message);
  assert.ok(done.json.data.accessToken);
  assert.equal(done.json.data.user.twoFactorEnabled, true);

  // A recovery code works once.
  const second = (await call("POST", "/auth/login", { email: owner.email, password })).json.data.challengeToken;
  const recovery = enabled.json.data.recoveryCodes[0];
  const viaRecovery = await call("POST", "/auth/login/2fa", { challengeToken: second, code: recovery.toLowerCase() });
  assert.equal(viaRecovery.status, 200, viaRecovery.json.message);
  assert.equal(viaRecovery.json.data.recoveryLeft, 9);
  const third = (await call("POST", "/auth/login", { email: owner.email, password })).json.data.challengeToken;
  assert.equal((await call("POST", "/auth/login/2fa", { challengeToken: third, code: recovery })).status, 401);
});

test("five wrong codes lock the second step; switching off needs a code; an owner can reset someone else's", async () => {
  const { owner, staff, password } = await setup();
  const staffToken = signAccessToken(staff);
  const secret = (await call("POST", "/auth/2fa/setup", {}, staffToken)).json.data.secret;
  assert.equal((await call("POST", "/auth/2fa/enable", { code: codeFor(secret) }, staffToken)).status, 200);

  const challenge = (await call("POST", "/auth/login", { email: staff.email, password })).json.data.challengeToken;
  for (let i = 0; i < 5; i += 1) assert.equal((await call("POST", "/auth/login/2fa", { challengeToken: challenge, code: "000001" })).status, 401);
  assert.equal((await call("POST", "/auth/login/2fa", { challengeToken: challenge, code: codeFor(secret, 1) })).status, 423, "locked, even with the right code");

  assert.equal((await call("POST", "/auth/2fa/disable", {}, staffToken)).status, 423, "still locked");
  await User.updateOne({ _id: staff._id }, { $set: { "twoFactor.lockedUntil": null } });
  assert.equal((await call("POST", "/auth/2fa/disable", { code: "999999" }, staffToken)).status, 401, "a signed-in browser alone can't switch it off");

  assert.equal((await call("POST", `/team/${staff._id}/two-factor/reset`, {}, staffToken)).status, 403, "not by an accountant");
  const reset = await call("POST", `/team/${staff._id}/two-factor/reset`, {}, signAccessToken(owner));
  assert.equal(reset.status, 200, reset.json.message);
  const after = await call("POST", "/auth/login", { email: staff.email, password });
  assert.ok(after.json.data.accessToken, "password alone again after the reset");
});

test("super admin: with SUPER_ADMIN_TOTP_SECRET set, the code is required and works once", async () => {
  const secret = totp.generateSecret();
  const saved = { email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD, hash: process.env.SUPER_ADMIN_PASSWORD_HASH, totp: process.env.SUPER_ADMIN_TOTP_SECRET };
  Object.assign(process.env, { SUPER_ADMIN_EMAIL: "root@example.com", SUPER_ADMIN_PASSWORD: "root-password-for-tests", SUPER_ADMIN_TOTP_SECRET: secret });
  delete process.env.SUPER_ADMIN_PASSWORD_HASH;
  try {
    const login = (code) => call("POST", "/super-admin/login", { email: "root@example.com", password: "root-password-for-tests", code });
    assert.equal((await login()).status, 401);
    assert.equal((await login("000000")).status, 401);
    const code = codeFor(secret);
    const ok = await login(code);
    assert.equal(ok.status, 200, ok.json.message);
    assert.ok(ok.json.data.accessToken);
    assert.equal((await login(code)).status, 401, "the same code twice");
  } finally {
    for (const [key, env] of [["email", "SUPER_ADMIN_EMAIL"], ["password", "SUPER_ADMIN_PASSWORD"], ["hash", "SUPER_ADMIN_PASSWORD_HASH"], ["totp", "SUPER_ADMIN_TOTP_SECRET"]]) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  }
});
