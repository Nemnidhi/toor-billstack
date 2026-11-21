// Who is doing what, for the edit log: set per request (request id, IP) and filled in by the
// auth middleware (user). Code outside a request (scripts, jobs, tests) runs as "system".
const { AsyncLocalStorage } = require("node:async_hooks");

const storage = new AsyncLocalStorage();

const run = (store, fn) => storage.run(store, fn);
const get = () => storage.getStore() || null;
const setUser = (user) => {
  const store = storage.getStore();
  if (store && user) {
    store.userId = user._id || null;
    store.userEmail = user.email || "";
    store.userName = user.name || "";
    store.role = user.role || "";
  }
};

module.exports = { run, get, setUser };
