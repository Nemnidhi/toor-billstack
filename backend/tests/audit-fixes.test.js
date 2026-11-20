// Checks for the 20 Nov 2026 audit fixes that need no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const frontend = (...parts) => fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", ...parts), "utf8");

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

// ---------------------------------------------------------------- scripts
test("maintenance scripts: no default passwords, no printed database passwords, wipe needs confirmation", () => {
  const guard = require("../src/scripts/lib/script-guard");
  assert.equal(guard.redactMongoUri("mongodb://bill:s3cret@127.0.0.1:27018/billstack?replicaSet=rs0"), "mongodb://bill:****@127.0.0.1:27018/billstack?replicaSet=rs0");
  assert.equal(guard.databaseNameOf("mongodb://127.0.0.1:27018/billstack?replicaSet=rs0"), "billstack");

  assert.throws(() => guard.requireOwnerPassword({}), /no default password/);
  assert.throws(() => guard.requireOwnerPassword({ OWNER_PASSWORD: "Admin@1234" }), /too weak/);
  assert.equal(guard.requireOwnerPassword({ OWNER_PASSWORD: "a-long-unique-passphrase" }), "a-long-unique-passphrase");

  const uri = "mongodb://127.0.0.1:27018/billstack";
  assert.throws(() => guard.requireDestructiveConfirmation({ scriptName: "x", mongoUri: uri, argv: [], env: {} }), /--confirm=billstack/);
  assert.throws(
    () => guard.requireDestructiveConfirmation({ scriptName: "x", mongoUri: uri, argv: ["--confirm=billstack"], env: { NODE_ENV: "production" } }),
    /BILLSTACK_ALLOW_DESTRUCTIVE_SCRIPTS/
  );
  assert.equal(
    guard.requireDestructiveConfirmation({ scriptName: "x", mongoUri: uri, argv: ["--confirm=billstack"], env: { NODE_ENV: "production", BILLSTACK_ALLOW_DESTRUCTIVE_SCRIPTS: "true" } }),
    "billstack"
  );

  for (const script of ["fresh-reset.js", "init-workspace.js"]) {
    const source = read("src", "scripts", script);
    assert.doesNotMatch(source, /Admin@1234/, `${script} has no built-in password`);
    assert.doesNotMatch(source, /console\.log\([^)]*ownerPassword\)/, `${script} never prints the password`);
    assert.doesNotMatch(source, /console\.log\("Connecting to database:", mongoUri\)/, `${script} never prints the connection string`);
    assert.doesNotMatch(source, /27018\/billstack/, `${script} never guesses the live database`);
  }
  assert.match(read("src", "scripts", "fresh-reset.js"), /requireDestructiveConfirmation\(/);
  assert.match(read("src", "scripts", "init-workspace.js"), /existingOwner \|\| resetOwnerPassword \? requireOwnerPassword\(\) : null/);
  assert.match(read("src", "scripts", "seed.js"), /BILLSTACK_ALLOW_DEMO_SEED/);
});

// ---------------------------------------------------------------- recurring dates
test("recurring dates keep the billing day and clamp short months", () => {
  const { addInterval } = require("../src/services/workflow.service");
  const iso = (value) => value.toISOString();
  const jan31 = new Date("2026-01-31T00:00:00.000Z");
  assert.equal(iso(addInterval(jan31, "MONTHLY", 1, jan31)), "2026-02-28T00:00:00.000Z");
  assert.equal(iso(addInterval(new Date("2026-02-28T00:00:00.000Z"), "MONTHLY", 1, jan31)), "2026-03-31T00:00:00.000Z");
  // Stored as India midnight (18:30 UTC the day before) works the same way.
  assert.equal(iso(addInterval(new Date("2026-01-30T18:30:00.000Z"), "MONTHLY", 1, new Date("2026-01-30T18:30:00.000Z"))), "2026-02-27T18:30:00.000Z");
  assert.equal(iso(addInterval(new Date("2028-02-29T00:00:00.000Z"), "YEARLY", 1)), "2029-02-28T00:00:00.000Z");
  assert.equal(iso(addInterval(new Date("2026-11-30T00:00:00.000Z"), "QUARTERLY", 1)), "2027-02-28T00:00:00.000Z");
});

