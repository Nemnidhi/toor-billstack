// Shared guards for the maintenance scripts that touch a real database.
//
// - redactMongoUri: never print a database password to the screen or a log.
// - requireDestructiveConfirmation: a script that deletes data runs only when the
//   operator types the database name back (--confirm=<db>) and, on a production
//   install, also sets BILLSTACK_ALLOW_DESTRUCTIVE_SCRIPTS=true for that one run.
// - requireOwnerPassword: no built-in default password; the operator must supply
//   a strong one in OWNER_PASSWORD, and it is never echoed back.

const WEAK_PASSWORDS = new Set(["admin@1234", "password123", "password", "admin123", "admin@123", "12345678"]);

const redactMongoUri = (raw) => {
  if (!raw) return "(not set)";
  try {
    const url = new URL(raw);
    if (url.password) url.password = "****";
    return url.toString();
  } catch (_error) {
    return String(raw).replace(/\/\/[^@/]*@/, "//****:****@");
  }
};

const databaseNameOf = (uri) => {
  try {
    const name = new URL(uri).pathname.replace(/^\//, "");
    return name || "test";
  } catch (_error) {
    const match = String(uri || "").match(/\/([^/?]+)(\?|$)/);
    return match ? match[1] : "test";
  }
};

const isProductionInstall = (env = process.env) =>
  env.NODE_ENV === "production" || String(env.BILLSTACK_DEPLOYMENT_MODE || "").toUpperCase() === "SELF_HOSTED";

const confirmArgument = (argv = process.argv) => {
  const arg = argv.find((value) => value.startsWith("--confirm="));
  return arg ? arg.slice("--confirm=".length) : "";
};

/** Throws unless the operator has explicitly confirmed this destructive run. */
const requireDestructiveConfirmation = ({ scriptName, mongoUri, argv = process.argv, env = process.env }) => {
  const dbName = databaseNameOf(mongoUri);
  const problems = [];
  if (confirmArgument(argv) !== dbName) {
    problems.push(`Type the database name back to confirm: node ${scriptName} --confirm=${dbName}`);
  }
  if (isProductionInstall(env) && env.BILLSTACK_ALLOW_DESTRUCTIVE_SCRIPTS !== "true") {
    problems.push("This looks like a live install. For this one run also set BILLSTACK_ALLOW_DESTRUCTIVE_SCRIPTS=true, and take a backup first.");
  }
  if (problems.length) {
    const error = new Error(`${scriptName} deletes data in database "${dbName}" and was stopped.\n- ${problems.join("\n- ")}`);
    error.code = "DESTRUCTIVE_SCRIPT_NOT_CONFIRMED";
    throw error;
  }
  return dbName;
};

/** Returns OWNER_PASSWORD, or throws if it is missing or weak. */
const requireOwnerPassword = (env = process.env) => {
  const value = env.OWNER_PASSWORD || "";
  if (!value) {
    const error = new Error("Set OWNER_PASSWORD (at least 12 characters) for this run. There is no default password.");
    error.code = "OWNER_PASSWORD_MISSING";
    throw error;
  }
  if (value.length < 12 || WEAK_PASSWORDS.has(value.toLowerCase())) {
    const error = new Error("OWNER_PASSWORD is too weak: use at least 12 characters and not a well-known password.");
    error.code = "OWNER_PASSWORD_WEAK";
    throw error;
  }
  return value;
};

module.exports = {
  redactMongoUri,
  databaseNameOf,
  isProductionInstall,
  requireDestructiveConfirmation,
  requireOwnerPassword,
};
