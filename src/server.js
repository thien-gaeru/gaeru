require("dotenv").config();
const expressSession = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { loadConfig } = require("./config");
const { createPool } = require("./db");
const { createApp } = require("./app");

const config = loadConfig();
const pool = createPool(config);
const PgSessionStore = connectPgSimple(expressSession);
const sessionStore = new PgSessionStore({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60
});
const app = createApp({ config, pool, sessionStore });
let server;

async function start() {
  await pool.query("ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true");
  const port = Number.parseInt(process.env.PORT, 10) || config.PORT || 3000;
  const host = "0.0.0.0";
  server = app.listen(port, host, () => {
    console.log(`GAERU standalone store listening on ${host}:${port}`);
  });
}

start().catch((error) => {
  console.error("GAERU startup failed:", error);
  process.exitCode = 1;
});
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => {
    try {
      await sessionStore.close();
    } catch (error) {
      console.error("Session store shutdown failed:", error);
      process.exitCode = 1;
    }
    try {
      await pool.end();
    } catch (error) {
      console.error("Database shutdown failed:", error);
      process.exitCode = 1;
    }
  });
}

pool.on("error", (error) => console.error("Unexpected database pool error:", error));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
