require("dotenv").config();
const expressSession = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { loadConfig } = require("./config");
const { createVerifiedPool } = require("./db");
const { createApp } = require("./app");
const { migrateDatabase } = require("./migrate");

const config = loadConfig();
let pool,sessionStore,server,stopRetention;

async function start() {
  const transport=await createVerifiedPool(config);
  pool=transport.pool;
  console.log(transport.tlsVerified?"Database transport: VERIFIED_TLS":"Database TLS upgrade unavailable: "+(transport.upgradeError||"NOT_REQUESTED"));
  pool.on("error",error=>console.error("Database pool error:",{code:error.code||"DATABASE_ERROR"}));
  const PgSessionStore=connectPgSimple(expressSession);
  sessionStore=new PgSessionStore({pool,tableName:"user_sessions",createTableIfMissing:true,pruneSessionInterval:15*60});
  const app=createApp({config,pool,sessionStore});
  await migrateDatabase(pool);
  stopRetention=require("./account-retention").startRetentionWorker(pool);
  const port = Number.parseInt(process.env.PORT, 10) || config.PORT || 3000;
  const host = "0.0.0.0";
  server = app.listen(port, host, () => {
    console.log(`GAERU standalone store listening on ${host}:${port}`);
  });
}

start().catch((error) => {
  console.error("GAERU startup failed:", {code:error.code||"STARTUP_FAILED"});
  process.exitCode = 1;
});
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopRetention?.();
  if(!server){await pool?.end();return;}
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


process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
