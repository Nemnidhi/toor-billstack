const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  STAFF: "staff",
  ACCOUNTANT: "accountant",
  // Read-only (client D11): sees what an accountant sees, changes nothing except granted areas.
  AUDITOR: "auditor",
};

module.exports = {
  ROLES,
};

