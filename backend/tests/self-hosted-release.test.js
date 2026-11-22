const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const AppError = require("../src/utils/appError");
const Business = require("../src/models/Business");
const Invoice = require("../src/models/Invoice");
const User = require("../src/models/User");
const subscriptionService = require("../src/services/subscription.service");

const src = (...parts) => fs.readFileSync(path.join(__dirname, "..", "src", ...parts), "utf8");
const frontend = (...parts) => fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "src", ...parts), "utf8");

const invoke = (middleware, req = {}) =>
  new Promise((resolve, reject) => {
    middleware(
      {
        tenant: { businessId: "64f000000000000000000001" },
        body: {},
        ...req,
      },
      {},
      (error) => (error ? reject(error) : resolve())
    );
  });

const withPatched = async (patches, fn) => {
  const originals = patches.map(([target, key, value]) => {
    const original = target[key];
    target[key] = value;
    return [target, key, original];
  });
  try {
    return await fn();
  } finally {
    originals.reverse().forEach(([target, key, original]) => {
      target[key] = original;
    });
  }
};

const reload = (modulePath) => {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
};

test("SAAS expired subscription remains blocked by active subscription guard", async () => {
  await withPatched(
    [
      [Business, "findById", async () => ({ _id: "64f000000000000000000001", planCode: "pro", deploymentMode: "SAAS" })],
      [subscriptionService, "ensureBusinessSubscription", async () => ({ planCode: "pro", status: "expired" })],
      [subscriptionService, "isSubscriptionAccessible", () => false],
      [subscriptionService, "isSubscriptionExpired", () => true],
    ],
    async () => {
      const { requireActiveSubscription } = reload("../src/middlewares/subscription.middleware");
      await assert.rejects(
        () => invoke(requireActiveSubscription()),
        (error) => error instanceof AppError && error.statusCode === 402
      );
    }
  );
});

test("SELF_HOSTED expired subscription does not block normal tenant API guard", async () => {
  await withPatched(
    [
      [Business, "findById", async () => ({ _id: "64f000000000000000000001", planCode: "free", deploymentMode: "SELF_HOSTED" })],
      [subscriptionService, "ensureBusinessSubscription", async () => ({ planCode: "free", status: "expired" })],
      [subscriptionService, "isSubscriptionAccessible", () => false],
      [subscriptionService, "isSubscriptionExpired", () => true],
    ],
    async () => {
      const { requireActiveSubscription } = reload("../src/middlewares/subscription.middleware");
      await assert.doesNotReject(() => invoke(requireActiveSubscription()));
    }
  );
});

test("SAAS invoice capacity remains enforced", async () => {
  await withPatched(
    [
      [Business, "findById", async () => ({
        _id: "64f000000000000000000001",
        planCode: "free",
        deploymentMode: "SAAS",
        invoiceUsage: {},
        save: async () => {},
      })],
      [subscriptionService, "ensureBusinessSubscription", async () => ({ planCode: "free", status: "free" })],
      [subscriptionService, "isSubscriptionAccessible", () => true],
      [subscriptionService, "getPlanEntitlements", () => ({ name: "Free", invoiceMonthlyLimit: 20 })],
      [Invoice, "countDocuments", async () => 20],
    ],
    async () => {
      const { requireInvoiceCapacity } = reload("../src/middlewares/feature-guard.middleware");
      await assert.rejects(
        () => invoke(requireInvoiceCapacity()),
        (error) => error instanceof AppError && error.statusCode === 403 && error.code === "LIMIT_REACHED"
      );
    }
  );
});

test("SELF_HOSTED invoice capacity bypasses SaaS monthly plan limits", async () => {
  await withPatched(
    [
      [Business, "findById", async () => ({ _id: "64f000000000000000000001", planCode: "free", deploymentMode: "SELF_HOSTED" })],
      [subscriptionService, "ensureBusinessSubscription", async () => {
        throw new Error("SELF_HOSTED must not need SaaS subscription capacity");
      }],
      [Invoice, "countDocuments", async () => {
        throw new Error("SELF_HOSTED must not count invoices for SaaS capacity");
      }],
    ],
    async () => {
      const { requireInvoiceCapacity } = reload("../src/middlewares/feature-guard.middleware");
      await assert.doesNotReject(() => invoke(requireInvoiceCapacity()));
    }
  );
});

test("SELF_HOSTED staff capacity bypass is explicit while RBAC remains route-enforced", () => {
  const teamController = src("controllers", "team.controller.js");
  const teamRoutes = src("routes", "team.routes.js");
  assert.match(teamController, /deploymentMode !== "SELF_HOSTED"/);
  assert.match(teamController, /Staff user limit reached/);
  assert.match(teamRoutes, /permit\("owner", "admin"\)/);
});

test("SELF_HOSTED external ingestion bypasses SaaS subscription and invoice capacity only", () => {
  const integration = src("services", "integration.service.js");
  assert.match(integration, /business\.deploymentMode !== "SELF_HOSTED"/);
  assert.match(integration, /ensureBusinessSubscription/);
  assert.match(integration, /invoiceMonthlyLimit/);
  assert.match(integration, /authenticateIntegrationKey/);
  assert.match(integration, /IntegrationEvent\.findOne/);
});

test("SELF_HOSTED still keeps tenant isolation, module activation and RBAC enforcement", () => {
  const tenant = src("middlewares", "tenant.middleware.js");
  const moduleGuard = src("middlewares", "module-guard.middleware.js");
  const sharedRoutes = src("routes", "shared-operations.routes.js");
  const workflowRoutes = src("routes", "workflow.routes.js");

  assert.match(tenant, /Cross-business access is not allowed/);
  assert.match(moduleGuard, /assertModuleActive/);
  assert.match(sharedRoutes, /requireModule\("production_job_work"\)/);
  assert.match(sharedRoutes, /permit\("owner", "admin", "staff"\)/);
  assert.match(workflowRoutes, /requireModule\("order_management"\)/);
  assert.match(workflowRoutes, /permit\("owner", "admin", "accountant"\)/);
});

test("frontend hides SaaS subscription purchase copy in SELF_HOSTED sidebar", () => {
  const sidebar = frontend("components", "layout", "Sidebar.jsx");
  assert.match(sidebar, /deploymentMode === "SELF_HOSTED"/);
  assert.match(sidebar, /label: "Subscription"[^}]*saasOnly: true/);
  assert.match(sidebar, /saasOnly && isSelfHostedWorkspace/);
});