test("the worker runs each job for each company on its own", () => {
  const worker = read("src", "workers", "reminder-worker.js");
  assert.match(worker, /const step = async \(name, businessId, fn\)/);
  assert.match(worker, /step\("recurring-invoices"/);
  const workflow = read("src", "services", "workflow.service.js");
  assert.match(workflow, /One profile that cannot be billed must never hold up the others/);
  assert.match(workflow, /RECURRING_PROFILE_PAUSED/);
});

// ---------------------------------------------------------------- invoices in the books
test("every way an invoice is created posts it to the journal", () => {
  assert.match(read("src", "services", "workflow.service.js"), /accountingService\.postInvoiceJournalEntry\(\{ invoice, business, userId, session \}\)/);
  assert.match(read("src", "services", "quote.service.js"), /accountingService\.postInvoiceJournalEntry\(\{ invoice, business, userId, session \}\)/);
  assert.match(read("src", "services", "integration.service.js"), /accountingService\.postInvoiceJournalEntry\(\{ invoice, business, userId: credential\.createdBy, session \}\)/);
  const controller = read("src", "controllers", "invoice.controller.js");
  assert.match(controller, /repostEditedInvoiceJournalEntry\(/);
  assert.match(controller, /rebookInvoiceReceivable\(/);
  assert.match(controller, /action: "INVOICE_EDITED"/);
});

// ---------------------------------------------------------------- search
test("search text is matched literally and never crashes the request", () => {
  const { buildSearchFilter } = require("../src/utils/queryFeatures");
  const { searchRegex, MAX_SEARCH_LENGTH } = require("../src/utils/search");
  for (const typed of ["+91 98260", "(", "a*", "[", "\\", "?"]) {
    const filter = buildSearchFilter(typed, ["name"]);
    assert.ok(filter.$or[0].name.test(`x${typed}y`), `finds "${typed}" literally`);
  }
  assert.deepEqual(buildSearchFilter({ $gt: "" }, ["name"]), {});
  assert.deepEqual(buildSearchFilter("   ", ["name"]), {});
  assert.equal(String(buildSearchFilter(["first", "second"], ["name"]).$or[0].name), "/first/i");
  assert.equal(searchRegex("x".repeat(500)).source.length, MAX_SEARCH_LENGTH);
  assert.doesNotMatch(read("src", "services", "expense.service.js"), /new RegExp\(String\(query\.search\)/);
  assert.doesNotMatch(read("src", "services", "workflow.service.js"), /\$regex: String\(query\.search\)/);
});

// ---------------------------------------------------------------- messages
test("a message that keeps failing stops being retried", () => {
  const source = read("src", "services", "communication.service.js");
  assert.match(source, /retryCount >= MAX_DELIVERY_ATTEMPTS \? null/);
  assert.doesNotMatch(source, /nextRetryAt: new Date\(Date\.now\(\) \+ 60000\)/);
});

// ---------------------------------------------------------------- errors
const runErrorHandler = (error, env = "production") =>
  withEnv({ NODE_ENV: env }, () => {
    const { errorHandler } = require("../src/middlewares/error.middleware");
    let status = 0;
    let body = null;
    const res = { status(code) { status = code; return this; }, json(payload) { body = payload; return this; } };
    errorHandler(error, { requestId: "req-1", originalUrl: "/api/x", method: "GET", get: () => "" }, res, () => {});
    return { status, body };
  });

test("errors reach people as plain messages with the right status", async () => {
  const AppError = require("../src/utils/appError");
  const duplicate = Object.assign(new Error("E11000 duplicate key error collection: billstack.invoices index: businessId_1_invoiceNumber_1"), { code: 11000, keyPattern: { businessId: 1, invoiceNumber: 1 }, keyValue: { invoiceNumber: "INV-1" } });
  let result = await runErrorHandler(duplicate);
  assert.equal(result.status, 409);
  assert.match(result.body.message, /invoice number already exists/);
  assert.doesNotMatch(result.body.message, /E11000|billstack\./);

  result = await runErrorHandler(new TypeError("Cannot read properties of undefined (reading 'gstNumber')"));
  assert.equal(result.status, 500);
  assert.match(result.body.message, /Something went wrong on the server/);
  assert.match(result.body.message, /req-1/);
  assert.equal(result.body.stack, undefined);

  result = await runErrorHandler(new AppError("SMS provider is not configured", 503));
  assert.equal(result.body.message, "SMS provider is not configured");

  result = await runErrorHandler(Object.assign(new Error("request entity too large"), { type: "entity.too.large", status: 413 }));
  assert.equal(result.status, 413);
  assert.match(result.body.message, /too large/);
});

// ---------------------------------------------------------------- server / limits / health
test("the API exits cleanly on an uncaught exception so systemd restarts it", () => {
  const server = read("src", "server.js");
  assert.match(server, /shutdown\("uncaughtException", 1\)/);
});

test("rate limits are per signed-in session and only failed sign-ins count", () => {
  const source = read("src", "middlewares", "rate-limit.middleware.js");
  assert.match(source, /skipSuccessfulRequests: true/);
  assert.match(source, /keyGenerator: sessionKey/);
  const { apiRateLimiter } = require("../src/middlewares/rate-limit.middleware");
  assert.ok(Array.isArray(apiRateLimiter) && apiRateLimiter.length === 2);
});

test("bank statements up to 5 MB can be imported; raw bodies are kept only for webhooks", () => {
  const app = read("src", "app.js");
  assert.match(app, /statementJsonParser = express\.json\(\{ limit: "8mb" \}\)/);
  assert.match(app, /req\.originalUrl\.includes\("\/webhooks\/"\)/);
  const page = frontend("features", "accounting", "pages", "ReconciliationTab.jsx");
  assert.match(page, /const handleFileUpload = \(e\) =>/, "the upload handler the page uses exists");
  assert.match(page, /MAX_STATEMENT_BYTES = 5 \* 1024 \* 1024/);
});

test("health checks show details only on the server itself", async () => {
  const { getHealth, getReadiness } = require("../src/controllers/health.controller");
  const call = (handler, ip) =>
    new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { resolve(payload); return this; } };
      Promise.resolve(handler({ ip, socket: { remoteAddress: ip }, get: () => "" }, res, reject)).catch(reject);
    });
  const outside = await call(getHealth, "203.0.113.9");
  assert.deepEqual(Object.keys(outside).sort(), ["service", "status", "timestamp"]);
  const local = await call(getHealth, "127.0.0.1");
  assert.ok(local.memory);
  const readiness = await call(getReadiness, "203.0.113.9");
  assert.equal(readiness.checks, undefined);
});

test("super-admin tokens use their own key and audience", async () => {
  await withEnv({ JWT_SECRET: "user-token-secret-for-tests", SUPER_ADMIN_JWT_SECRET: undefined }, () => {
    const jwt = require("jsonwebtoken");
    const { signSuperAdminToken, verifySuperAdminToken } = require("../src/services/super-admin.service");
    const token = signSuperAdminToken({ role: "super_admin", email: "a@b.c" });
    assert.equal(verifySuperAdminToken(token).role, "super_admin");
    assert.throws(() => jwt.verify(token, "user-token-secret-for-tests"), "not signed with the user-token key");
    const userKeyToken = jwt.sign({ role: "super_admin" }, "user-token-secret-for-tests");
    assert.throws(() => verifySuperAdminToken(userKeyToken));
  });
  assert.match(read("src", "controllers", "super-admin.controller.js"), /SUPER_ADMIN_PASSWORD_HASH/);
});

test("sessions: two tabs refreshing together are not treated as theft; password resets sign out other devices", () => {
  const controller = read("src", "controllers", "auth.controller.js");
  assert.match(controller, /graceRecord = await findGraceReplacement\(tokenRecord\)/);
  assert.match(controller, /await revokeAllUserRefreshTokens\(user\._id\)/);
  assert.match(read("src", "controllers", "team.controller.js"), /revokeAllUserRefreshTokens\(teamMember\._id\)/);
});

test("a damaged saved session cannot stop the app from starting", () => {
  for (const store of ["authStore.js", "superAdminStore.js"]) {
    const source = frontend("store", store);
    assert.match(source, /try \{\s*const raw = localStorage\.getItem/);
  }
});
