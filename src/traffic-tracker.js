'use strict';

const crypto = require('crypto');

let currentDay = new Date().toISOString().slice(0, 10);
const todayVisitorHashes = new Set();
let cacheInitialized = false;
const initializedPools = new WeakSet();
const batchQueues = new WeakMap();

const BOT_USER_AGENT_PATTERN = /bot|crawler|spider|googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|ia_archiver|lighthouse|chrome-lighthouse/i;

const STATIC_ASSET_PATTERN = /\.(?:css|js|map|png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|mp4|webm|pdf|json|xml|txt)$/i;

async function ensureCache(pool) {
  if (cacheInitialized && initializedPools.has(pool)) return;
  cacheInitialized = true;
  if (pool && typeof pool === 'object') initializedPools.add(pool);
  try {
    const res = await pool.query("SELECT visitor_hash FROM site_traffic_realtime WHERE last_seen_at >= CURRENT_DATE");
    for (const row of res.rows) {
      todayVisitorHashes.add(row.visitor_hash);
    }
  } catch {
    // Graceful fallback if table is not yet created
  }
}

function cleanRealtimeIfOld(pool) {
  pool.query("DELETE FROM site_traffic_realtime WHERE last_seen_at < now() - INTERVAL '24 hours'").catch(() => {});
}

function computeVisitDelta({ path, ip, userAgent }, pool) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDay) {
    currentDay = today;
    todayVisitorHashes.clear();
    if (pool) cleanRealtimeIfOld(pool);
  }
  const rawId = (ip || '127.0.0.1') + '::' + (userAgent || '');
  const visitorHash = crypto.createHash('sha256').update(rawId).digest('hex').slice(0, 32);
  const isNewToday = !todayVisitorHashes.has(visitorHash);
  if (isNewToday) {
    todayVisitorHashes.add(visitorHash);
  }
  return {
    visitorHash,
    path: (path || '/').slice(0, 255),
    uniqueInc: isNewToday ? 1 : 0
  };
}

async function applyVisitsBatch(pool, visits) {
  if (!pool || typeof pool.query !== 'function' || !visits.length) return;
  try {
    await ensureCache(pool);
    let pageviewsInc = 0;
    let uniqueInc = 0;
    const latestPathByVisitor = new Map();

    for (const v of visits) {
      const delta = computeVisitDelta(v, pool);
      pageviewsInc += 1;
      uniqueInc += delta.uniqueInc;
      latestPathByVisitor.set(delta.visitorHash, delta.path);
    }

    await pool.query(
      `INSERT INTO site_traffic (date, pageviews, unique_visitors, updated_at)
       VALUES (CURRENT_DATE, $1, $2, now())
       ON CONFLICT (date)
       DO UPDATE SET
         pageviews = site_traffic.pageviews + $1,
         unique_visitors = site_traffic.unique_visitors + $2,
         updated_at = now()`,
      [pageviewsInc, uniqueInc]
    );

    const entries = [...latestPathByVisitor.entries()];
    if (entries.length === 1) {
      await pool.query(
        `INSERT INTO site_traffic_realtime (visitor_hash, path, last_seen_at)
         VALUES ($1, $2, now())
         ON CONFLICT (visitor_hash)
         DO UPDATE SET path = EXCLUDED.path, last_seen_at = now()`,
        [entries[0][0], entries[0][1]]
      );
    } else if (entries.length > 1) {
      const params = [];
      const placeholders = entries.map(([hash, p], idx) => {
        params.push(hash, p);
        return `($${idx * 2 + 1}, $${idx * 2 + 2}, now())`;
      }).join(', ');
      await pool.query(
        `INSERT INTO site_traffic_realtime (visitor_hash, path, last_seen_at)
         VALUES ${placeholders}
         ON CONFLICT (visitor_hash)
         DO UPDATE SET path = EXCLUDED.path, last_seen_at = now()`,
        params
      );
    }
  } catch {
    // Non-blocking for storefront traffic
  }
}

