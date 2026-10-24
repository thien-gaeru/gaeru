require("dotenv").config();
const expressSession = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { loadConfig } = require("./config");
const { createPool } = require("./db");
const { createApp } = require("./app");
const { migrateDatabase } = require("./migrate");

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
let server;let stopRetention;

async function start() {
  await migrateDatabase(pool);
  stopRetention=require("./account-retention").startRetentionWorker(pool);
  const port = Number.parseInt(process.env.PORT, 10) || config.PORT || 3000;
  const host = "0.0.0.0";
  server = app.listen(port, host, () => {
    console.log(`GAERU standalone store listening on ${host}:${port}`);
    if(config.NODE_ENV === "production")require("./database-tls-probe").probeDatabaseTls(config).then(result=>console.log("Database TLS diagnostic:",JSON.stringify(result))).catch(()=>console.log("Database TLS diagnostic unavailable"));
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
  stopRetention?.();
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
