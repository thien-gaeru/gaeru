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
let rejectReady;
const readyPromise = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
readyPromise.catch(() => {});

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
  return { name: safe(error?.name), code: safe(error?.code) };
}

let server;

const STARTUP_TIMEOUT_MS = Number.parseInt(process.env.STARTUP_TIMEOUT_MS, 10) || 60000;
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 15000;
const timerFn = typeof setTimeout === 'function' ? setTimeout : (typeof globalThis !== 'undefined' ? globalThis.setTimeout : null);
const clearFn = typeof clearTimeout === 'function' ? clearTimeout : (typeof globalThis !== 'undefined' ? globalThis.clearTimeout : null);

function withTimeout(promise, ms, name) {
  if (!timerFn) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = timerFn(() => {
        const err = Object.assign(new Error(`${name} deadline exceeded (${ms}ms)`), { code: 'ETIMEDOUT' });
        reject(err);
      }, ms);
      if (typeof timer?.unref === 'function') timer.unref();
    })
  ]).finally(() => {
    if (timer && clearFn) clearFn(timer);
  });
}

async function start() {
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

  if (shuttingDown) return;
  await withTimeout(migrateDatabase(pool), 30000, 'Database migration');
  if (shuttingDown) return;
  const mediaCheck = await withTimeout(require('./lib/filesystem-media').probe(), 15000, 'Media probe');
  console.log('Media storage:', JSON.stringify(mediaCheck));
  const mediaAudit = require('./media-storage-audit');
  if (mediaCheck.verified) {
    console.log('Static media:', JSON.stringify(await require('./persistent-assets').syncAssets(pool)));
    if (shuttingDown) return;
    mediaAuditTask = mediaAudit.runLocalMediaAudit(pool)
      .then(({ localization, audit }) => {
        console.log('Local media:', JSON.stringify(localization));
        console.log('Local media checks:', JSON.stringify({ state: audit.state, failedChecks: audit.failedChecks, legacyReferences: audit.legacyReferences }));
      })
      .catch(error => console.error('Local media audit failed:', errorSummary(error)));
  } else {
    const checkedMedia = await mediaAudit.auditMediaStorage(pool, { probeStatus: mediaCheck });
    console.log('Local media checks:', JSON.stringify({ state: checkedMedia.state, failedChecks: checkedMedia.failedChecks, legacyReferences: checkedMedia.legacyReferences }));
  }
  if (shuttingDown) return;
  await withTimeout(workerManager.startAll(pool, config, { requireFn: require }), 20000, 'Worker startup');
}

let watchdogTimer = timerFn ? timerFn(() => {
  if (!startupReady && !startupError && !shuttingDown) {
    const timeoutErr = Object.assign(new Error(`Startup deadline exceeded (${STARTUP_TIMEOUT_MS}ms)`), { code: 'ETIMEDOUT' });
    startupError = timeoutErr;
    if (typeof rejectReady === 'function') rejectReady(timeoutErr);
    console.error('GAERU startup watchdog deadline exceeded:', errorSummary(timeoutErr));
    process.exitCode = 1;
    void shutdown();
  }
}, STARTUP_TIMEOUT_MS) : null;
if (watchdogTimer && typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

const startTask = start();
startTask
  .then(() => {
    if (watchdogTimer && clearFn) clearFn(watchdogTimer);
    startupReady = true;
    if (typeof resolveReady === 'function') resolveReady(true);
    console.log('GAERU system startup completed successfully. Database and workers are ready.');
  })
  .catch(async (error) => {
    if (watchdogTimer && clearFn) clearFn(watchdogTimer);
    startupError = error;
    if (typeof rejectReady === 'function') rejectReady(error);
    console.error('GAERU startup failed:', errorSummary(error));
    process.exitCode = 1;
    await shutdown();
  });

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (watchdogTimer && clearFn) clearFn(watchdogTimer);

  let shutdownTimer = timerFn ? timerFn(() => {
    console.error(`GAERU shutdown exceeded deadline (${SHUTDOWN_TIMEOUT_MS}ms). Forcing exit.`);
    if (typeof process.exit === 'function') process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS) : null;
  if (shutdownTimer && typeof shutdownTimer.unref === 'function') shutdownTimer.unref();

  try {
    if (timerFn) {
      await Promise.race([
        startTask.catch(() => {}),
        new Promise(resolve => timerFn(resolve, 5000))
      ]);
      await Promise.race([
        workerManager.stopAll(),
        new Promise(resolve => timerFn(resolve, 5000))
      ]);
      if (server) {
        if (typeof server.closeIdleConnections === 'function') {
          server.closeIdleConnections();
        }
        await Promise.race([
          new Promise(resolve => server.close(resolve)),
          new Promise(resolve => timerFn(resolve, 3000))
        ]);
      }
      await Promise.race([
        mediaAuditTask,
        new Promise(resolve => timerFn(resolve, 3000))
      ]);
    } else {
      await startTask.catch(() => {});
      await workerManager.stopAll();
      if (server) await new Promise(resolve => server.close(resolve));
      await mediaAuditTask;
    }

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
  } finally {
    if (shutdownTimer && clearFn) clearFn(shutdownTimer);
  }
}

pool.on("error", (error) => console.error("Unexpected database pool error:", errorSummary(error)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
