let stopOrderEmail;let stopChatFileRetention;let stopTikTokAds;
require("dotenv").config();
const expressSession = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { loadConfig } = require("./config");
const { createPool, inspectDatabaseTls } = require("./db");
const { createApp } = require("./app");
const { migrateDatabase } = require("./migrate");
const { setReady, setStartupError } = require("./lib/readiness-gate");

// Set readiness to false at the start of production server process
setReady(false);

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
let server;let mediaAuditTask=Promise.resolve();let staticMediaSyncTask=Promise.resolve();let stopRetention;let stopEmail;let stopWarrantyEmail;let stopChatEmail;let stopAIChat;let stopChatCompression;let stopCareEmail;let stopAbandonedCart;
let resourceMonitor;
const workerTimeouts = [];
function scheduleWorker(fn, delayMs) {
  if (shuttingDown) return;
  if (typeof setTimeout === 'undefined' || process.env.NODE_ENV === 'test' || delayMs === 0) {
    fn();
    return;
  }
  const t = setTimeout(() => {
    if (!shuttingDown) fn();
  }, delayMs);
  t.unref?.();
  workerTimeouts.push(t);
}

async function start() {
  const port = Number.parseInt(process.env.PORT, 10) || config.PORT || 3000;
  const host = "0.0.0.0";

  // Phase 1: Open HTTP listener immediately (< 300ms) to satisfy Hostinger 3s watchdog.
  // The Readiness Gate holds business traffic with 503 Retry-After until Phase 2 finishes.
  server = app.listen(port, host, () => {
    console.log(`GAERU standalone store listening on ${host}:${port}`);
  });
  server.on('error', (error) => {
    console.error('GAERU listener failed:', errorSummary(error));
    process.exitCode = 1;
    void shutdown();
  });

  // Phase 2: Run critical database migrations while incoming traffic is gated safely
  await migrateDatabase(pool);
  if (shuttingDown) return;

  // GAERU P2-02: Priority DB concurrency semaphore for background workers on 2 CPU / 3 GB RAM
  let activeHighOps = 0;
  let activeLowOps = 0;
  const lowWaitQueue = [];
  const MAX_LOW_PRIORITY_OPS = 2;
  const pumpLowQueue = () => {
    while (activeHighOps === 0 && activeLowOps < MAX_LOW_PRIORITY_OPS && lowWaitQueue.length > 0) {
      activeLowOps++;
      const resume = lowWaitQueue.shift();
      resume();
    }
  };
  const createPriorityPool = (priority) => {
    if (!pool || typeof pool.query !== 'function') return pool;
    const proxy = Object.create(pool);
    proxy.query = async (...args) => {
      if (priority === 'high') {
        activeHighOps++;
        try { return await pool.query(...args); }
        finally { activeHighOps = Math.max(0, activeHighOps - 1); pumpLowQueue(); }
      }
      if (activeHighOps > 0 || activeLowOps >= MAX_LOW_PRIORITY_OPS) {
        await new Promise(resolve => lowWaitQueue.push(resolve));
      } else {
        activeLowOps++;
      }
      try { return await pool.query(...args); }
      finally { activeLowOps = Math.max(0, activeLowOps - 1); pumpLowQueue(); }
    };
    return proxy;
  };
  const highPriorityPool = createPriorityPool('high');
  const lowPriorityPool = createPriorityPool('low');

  // Background workers initialization with staggered startup and priority concurrency cap (A10 / P2-02)
  const isBackgroundWorker = !process.env.CLUSTER_WORKER || process.env.WORKER_INDEX === '0';
  if (isBackgroundWorker) {
    scheduleWorker(() => { stopOrderEmail = require("./order-email").startOrderEmailWorker(highPriorityPool, config); }, 0);
    scheduleWorker(() => { stopWarrantyEmail = require("./warranty-email").startWarrantyEmailWorker(highPriorityPool, config); }, 2000);
    scheduleWorker(() => { stopCareEmail = require("./care-api").startCareEmailWorker(highPriorityPool, config); }, 4000);
    scheduleWorker(() => { stopAIChat = require('./shopping-chat-ai-first').startAIChatWorker(lowPriorityPool, config); }, 6000);
    scheduleWorker(() => { stopChatEmail = require('./shopping-chat-email').startChatEmailWorker(lowPriorityPool, config); }, 8000);
    scheduleWorker(() => { stopChatCompression = require('./shopping-chat-compression').startChatCompressionWorker(lowPriorityPool); }, 10000);
    scheduleWorker(() => { stopTikTokAds = require('./tiktok-ads').startTikTokAdsWorker(lowPriorityPool, config); }, 14000);
    scheduleWorker(() => { stopAbandonedCart = require("./abandoned-cart").startAbandonedCartWorker(lowPriorityPool, config); }, 18000);
    scheduleWorker(() => { stopEmail = require("./email-marketing").startEmailWorker(lowPriorityPool, config); }, 22000);
    scheduleWorker(() => { stopChatFileRetention = require('./shopping-chat-file-retention').startChatFileRetentionWorker(lowPriorityPool); }, 26000);
    scheduleWorker(() => { stopRetention = require("./account-retention").startRetentionWorker(lowPriorityPool); }, 30000);
  }

  // Non-blocking media probe and asynchronous asset sync in the background
  const mediaCheck=await require('./lib/filesystem-media').probe();
  console.log('Media storage:',JSON.stringify(mediaCheck));
  const mediaAudit=require('./media-storage-audit');
  if(mediaCheck.verified){
    // GAERU F-06 & OPS-01: Mark Readiness Gate as READY once DB migrations and filesystem probe succeed; run static media sync asynchronously
    setReady(true);
    staticMediaSyncTask = require('./persistent-assets').syncAssets(pool)
      .then(res => console.log('Static media:', JSON.stringify(res)))
      .catch(err => console.error('Static media sync failed:', errorSummary(err)));
  }else{
    const checkedMedia=await mediaAudit.auditMediaStorage(pool,{probeStatus:mediaCheck});
    console.log('Local media checks:',JSON.stringify({state:checkedMedia.state,failedChecks:checkedMedia.failedChecks,legacyReferences:checkedMedia.legacyReferences}));
    setReady(true);
  }
  if (shuttingDown) return;

  if(mediaCheck.verified&&!shuttingDown){
    mediaAuditTask=mediaAudit.runLocalMediaAudit(pool)
      .then(({localization,audit})=>{
        console.log('Local media:',JSON.stringify(localization));
        console.log('Local media checks:',JSON.stringify({state:audit.state,failedChecks:audit.failedChecks,legacyReferences:audit.legacyReferences}));
      })
      .catch(error=>console.error('Local media audit failed:',errorSummary(error)));
  }

  // Cache warmup and database TLS verification
  try { require('./lib/cache-warmup').warmUpCache(pool).catch(() => {}); } catch (_) {}
  inspectDatabaseTls(pool, config)
    .then((info) => console.log("Database TLS active:", JSON.stringify(info)))
    .catch(() => console.log("Database TLS active: unavailable"));

  // Resource telemetry monitor (every 60s) for Hostinger 2 CPU / 3 GB RAM
  try {
    const { monitorEventLoopDelay } = require('node:perf_hooks');
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    resourceMonitor = setInterval(() => {
      const m = process.memoryUsage();
      console.log('[GAERU_RESOURCES]', JSON.stringify({
        rssMB: Math.round(m.rss / 1048576),
        heapMB: Math.round(m.heapUsed / 1048576),
        externalMB: Math.round(m.external / 1048576),
        eventLoopP95Ms: Math.round(lag.percentile(95) / 1e6),
        dbPoolTotal: Number(pool?.totalCount || 0),
        dbPoolIdle: Number(pool?.idleCount || 0),
        dbPoolWaiting: Number(pool?.waitingCount || 0),
        bgWorkerHighActive: activeHighOps,
        bgWorkerLowActive: activeLowOps,
        bgWorkerLowQueued: lowWaitQueue.length
      }));
      lag.reset();
    }, 60000);
    resourceMonitor.unref?.();
  } catch (_) {}
}

