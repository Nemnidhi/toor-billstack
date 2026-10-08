const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const root = { _id: "root1", name: "TOOR", billingEntityCode: "", billingParentId: null };
const stubs = {
  "../models/Business": {
    findById: async () => root,
    find: async () => [root],
  },
  "../services/billing-entity.service": {
    listEntities: async () => [{ id: "root1" }],
    resolveEntityUser: async () => ({ role: "owner" }),
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  for (const [key, value] of Object.entries(stubs)) if (request === key || request.endsWith(key.replace("..", ""))) return value;
  return load.call(this, request, ...rest);
};
const { authorizeAccountingReport } = require("../src/middlewares/accounting-access.middleware");

test("consolidated view falls back to the single company when there is no Goldhawk entity", async () => {
  const req = { query: { entity: "all" }, headers: {}, user: { role: "owner", businessId: "root1" } };
  let nextArg = "unset";
  await authorizeAccountingReport(req, {}, (arg) => { nextArg = arg; });
  assert.equal(nextArg, undefined, "no error is raised");
  assert.equal(req.accountingScope.isConsolidated, false);
  assert.equal(req.accountingScope.businessId, "root1");
});
