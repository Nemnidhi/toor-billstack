const AppError = require("../utils/appError");
const { AUDITOR_GRANTS, ALWAYS_ALLOWED } = require("../constants/auditor-grants");

// Read-only access for the auditor role (client D11). See constants/auditor-grants.js.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const pathOf = (req) => String(req.originalUrl || `${req.baseUrl || ""}${req.path || ""}`).split("?")[0];

const isRead = (req) => READ_METHODS.has(String(req.method || "").toUpperCase());

/** The person's grants (kept on their own login, whichever business they are working in). */
const grantsOf = (req) => (Array.isArray(req.identityUser?.permissions?.grants) ? req.identityUser.permissions.grants : []);

/** True when this request falls inside an area the auditor has been granted. */
const isGranted = (req) => {
  const path = pathOf(req);
  const mine = new Set(grantsOf(req));
  return AUDITOR_GRANTS.some((grant) => mine.has(grant.key) && grant.paths.some((re) => re.test(path)));
};

/**
 * The role an auditor acts with on this request: "accountant" for reads and for granted areas,
 * otherwise null (no access). Any other role is returned as is.
 */
const effectiveRole = (req, role = req.user?.role) => {
  if (role !== "auditor") return role;
  return isRead(req) || isGranted(req) ? "accountant" : null;
};

/** Stops an auditor's writes outside the granted areas, before any route runs. */
const auditorGate = (req) => {
  if (req.user?.role !== "auditor" || isRead(req)) return;
  if (ALWAYS_ALLOWED.some((re) => re.test(pathOf(req))) || isGranted(req)) return;
  throw new AppError("Your access is read-only. Ask the owner to give you this area in Team if you need to change it.", 403);
};

module.exports = { auditorGate, effectiveRole, isGranted, isRead, grantsOf };
