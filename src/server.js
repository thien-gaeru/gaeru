try { require('node:module').enableCompileCache?.(); } catch (_) {}
let stopOrderEmail;let stopChatFileRetention;let stopTikTokAds;
require("dotenv").config();
const expressSession = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { loadConfig } = require("./config");
const dbModule = require("./db");
const { createPool, inspectDatabaseTls } = dbModule;
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
let mediaRetryTimer = null;
const workerTimeouts = [];
function scheduleWorker(fn, delayMs) {
  if (shuttingDown) return;
  const safeFn = () => {
    if (shuttingDown) return;
    try {
      const res = fn();
      if (res && typeof res.catch === 'function') {
        res.catch(err => {
          console.error('Async worker error:', errorSummary(err));
        });
      }
    } catch (err) {
      console.error('Worker failed to start:', errorSummary(err));
    }
  };
  if (typeof setTimeout === 'undefined' || process.env.NODE_ENV === 'test' || delayMs === 0) {
    safeFn();
    return;
  }
  const t = setTimeout(safeFn, delayMs);
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
  // High-concurrency socket tuning & Cloudflare reverse proxy keep-alive alignment
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 30000;
  server.maxHeadersCount = 2000;
  server.on('error', (error) => {
    console.error('GAERU listener failed:', errorSummary(error));
    process.exitCode = 1;
    void shutdown();
  });

  // Phase 2: Run critical database migrations while incoming traffic is gated safely
  await migrateDatabase(pool, { lockTimeoutMs: 30000 });
  if (shuttingDown) return;

  // GAERU P2-02: Priority DB concurrency semaphore covering BOTH pool.query() and pool.connect()
  const buildFallbackPriorityController = (targetPool, maxLow = 2) => {
    let activeHighOps = 0;
    let activeLowOps = 0;
    const lowWaitQueue = [];
    const pumpLowQueue = () => {
      while (activeHighOps === 0 && activeLowOps < maxLow && lowWaitQueue.length > 0) {
        activeLowOps++;
        const resume = lowWaitQueue.shift();
        resume();
      }
    };
    const acquireSlot = async (priority) => {
      if (priority === 'high') {
        activeHighOps++;
        let released = false;
        return () => { if (!released) { released = true; activeHighOps = Math.max(0, activeHighOps - 1); pumpLowQueue(); } };
      }
      if (activeHighOps > 0 || activeLowOps >= maxLow) {
        await new Promise(resolve => lowWaitQueue.push(resolve));
      } else {
        activeLowOps++;
      }
      let released = false;
      return () => { if (!released) { released = true; activeLowOps = Math.max(0, activeLowOps - 1); pumpLowQueue(); } };
    };
    const wrap = (priority) => {
      if (!targetPool || (typeof targetPool.query !== 'function' && typeof targetPool.connect !== 'function')) return targetPool;
      return new Proxy(targetPool, {
        get(t, prop) {
          if (prop === 'query' && typeof t.query === 'function') {
            return async (...args) => {
              const releaseSlot = await acquireSlot(priority);
              try { return await t.query(...args); } finally { releaseSlot(); }
            };
          }
          if (prop === 'connect' && typeof t.connect === 'function') {
            return async (...args) => {
              const releaseSlot = await acquireSlot(priority);
              let client;
              try { client = await t.connect(...args); } catch (err) { releaseSlot(); throw err; }
              if (!client || typeof client !== 'object') { releaseSlot(); return client; }
              const origRelease = typeof client.release === 'function' ? client.release.bind(client) : () => {};
              return new Proxy(client, {
                get(cTarget, cProp) {
                  if (cProp === 'release') return (...relArgs) => { try { return origRelease(...relArgs); } finally { releaseSlot(); } };
                  const val = Reflect.get(cTarget, cProp, cTarget);
                  return typeof val === 'function' ? val.bind(cTarget) : val;
                }
              });
            };
          }
          const val = Reflect.get(t, prop, t);
          return typeof val === 'function' ? val.bind(t) : val;
        }
      });
    };
    return { highPriorityPool: wrap('high'), lowPriorityPool: wrap('low'), getStats: () => ({ activeHighOps, activeLowOps, queuedLowOps: lowWaitQueue.length, maxLowPriorityOps: maxLow }) };
  };
  const poolMax = Number.parseInt(pool?.options?.max || 30, 10);
  const maxLowPriorityOps = Math.max(4, Math.floor(poolMax * 0.20));
  const maxHighPriorityOps = Math.max(16, poolMax - maxLowPriorityOps);
  const priorityController = typeof dbModule.createPriorityPoolController === 'function'
    ? dbModule.createPriorityPoolController(pool, { maxLowPriorityOps, maxHighPriorityOps })
    : buildFallbackPriorityController(pool, maxLowPriorityOps);
  const { highPriorityPool, lowPriorityPool } = priorityController;


  // Background workers initialization with staggered startup and priority concurrency cap (A10 / P2-02)
  const isBackgroundWorker = !process.env.CLUSTER_WORKER || process.env.WORKER_INDEX === '0';
  if (isBackgroundWorker) {
    scheduleWorker(() => { stopOrderEmail = require("./order-email").startOrderEmailWorker(highPriorityPool, config); }, 0);
    scheduleWorker(() => { stopWarrantyEmail = require("./warranty-email").startWarrantyEmailWorker(highPriorityPool, config); }, 500);
    scheduleWorker(() => { stopCareEmail = require("./care-api").startCareEmailWorker(highPriorityPool, config); }, 1000);
    scheduleWorker(() => { stopAIChat = require('./shopping-chat-ai-first').startAIChatWorker(lowPriorityPool, config); }, 1500);
    scheduleWorker(() => { stopChatEmail = require('./shopping-chat-email').startChatEmailWorker(lowPriorityPool, config); }, 2000);
    scheduleWorker(() => { stopChatCompression = require('./shopping-chat-compression').startChatCompressionWorker(lowPriorityPool); }, 2500);
    scheduleWorker(() => { stopTikTokAds = require('./tiktok-ads').startTikTokAdsWorker(lowPriorityPool, config); }, 3000);
    scheduleWorker(() => { stopAbandonedCart = require("./abandoned-cart").startAbandonedCartWorker(lowPriorityPool, config); }, 3500);
    scheduleWorker(() => { stopEmail = require("./email-marketing").startEmailWorker(lowPriorityPool, config); }, 4000);
    scheduleWorker(() => { stopChatFileRetention = require('./shopping-chat-file-retention').startChatFileRetentionWorker(lowPriorityPool); }, 4500);
    scheduleWorker(() => { stopRetention = require("./account-retention").startRetentionWorker(lowPriorityPool); }, 5000);
    scheduleWorker(() => { require("./shipping-adapters").syncViettelProvinceCatalog().catch(() => {}); }, 5500);
  }

  // Non-blocking media probe and asynchronous asset sync in the background
  const mediaCheck=await require('./lib/filesystem-media').probe();
  console.log('Media storage:',JSON.stringify(mediaCheck));
  const mediaAudit=require('./media-storage-audit');
  if(mediaCheck.verified){
    // GAERU F-06 & OPS-01: Mark Readiness Gate as READY once DB migrations and filesystem probe succeed; run static media sync asynchronously
    setReady(true);
    if (typeof process.send === 'function') {
      try { process.send({ type: 'WORKER_READY', workerIndex: process.env.WORKER_INDEX || '0' }); } catch (_) {}
    }
    staticMediaSyncTask = require('./persistent-assets').syncAssets(pool)
      .then(res => console.log('Static media:', JSON.stringify(res)))
      .catch(err => console.error('Static media sync failed:', errorSummary(err)));
  }else{
    const checkedMedia=await mediaAudit.auditMediaStorage(pool,{probeStatus:mediaCheck});
    console.log('Local media checks:',JSON.stringify({state:checkedMedia.state,failedChecks:checkedMedia.failedChecks,legacyReferences:checkedMedia.legacyReferences}));
    if (checkedMedia.state === 'verified') {
      setReady(true);
      if (typeof process.send === 'function') {
        try { process.send({ type: 'WORKER_READY', workerIndex: process.env.WORKER_INDEX || '0' }); } catch (_) {}
      }
    } else {
      console.log('Local media checks unverified; readiness gate remains closed until media storage is verified.');
      if (!mediaRetryTimer && !shuttingDown && typeof setInterval !== 'undefined') {
        mediaRetryTimer = setInterval(async () => {
          if (shuttingDown) {
            if (typeof clearInterval !== 'undefined') clearInterval(mediaRetryTimer);
            return;
          }
          try {
            const retryCheck = await require('./lib/filesystem-media').probe();
            if (retryCheck.verified) {
              if (typeof clearInterval !== 'undefined') clearInterval(mediaRetryTimer);
              mediaRetryTimer = null;
              console.log('Media storage verified via retry probe; opening readiness gate.');
              setReady(true);
              if (typeof process.send === 'function') {
                try { process.send({ type: 'WORKER_READY', workerIndex: process.env.WORKER_INDEX || '0' }); } catch (_) {}
              }
              staticMediaSyncTask = require('./persistent-assets').syncAssets(pool)
                .then(res => console.log('Static media (retry):', JSON.stringify(res)))
                .catch(err => console.error('Static media sync failed (retry):', errorSummary(err)));
            }
          } catch (err) {
            console.warn('Media probe retry error:', errorSummary(err));
          }
        }, 10000);
        if (mediaRetryTimer?.unref) mediaRetryTimer.unref();
      }
    }
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
      try {
        const m = process.memoryUsage();
        const stats = typeof priorityController?.getStats === 'function' ? priorityController.getStats() : {};
        console.log('[GAERU_RESOURCES]', JSON.stringify({
          rssMB: Math.round(m.rss / 1048576),
          heapMB: Math.round(m.heapUsed / 1048576),
          externalMB: Math.round(m.external / 1048576),
          eventLoopP95Ms: Math.round(lag.percentile(95) / 1e6),
          dbPoolTotal: Number(pool?.totalCount || 0),
          dbPoolIdle: Number(pool?.idleCount || 0),
          dbPoolWaiting: Number(pool?.waitingCount || 0),
          bgWorkerHighActive: stats.activeHighOps ?? 0,
          bgWorkerLowActive: stats.activeLowOps ?? 0,
          bgWorkerLowQueued: stats.queuedLowOps ?? 0
        }));
        lag.reset();
      } catch (err) {
        console.error('Resource monitor failed:', err?.message || err);
      }
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
  if (mediaRetryTimer && typeof clearInterval !== 'undefined') {
    clearInterval(mediaRetryTimer);
    mediaRetryTimer = null;
  }
  if (resourceMonitor) clearInterval(resourceMonitor);
  if (typeof clearTimeout !== 'undefined') workerTimeouts.forEach(t => clearTimeout(t));

  // 1. Immediately close long-running SSE connections and HTTP sockets
  try { require('./realtime-sse').closeAllSseStreams?.(); } catch (_) {}
  if (server) {
    try { server.closeIdleConnections?.(); } catch (_) {}
    try { server.closeAllConnections?.(); } catch (_) {}
    const closePromise = new Promise(resolve => server.close(resolve));
    const closeTimeout = new Promise(resolve => setTimeout(resolve, 2000).unref?.());
    await Promise.race([closePromise, closeTimeout]).catch(() => {});
  }

  // 2. Stop all background workers immediately
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

  // 3. Settle in-flight startup work bounded by a 2.5-second deadline so shutdown is never hung by slow startup
  if (typeof setTimeout !== 'undefined') {
    const startupDeadline = new Promise(resolve => setTimeout(resolve, 2500).unref?.());
    await Promise.race([
      startTask.catch(() => {}),
      startupDeadline
    ]);
  } else {
    await startTask.catch(() => {});
  }

  // 4. Background conversion, verification and media sync bounded by a 4-second deadline (A15)
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
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection in server runtime:", errorSummary(reason));
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception in server runtime:", errorSummary(error));
});
