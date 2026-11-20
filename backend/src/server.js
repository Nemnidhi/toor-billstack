require("./config/load-env")();

const app = require("./app");
const connectDB = require("./config/db");
const { validateEnvironment } = require("./config/env");
const { log } = require("./utils/logger");

const PORT = process.env.PORT || 5000;
let server;

const startServer = async () => {
  try {
    const env = validateEnvironment();
    for (const warning of env.warnings) {
      log("warn", "Environment validation warning", { warning });
    }
    await connectDB();
    server = app.listen(PORT, () => {
      log("info", `BillStack API running on port ${PORT}`);
    });
  } catch (error) {
    log("error", "Failed to start server", { message: error.message });
    process.exit(1);
  }
};

let shuttingDown = false;
const shutdown = (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", `Received ${signal}. Shutting down BillStack API.`);

  if (!server) {
    process.exit(exitCode);
    return;
  }

  server.close(() => {
    log("info", "HTTP server closed successfully");
    process.exit(exitCode);
  });

  setTimeout(() => {
    log("error", "Forced shutdown after timeout");
    process.exit(1);
  }, 10000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// After an uncaught exception the process is in an unknown state (half-done
// writes, broken sockets). Log it, stop taking requests and exit, so systemd
// starts a clean copy (the unit must have Restart=always / on-failure).
process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception - restarting", { message: error.message, stack: error.stack });
  shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

startServer();
