let stopOrderEmail;let stopMediaMigration;
require("dotenv").config();
const expressSession = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { loadConfig } = require("./config");
const { createPool, inspectDatabaseTls } = require("./db");
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
let server;let stopRetention;let stopEmail;let stopWarrantyEmail;let stopChatEmail;let stopAIChat;let stopChatCompression;

async function start() {
  await migrateDatabase(pool);
  if (shuttingDown) return;
  const mediaCheck=await require('./lib/filesystem-media').probe();
  console.log('Media storage:',JSON.stringify(mediaCheck));
  console.log('Static media:',JSON.stringify(await require('./persistent-assets').syncAssets(pool)));
  if (shuttingDown) return;
  stopMediaMigration=require('./media-filesystem-migration').startMigration(pool);
  stopAIChat=require('./shopping-chat-ai-first').startAIChatWorker(pool,config);
  stopChatCompression=require('./shopping-chat-compression').startChatCompressionWorker(pool);
  stopChatEmail=require('./shopping-chat-email').startChatEmailWorker(pool,config);
  stopOrderEmail=require("./order-email").startOrderEmailWorker(pool,config);
  stopWarrantyEmail=require("./warranty-email").startWarrantyEmailWorker(pool,config);
  stopEmail=require("./email-marketing").startEmailWorker(pool,config);
  stopRetention=require("./account-retention").startRetentionWorker(pool);
  const port = Number.parseInt(process.env.PORT, 10) || config.PORT || 3000;
  const host = "0.0.0.0";
  server = app.listen(port, host, () => {
    console.log(`GAERU standalone store listening on ${host}:${port}`);
    inspectDatabaseTls(pool, config)
      .then((info) => console.log("Database TLS active:", JSON.stringify(info)))
      .catch(() => console.log("Database TLS active: unavailable"));
  });
  server.on('error', (error) => {
    console.error('GAERU listener failed:', errorSummary(error));
    process.exitCode = 1;
    void shutdown();
  });
}

let shuttingDown = false;
function errorSummary(error) {
  const safe = value => /^[A-Za-z0-9_]{1,50}$/.test(String(value || '')) ? String(value) : 'unavailable';
  return { name: safe(error?.name), code: safe(error?.code) };
}
const startTask = start();
startTask.catch(async (error) => {
  console.error('GAERU startup failed:', errorSummary(error));
  process.exitCode = 1;
  await shutdown();
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Let any in-flight startup work settle before closing the pool it is using.
  await startTask.catch(() => {});
  stopMediaMigration?.();
  stopChatCompression?.();
  stopAIChat?.();
  stopChatEmail?.();
  stopRetention?.();
  stopEmail?.();
  stopWarrantyEmail?.();
  stopOrderEmail?.();
  if (server) await new Promise(resolve => server.close(resolve));
  try {
    await sessionStore.close();
  } catch (error) {
    console.error("Session store shutdown failed:", errorSummary(error));
    process.exitCode = 1;
  }
  try {
    await pool.end();
  } catch (error) {
    console.error("Database shutdown failed:", errorSummary(error));
    process.exitCode = 1;
  }
}

pool.on("error", (error) => console.error("Unexpected database pool error:", errorSummary(error)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
