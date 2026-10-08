const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Product = require("../src/models/Product");
const { normalizeLineItems } = require("../src/services/workflow.service");

const businessId = new mongoose.Types.ObjectId();

// Chainable stand-in for a mongoose query: supports .session() and await.
const query = (value) => {
  const promise = Promise.resolve(value);
  return { session: () => promise, then: (...args) => promise.then(...args) };
};

const withProductStubs = async (store, fn) => {
  const original = { find: Product.find, findOne: Product.findOne, create: Product.create };
  Product.find = (filter) => {
    const ids = (filter._id?.$in || []).map(String);
    return query(store.filter((product) => ids.includes(String(product._id))));
  };
  Product.findOne = (filter) => {
    const regex = filter.name?.$regex;
    return query(store.find((product) => regex?.test(product.name)) || null);
  };
  Product.create = async (docs) => {
    const created = (Array.isArray(docs) ? docs : [docs]).map((doc) => ({ ...doc, _id: new mongoose.Types.ObjectId() }));
    store.push(...created);
    return Array.isArray(docs) ? created : created[0];
  };
  try {
    return await fn();
  } finally {
    Object.assign(Product, original);
  }
};

test("monthly billing accepts a typed service when the workspace has no product catalog", async () => {
  const store = [];
  await withProductStubs(store, async () => {
    const { lineItems } = await normalizeLineItems({
      businessId,
      rawItems: [{ productName: "Cabin rent – Cabin 4", quantity: 1, rate: 25000, taxRate: 18 }],
      session: null,
      allowManualServices: true,
    });
    assert.equal(store.length, 1, "typed service is saved once to the catalog");
    assert.equal(lineItems[0].productName, "Cabin rent – Cabin 4");
    assert.equal(String(lineItems[0].productId), String(store[0]._id));
    assert.equal(lineItems[0].rate, 25000);
    assert.equal(lineItems[0].taxRate, 18);
  });
});

test("a typed service that already exists is reused instead of duplicated", async () => {
  const existing = { _id: new mongoose.Types.ObjectId(), businessId, name: "Dedicated desk", sellingPrice: 7500, taxRate: 18 };
  const store = [existing];
  await withProductStubs(store, async () => {
    const { lineItems } = await normalizeLineItems({
      businessId,
      rawItems: [{ productName: "dedicated desk", quantity: 2, rate: 7500 }],
      session: null,
      allowManualServices: true,
    });
    assert.equal(store.length, 1);
    assert.equal(String(lineItems[0].productId), String(existing._id));
  });
});

test("an empty line item gives an actionable message instead of 'Invalid product'", async () => {
  await withProductStubs([], async () => {
    await assert.rejects(
      normalizeLineItems({ businessId, rawItems: [{ productId: "", quantity: 1, rate: 100 }], session: null, allowManualServices: true }),
      /Select a service or type the service name/
    );
    await assert.rejects(
      normalizeLineItems({ businessId, rawItems: [{ productId: "", quantity: 1, rate: 100 }], session: null }),
      /Select a product or service for every line item/
    );
  });
});
