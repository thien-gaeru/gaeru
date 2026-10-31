require("dotenv").config();
const expressSession = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { loadConfig } = require("./config");
const { createPool, inspectDatabaseTls } = require("./db");
const { createApp } = require("./app");
const { migrateDatabase } = require("./migrate");
const { WorkerManager } = require("./workers");

const config = loadConfig();
const pool = createPool(config);
const PgSessionStore = connectPgSimple(expressSession);
const sessionStore = new PgSessionStore({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60
});

let startupReady = false;
let startupError = null;
let resolveReady;
const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

async function readinessChecker() {
  if (startupReady) return true;
  if (startupError) throw startupError;
  return readyPromise;
}

const app = createApp({ config, pool, sessionStore, readinessChecker });
const workerManager = new WorkerManager();
let mediaAuditTask = Promise.resolve();
let shuttingDown = false;

function errorSummary(error) {
  const safe = value => /^[A-Za-z0-9_]{1,50}$/.test(String(value || '')) ? String(value) : 'unavailable';
  return {
    name: safe(error?.name),
    code: safe(error?.code),
    message: error?.message || 'unavailable'
  };
}

// Hostinger / Phusion Passenger requirement:
// app.listen() must be invoked immediately during script execution (within 3 seconds)
const port = Number.parseInt(process.env.PORT, 10) || config.PORT || 3000;
const host = "0.0.0.0";

const server = app.listen(port, host, () => {
  console.log(`GAERU standalone store listening on ${host}:${port}`);
});

server.on('error', (error) => {
  console.error('GAERU listener failed:', errorSummary(error));
  process.exitCode = 1;
  void shutdown();
});

async function start() {
  await migrateDatabase(pool);
  if (shuttingDown) return;
  const mediaCheck = await require('./lib/filesystem-media').probe();
  console.log('Media storage:', JSON.stringify(mediaCheck));
  const mediaAudit = require('./media-storage-audit');
  if (mediaCheck.verified) {
    console.log('Static media:', JSON.stringify(await require('./persistent-assets').syncAssets(pool)));
    if (shuttingDown) return;
  } else {
    const checkedMedia = await mediaAudit.auditMediaStorage(pool, { probeStatus: mediaCheck });
    console.log('Local media checks:', JSON.stringify({ state: checkedMedia.state, failedChecks: checkedMedia.failedChecks, legacyReferences: checkedMedia.legacyReferences }));
  }
  if (shuttingDown) return;
  await workerManager.startAll(pool, config, { requireFn: require });

  if (mediaCheck.verified && !shuttingDown) {
    mediaAuditTask = mediaAudit.runLocalMediaAudit(pool)
      .then(({ localization, audit }) => {
        console.log('Local media:', JSON.stringify(localization));
        console.log('Local media checks:', JSON.stringify({ state: audit.state, failedChecks: audit.failedChecks, legacyReferences: audit.legacyReferences }));
      })
      .catch(error => console.error('Local media audit failed:', errorSummary(error)));
  }
  inspectDatabaseTls(pool, config)
    .then((info) => console.log("Database TLS active:", JSON.stringify(info)))
    .catch(() => console.log("Database TLS active: unavailable"));
}

const startTask = start();
startTask
  .then(() => {
    startupReady = true;
    if (typeof resolveReady === 'function') resolveReady(true);
    console.log('GAERU system startup completed successfully. Database and workers are ready.');
  })
  .catch(async (error) => {
    startupError = error;
    console.error('GAERU startup failed:', error?.message || error);
    if (error?.stack) console.error(error.stack);
  });

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await startTask.catch(() => {});
  await workerManager.stopAll();
  if (server) await new Promise(resolve => server.close(resolve));
  await mediaAuditTask;
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
