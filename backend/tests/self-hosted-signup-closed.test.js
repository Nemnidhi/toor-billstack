const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isPublicSignupOpen } = require("../src/constants/modules");
const { googleAuth, register, signupStatus } = require("../src/controllers/auth.controller");

const frontend = (...parts) => fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", ...parts), "utf8");

const invoke = (handler, req = {}) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload });
      },
    };
    Promise.resolve(handler({ body: {}, ...req }, res, reject)).catch(reject);
  });

const withEnv = async (values, fn) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const SELF_HOSTED = { BILLSTACK_DEPLOYMENT_MODE: "SELF_HOSTED", BILLSTACK_ALLOW_SIGNUP: undefined };

test("a self-hosted install is closed to new workspaces unless BILLSTACK_ALLOW_SIGNUP=true", async () => {
  await withEnv(SELF_HOSTED, () => assert.equal(isPublicSignupOpen(), false));
  await withEnv({ ...SELF_HOSTED, BILLSTACK_ALLOW_SIGNUP: "true" }, () => assert.equal(isPublicSignupOpen(), true));
  await withEnv({ BILLSTACK_DEPLOYMENT_MODE: undefined, BILLSTACK_ALLOW_SIGNUP: undefined }, () => assert.equal(isPublicSignupOpen(), true));
});

test("self-hosted: register is refused before anything is created", async () => {
  await withEnv(SELF_HOSTED, async () => {
    await assert.rejects(
      invoke(register, { body: { name: "Stranger", email: "x@example.com", password: "Secret123!", businessName: "Stranger Ltd" } }),
      (error) => error.statusCode === 403 && /administrator/.test(error.message)
    );
  });
});

test("self-hosted: Google sign-up is refused before the Google token is even checked", async () => {
  await withEnv(SELF_HOSTED, async () => {
    await assert.rejects(
      invoke(googleAuth, { body: { mode: "signup", idToken: "not-checked", businessName: "Stranger Ltd" } }),
      (error) => error.statusCode === 403
    );
  });
});

test("signup-status tells the sign-in page whether to offer Create account", async () => {
  await withEnv(SELF_HOSTED, async () => {
    const result = await invoke(signupStatus);
    assert.deepEqual(result, { statusCode: 200, payload: { data: { signupOpen: false } } });
  });
  await withEnv({ ...SELF_HOSTED, BILLSTACK_ALLOW_SIGNUP: "true" }, async () => {
    assert.equal((await invoke(signupStatus)).payload.data.signupOpen, true);
  });
});

test("the sign-in page offers Create account only when the server says sign-up is open", () => {
  const login = frontend("features", "auth", "pages", "LoginPage.jsx");
  assert.match(login, /useSignupOpen\(false\)/);
  assert.match(login, /\{signupOpen \? \(/);
  const registerPage = frontend("features", "auth", "pages", "RegisterPage.jsx");
  assert.match(registerPage, /signupOpen === false/);
  assert.match(registerPage, /Ask your administrator to add you from Team/);
});
