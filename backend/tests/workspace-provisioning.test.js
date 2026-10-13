const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Business = require("../src/models/Business");
const User = require("../src/models/User");
const selfHosted = require("../src/services/self-hosted-profile.service");
const plans = require("../src/services/commercial-plan.service");

const stub = (target, name, impl) => { const original = target[name]; target[name] = impl; return () => { target[name] = original; }; };

const load = () => {
  delete require.cache[require.resolve("../src/services/workspace-provisioning.service")];
  return require("../src/services/workspace-provisioning.service");
};

test("a client workspace is a new, separate business with its own owner", async () => {
  const businesses = [];
  const users = [];
  const restores = [
    stub(Business, "exists", async () => null),
    stub(Business, "create", async (doc) => { const row = { ...doc, _id: new mongoose.Types.ObjectId(), save: async () => {} }; businesses.push(row); return row; }),
    stub(Business, "deleteOne", async () => {}),
    stub(User, "exists", async () => null),
    stub(User, "create", async (doc) => { const row = { ...doc, _id: new mongoose.Types.ObjectId() }; users.push(row); return row; }),
    stub(User, "deleteOne", async () => {}),
    stub(selfHosted, "ensureSelfHostedBusinessProfile", async (business) => business),
    stub(plans, "startTrialForNewBusiness", async () => null),
  ];
  try {
    const { createClientWorkspace } = load();
    const result = await createClientWorkspace({ businessName: "Sharma Realty", ownerName: "Ravi Sharma", ownerEmail: "Ravi@Example.com", password: "Str0ng-pass" });
    assert.equal(businesses.length, 1);
    assert.equal(users.length, 1);
    assert.equal(users[0].role, "owner");
    assert.equal(users[0].email, "ravi@example.com");
    assert.equal(String(users[0].businessId), String(businesses[0]._id), "owner belongs to the new business only");
    assert.notEqual(users[0].password, "Str0ng-pass", "password is stored hashed");
    assert.equal(String(businesses[0].ownerUserId), String(users[0]._id));
    assert.equal(result.owner.email, "ravi@example.com");
  } finally {
    restores.forEach((restore) => restore());
  }
});

test("an email that already has an account is refused", async () => {
  const restores = [stub(User, "exists", async () => ({ _id: 1 }))];
  try {
    const { createClientWorkspace } = load();
    await assert.rejects(
      createClientWorkspace({ businessName: "Acme", ownerName: "Asha", ownerEmail: "taken@example.com", password: "Str0ng-pass" }),
      (error) => error.statusCode === 409 && Boolean(error.fieldErrors?.ownerEmail)
    );
  } finally {
    restores.forEach((restore) => restore());
  }
});

test("missing fields and short passwords are reported per field", async () => {
  const { validateWorkspaceInput } = load();
  const errors = validateWorkspaceInput({ businessName: "", ownerName: "A", ownerEmail: "nope", password: "short" });
  assert.deepEqual(Object.keys(errors).sort(), ["businessName", "ownerEmail", "ownerName", "password"]);
});

test("a half-created workspace is removed if the owner cannot be created", async () => {
  let deletedBusiness = false;
  const restores = [
    stub(Business, "exists", async () => null),
    stub(Business, "create", async (doc) => ({ ...doc, _id: new mongoose.Types.ObjectId(), save: async () => {} })),
    stub(Business, "deleteOne", async () => { deletedBusiness = true; }),
    stub(User, "exists", async () => null),
    stub(User, "create", async () => { throw new Error("db down"); }),
  ];
  try {
    const { createClientWorkspace } = load();
    await assert.rejects(createClientWorkspace({ businessName: "Acme", ownerName: "Asha", ownerEmail: "a@example.com", password: "Str0ng-pass" }), /db down/);
    assert.equal(deletedBusiness, true);
  } finally {
    restores.forEach((restore) => restore());
  }
});