async function flushPendingVisits(pool) {
  if (!pool || typeof pool !== 'object') return;
  const state = batchQueues.get(pool);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.items.length) {
    const batch = state.items.splice(0, state.items.length);
    const prev = state.inflight || Promise.resolve();
    state.inflight = prev.then(() => applyVisitsBatch(pool, batch)).catch(() => {});
  }
  if (state.inflight) {
    await state.inflight;
  }
}

function enqueueVisit(pool, visit, delayMs = 120) {
  if (!pool || typeof pool.query !== 'function') return;
  let state = batchQueues.get(pool);
  if (!state) {
    state = { items: [], timer: null, inflight: null };
    batchQueues.set(pool, state);
  }
  state.items.push(visit);
  if (!state.timer) {
    state.timer = setTimeout(() => {
      flushPendingVisits(pool).catch(() => {});
    }, delayMs);
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }
}

async function recordVisit(pool, { path, ip, userAgent }) {
  if (!pool || typeof pool.query !== 'function') return;
  await applyVisitsBatch(pool, [{ path, ip, userAgent }]);
}

async function getTrafficSummary(pool) {
  if (!pool || typeof pool.query !== 'function') {
    return { todayPageviews: 0, todayVisitors: 0, totalPageviews: 0, totalVisitors: 0, activeNow: 0 };
  }
  try {
    await flushPendingVisits(pool);
    const res = await pool.query(
      `SELECT
         COALESCE((SELECT pageviews FROM site_traffic WHERE date = CURRENT_DATE), 0)::bigint AS today_pageviews,
         COALESCE((SELECT unique_visitors FROM site_traffic WHERE date = CURRENT_DATE), 0)::bigint AS today_visitors,
         COALESCE((SELECT SUM(pageviews) FROM site_traffic), 0)::bigint AS total_pageviews,
         COALESCE((SELECT SUM(unique_visitors) FROM site_traffic), 0)::bigint AS total_visitors,
         COALESCE((SELECT COUNT(*) FROM site_traffic_realtime WHERE last_seen_at >= now() - INTERVAL '15 minutes'), 0)::int AS active`
    );
    const row = res.rows[0] || {};
    return {
      todayPageviews: Number(row.today_pageviews || 0),
      todayVisitors: Number(row.today_visitors || 0),
      totalPageviews: Number(row.total_pageviews || 0),
      totalVisitors: Number(row.total_visitors || 0),
      activeNow: Number(row.active || 0)
    };
  } catch {
    return {
      todayPageviews: 0,
      todayVisitors: 0,
      totalPageviews: 0,
      totalVisitors: 0,
      activeNow: 0
    };
  }
}

function createTrafficTracker(pool) {
  return function trafficTracker(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const p = req.path || '/';
    if (
      p.startsWith('/api/') ||
      p.startsWith('/gaeru_ceo') ||
      p.startsWith('/admin') ||
      p.startsWith('/media/') ||
      p.startsWith('/assets/') ||
      STATIC_ASSET_PATTERN.test(p)
    ) {
      return next();
    }

    const secPurpose = String(req.headers['sec-purpose'] || '');
    if (secPurpose.includes('prerender') || secPurpose.includes('prefetch')) {
      return next();
    }

    const ua = req.headers['user-agent'] || '';
    if (BOT_USER_AGENT_PATTERN.test(ua)) {
      return next();
    }

    const visit = {
      path: p,
      ip: req.ip || req.socket?.remoteAddress || '127.0.0.1',
      userAgent: ua
    };

    if (res && typeof res.once === 'function') {
      res.once('finish', () => enqueueVisit(pool, visit));
    } else {
      enqueueVisit(pool, visit, 10);
    }

    next();
  };
}

module.exports = {
  createTrafficTracker,
  getTrafficSummary,
  recordVisit,
  flushPendingVisits,
  _testReset() {
    todayVisitorHashes.clear();
    cacheInitialized = false;
    currentDay = new Date().toISOString().slice(0, 10);
  }
};
