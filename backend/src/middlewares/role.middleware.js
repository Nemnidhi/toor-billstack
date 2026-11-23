const AppError = require("../utils/appError");

const permit = (...allowedRoles) => (req, _res, next) => {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }

  // An auditor reads what staff or accountants read, and acts as an accountant in granted areas.
  const auditor = require("./auditor");
  const asAuditor = req.user.role === "auditor" && auditor.effectiveRole(req) &&
    (allowedRoles.includes("accountant") || (auditor.isRead(req) && allowedRoles.includes("staff")));
  if (!allowedRoles.includes(req.user.role) && !asAuditor) {
    throw new AppError("You do not have permission to perform this action", 403);
  }

  next();
};

module.exports = {
  permit,
};