let shuttingDown = false;
function errorSummary(error) {
  const safe = value => /^[A-Za-z0-9_]{1,50}$/.test(String(value || '')) ? String(value) : 'unavailable';
  const summary = { name: safe(error?.name), code: safe(error?.code) };
  if (/^[a-z0-9-]{1,64}\.sql$/.test(String(error?.migrationFile || ''))) summary.migration = String(error.migrationFile);
  if (/^[A-Za-z0-9_]{1,63}$/.test(String(error?.table || ''))) summary.table = String(error.table);
  if (/^[A-Za-z0-9_]{1,63}$/.test(String(error?.column || ''))) summary.column = String(error.column);
  if (/^[A-Za-z0-9_]{1,63}$/.test(String(error?.constraint || ''))) summary.constraint = String(error.constraint);
  if (/^[A-Za-z0-9_]{1,63}$/.test(String(error?.routine || ''))) summary.routine = String(error.routine);
  return summary;
}
const startTask = start();
startTask.catch(async (error) => {
  setStartupError(error);
  console.error('GAERU startup failed:', errorSummary(error));
  process.exitCode = 1;
  await shutdown();
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  setStartupError(new Error('SHUTDOWN'));
  if (resourceMonitor) clearInterval(resourceMonitor);
  if (typeof clearTimeout !== 'undefined') workerTimeouts.forEach(t => clearTimeout(t));
  // Let any in-flight startup work settle before closing the pool it is using.
  await startTask.catch(() => {});
  stopChatFileRetention?.();
  stopTikTokAds?.();
  stopChatCompression?.();
  stopAIChat?.();
  stopChatEmail?.();
  stopRetention?.();
  stopAbandonedCart?.();
  stopEmail?.();
  stopWarrantyEmail?.();
  stopCareEmail?.();
  stopOrderEmail?.();
  if (server) await new Promise(resolve => server.close(resolve));
  // Background conversion, verification and media sync bounded by a 4-second deadline (A15)
  if (typeof setTimeout !== 'undefined') {
    const shutdownDeadline = new Promise(resolve => setTimeout(resolve, 4000).unref?.());
    await Promise.race([
      Promise.allSettled([mediaAuditTask, staticMediaSyncTask]),
      shutdownDeadline
    ]);
  } else {
    await Promise.allSettled([mediaAuditTask, staticMediaSyncTask]);
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
}

pool.on("error", (error) => console.error("Unexpected database pool error:", errorSummary(error)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
