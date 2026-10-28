'use strict';

const crypto = require('crypto');

let currentDay = new Date().toISOString().slice(0, 10);
const todayVisitorHashes = new Set();
let cacheInitialized = false;

const BOT_USER_AGENT_PATTERN = /bot|crawler|spider|googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|ia_archiver|lighthouse|chrome-lighthouse/i;

const STATIC_ASSET_PATTERN = /\.(?:css|js|map|png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|mp4|webm|pdf|json|xml|txt)$/i;

async function ensureCache(pool) {
  if (cacheInitialized) return;
  cacheInitialized = true;
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

async function recordVisit(pool, { path, ip, userAgent }) {
  if (!pool || typeof pool.query !== 'function') return;
  try {
    await ensureCache(pool);

    const today = new Date().toISOString().slice(0, 10);
    if (today !== currentDay) {
      currentDay = today;
      todayVisitorHashes.clear();
      cleanRealtimeIfOld(pool);
    }

    const rawId = (ip || '127.0.0.1') + '::' + (userAgent || '');
    const visitorHash = crypto.createHash('sha256').update(rawId).digest('hex').slice(0, 32);

    const isNewToday = !todayVisitorHashes.has(visitorHash);
    if (isNewToday) {
      todayVisitorHashes.add(visitorHash);
    }
    const uniqueInc = isNewToday ? 1 : 0;

    await pool.query(
      `INSERT INTO site_traffic (date, pageviews, unique_visitors, updated_at)
       VALUES (CURRENT_DATE, 1, $1, now())
       ON CONFLICT (date)
       DO UPDATE SET
         pageviews = site_traffic.pageviews + 1,
         unique_visitors = site_traffic.unique_visitors + $1,
         updated_at = now()`,
      [uniqueInc]
    );

    await pool.query(
      `INSERT INTO site_traffic_realtime (visitor_hash, path, last_seen_at)
       VALUES ($1, $2, now())
       ON CONFLICT (visitor_hash)
       DO UPDATE SET path = EXCLUDED.path, last_seen_at = now()`,
      [visitorHash, (path || '/').slice(0, 255)]
    );
  } catch {
    // Non-blocking for storefront traffic
  }
}

async function getTrafficSummary(pool) {
  if (!pool || typeof pool.query !== 'function') {
    return { todayPageviews: 0, todayVisitors: 0, totalPageviews: 0, totalVisitors: 0, activeNow: 0 };
  }
  try {
    const [todayRes, totalRes, activeRes] = await Promise.all([
      pool.query("SELECT COALESCE(pageviews, 0) AS pageviews, COALESCE(unique_visitors, 0) AS visitors FROM site_traffic WHERE date = CURRENT_DATE"),
      pool.query("SELECT COALESCE(SUM(pageviews), 0)::bigint AS total_pageviews, COALESCE(SUM(unique_visitors), 0)::bigint AS total_visitors FROM site_traffic"),
      pool.query("SELECT COUNT(*)::int AS active FROM site_traffic_realtime WHERE last_seen_at >= now() - INTERVAL '15 minutes'")
    ]);

    const today = todayRes.rows[0] || { pageviews: 0, visitors: 0 };
    const total = totalRes.rows[0] || { total_pageviews: 0, total_visitors: 0 };
    const active = (activeRes.rows[0] && activeRes.rows[0].active) || 0;

    return {
      todayPageviews: Number(today.pageviews || 0),
      todayVisitors: Number(today.visitors || 0),
      totalPageviews: Number(total.total_pageviews || 0),
      totalVisitors: Number(total.total_visitors || 0),
      activeNow: Number(active || 0)
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

    const ua = req.headers['user-agent'] || '';
    if (BOT_USER_AGENT_PATTERN.test(ua)) {
      return next();
    }

    setImmediate(() => {
      recordVisit(pool, {
        path: p,
        ip: req.ip || req.socket?.remoteAddress || '127.0.0.1',
        userAgent: ua
      }).catch(() => {});
    });

    next();
  };
}

module.exports = {
  createTrafficTracker,
  getTrafficSummary,
  recordVisit,
  _testReset() {
    todayVisitorHashes.clear();
    cacheInitialized = false;
    currentDay = new Date().toISOString().slice(0, 10);
  }
};
