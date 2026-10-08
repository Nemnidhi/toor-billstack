const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

// Stub the Customer model: Customer.find(query) -> chainable over an in-memory list.
let customers = [];
const matches = (row, query) => Object.entries(query).every(([key, cond]) => {
  if (key === "businessId") return true;
  if (cond && cond.$regex) return cond.$regex.test(row[key] || "");
  return row[key] === cond;
});
const chain = (rows) => { const c = { sort: () => c, limit: () => c, select: () => c, session: async () => rows }; return c; };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request.endsWith("/models/Customer")) return { find: (query) => chain(customers.filter((row) => matches(row, query))) };
  return originalLoad.call(this, request, ...rest);
};
const { findCustomerIdentityMatches } = require("../src/services/integration.service");
const find = (input) => findCustomerIdentityMatches({ businessId: "b", session: null, input: { gstNumber: "", phone: "", email: "", ...input } });

test("same person with no contact details is reused, not listed twice", async () => {
  customers = [{ _id: "1", name: "Raj Thakur", phone: "", email: "", gstNumber: "" }];
  assert.equal((await find({ name: "RAJ  thakur" }))?._id, "1");
});
test("same name with a different phone is a different customer", async () => {
  customers = [{ _id: "1", name: "Raj Thakur", phone: "9811111111", email: "", gstNumber: "" }];
  assert.equal(await find({ name: "Raj Thakur", phone: "9822222222" }), null);
});
test("phone formatting and country code do not create a duplicate", async () => {
  customers = [{ _id: "1", name: "Somil jain", phone: "+91 98111 11111", email: "", gstNumber: "" }];
  assert.equal((await find({ name: "Somil Jain", phone: "919811111111" }))?._id, "1");
});
test("conflicting GSTIN keeps customers apart", async () => {
  customers = [{ _id: "1", name: "Acme", phone: "", email: "", gstNumber: "23AAAAA0000A1Z5" }];
  assert.equal(await find({ name: "Acme", gstNumber: "27BBBBB1111B1Z5" }), null);
});
test("an already-duplicated name resolves to the oldest, never a third copy", async () => {
  customers = [{ _id: "1", name: "Raj Thakur", phone: "", email: "", gstNumber: "" }, { _id: "2", name: "Raj Thakur", phone: "", email: "", gstNumber: "" }];
  assert.equal((await find({ name: "Raj Thakur" }))?._id, "1");
});
test("different names sharing a phone are not merged", async () => {
  customers = [{ _id: "1", name: "Priya Shah", phone: "9811111111", email: "", gstNumber: "" }];
  assert.equal(await find({ name: "Rohit Mehta", phone: "9811111111" }), null);
});

const fs = require("node:fs");
const path = require("node:path");
const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");
test("a cancelled invoice releases its CRM source so the corrected invoice can be issued", () => {
  const controller = read("controllers", "invoice.controller.js");
  assert.match(controller, /releaseCancelledCrmSource\(crmSourceRef/);
  assert.match(controller, /\$rename: \{ crmSourceRef: "voidedCrmSourceRef" \}/);
  assert.match(read("services", "integration.service.js"), /status: \{ \$ne: "cancelled" \}/);
});
