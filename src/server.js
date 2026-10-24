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
let server;let stopRetention;let stopEmail;let stopWarrantyEmail;let stopChatEmail;let stopAIChat;

async function start() {
  await migrateDatabase(pool);
  stopAIChat=require('./shopping-chat-ai-first').startAIChatWorker(pool,config);
  stopChatEmail=require('./shopping-chat-email').startChatEmailWorker(pool,config);
  stopWarrantyEmail=require("./warranty-email").startWarrantyEmailWorker(pool,config);
  stopEmail=require("./email-marketing").startEmailWorker(pool,config);
  stopRetention=require("./account-retention").startRetentionWorker(pool);
  const port = Number.parseInt(process.env.PORT, 10) || config.PORT || 3000;
  const host = "0.0.0.0";
  server = app.listen(port, host, () => {
    console.log(`GAERU standalone store listening on ${host}:${port}`);
    pool.connect().then(client=>{try{console.log("Database TLS active:",JSON.stringify({encrypted:client.connection?.stream?.encrypted===true,certificateAuthorized:client.connection?.stream?.authorized===true}));}finally{client.release();}}).catch(()=>console.log("Database TLS active: unavailable"));
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
  stopAIChat?.();
  stopChatEmail?.();
  stopRetention?.();
  stopEmail?.();
  stopWarrantyEmail?.();
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
