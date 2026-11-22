const crypto = require("crypto");
const context = require("../utils/request-context");

const requestContext = (req, res, next) => {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  context.run({ requestId, ip: req.ip || "", userId: null, userEmail: "" }, () => next());
};

module.exports = {
  requestContext,
};
