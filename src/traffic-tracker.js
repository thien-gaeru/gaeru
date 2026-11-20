'use strict';

const crypto = require('node:crypto');

const batchQueues = new WeakMap();
const lastGoodSummary = new WeakMap();
const MAX_QUEUED_VISITS = 2000;
const BOT_USER_AGENT_PATTERN = /bot|crawler|spider|googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|ia_archiver|lighthouse|chrome-lighthouse/i;
const STATIC_ASSET_PATTERN = /\.(?:css|js|map|png|jpe?g|webp|gif|svg|ico|avif|woff2?|ttf|mp4|webm|pdf|json|xml|txt)$/i;

function visitRecord(visit) {
  const raw = (visit.ip || '127.0.0.1') + '::' + (visit.userAgent || '');
  return { hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0,32),
    path: (visit.path || '/').slice(0,255), at: new Date().toISOString() };
}

// A repeated batch after a lost database response must not increment pageviews again.
const WRITE_BATCH = `
  WITH receipt AS (
    INSERT INTO site_traffic_batch_receipts(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id
  ), visits AS (
    SELECT v.*, (at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day
    FROM jsonb_to_recordset($2::jsonb) AS v(hash text, path text, at timestamptz), receipt
  ), first_today AS (
    INSERT INTO site_traffic_daily_visitors(visit_date,visitor_hash)
    SELECT DISTINCT day,hash FROM visits ORDER BY day,hash
    ON CONFLICT DO NOTHING RETURNING visit_date
  ), realtime AS (
    INSERT INTO site_traffic_realtime(visitor_hash,path,last_seen_at)
    SELECT DISTINCT ON(hash) hash,path,at FROM visits ORDER BY hash,at DESC
    ON CONFLICT(visitor_hash) DO UPDATE SET path=EXCLUDED.path,last_seen_at=EXCLUDED.last_seen_at
      WHERE site_traffic_realtime.last_seen_at <= EXCLUDED.last_seen_at
  )
  INSERT INTO site_traffic(date,pageviews,unique_visitors)
  SELECT day,count(*)::int,(SELECT count(*) FROM first_today WHERE visit_date=visits.day)::int
  FROM visits GROUP BY day ORDER BY day
  ON CONFLICT(date) DO UPDATE SET pageviews=site_traffic.pageviews+EXCLUDED.pageviews,
    unique_visitors=site_traffic.unique_visitors+EXCLUDED.unique_visitors,updated_at=now()`;

function queueState(pool) {
  let state = batchQueues.get(pool);
  if (!state) {
    state = { items: [], pending: null, running: null, timer: null, failures: 0, dropped: 0, lastCleanup: 0 };
    batchQueues.set(pool,state);
  }
  return state;
}

function scheduleFlush(pool, state, delay) {
  if (state.timer || state.running) return;
  state.timer = setTimeout(() => { state.timer = null; void flushPendingVisits(pool); }, delay);
  state.timer.unref?.();
}

async function drain(pool,state) {
  while (state.pending || state.items.length) {
    state.pending ||= { id: crypto.randomUUID(), visits: state.items.splice(0,200) };
    try {
      await pool.query(WRITE_BATCH, [state.pending.id, JSON.stringify(state.pending.visits)]);
      state.pending = null;
      state.failures = 0;
    } catch {
      if (!state.failures) console.warn('Traffic counter write failed; queued measurements will be retried.');
      state.failures++;
      return;
    }
  }
  if (Date.now() - state.lastCleanup >= 86400000) {
    state.lastCleanup = Date.now();
    try {
      await pool.query("DELETE FROM site_traffic_daily_visitors WHERE visit_date < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 2");
      await pool.query("DELETE FROM site_traffic_batch_receipts WHERE recorded_at < now() - interval '2 days'");
      await pool.query("DELETE FROM site_traffic_realtime WHERE last_seen_at < now() - interval '24 hours'");
    } catch { console.warn('Traffic counter retention cleanup could not finish.'); }
  }
}

async function flushPendingVisits(pool) {
  if (!pool || typeof pool.query !== 'function') return;
  const state = queueState(pool);
  clearTimeout(state.timer);
  state.timer = null;
  if (!state.running) {
    state.running = drain(pool,state).finally(() => {
      state.running = null;
      if (state.pending || state.items.length) scheduleFlush(pool,state,state.failures ? Math.min(60000,1000 * 2 ** Math.min(6,state.failures)) : 120);
    });
  }
  return state.running;
}

function enqueueVisit(pool,visit,delayMs = 120) {
  if (!pool || typeof pool.query !== 'function') return;
  const state = queueState(pool);
  if (state.items.length >= MAX_QUEUED_VISITS) {
    state.dropped++;
    if (state.dropped === 1) console.warn('Traffic counter buffer full; some measurements were dropped.');
    return;
  }
  state.items.push(visitRecord(visit));
  if (!state.failures && state.items.length >= 200) { void flushPendingVisits(pool); return; }
  scheduleFlush(pool,state,delayMs);
}

async function recordVisit(pool,visit) {
  enqueueVisit(pool,visit);
  await flushPendingVisits(pool);
}

async function getTrafficSummary(pool) {
  const unavailable = () => ({ availability:'unavailable', measuredAt:lastGoodSummary.get(pool)?.measuredAt || null,
    todayPageviews:null, todayVisitors:null, totalPageviews:null, totalVisitors:null, activeNow:null });
  if (!pool || typeof pool.query !== 'function') return unavailable();
  try {
    await flushPendingVisits(pool);
    const { rows } = await pool.query(`SELECT
      COALESCE((SELECT pageviews FROM site_traffic WHERE date=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),0) AS today_pageviews,
      COALESCE((SELECT unique_visitors FROM site_traffic WHERE date=(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),0) AS today_visitors,
      COALESCE((SELECT SUM(pageviews) FROM site_traffic),0) AS total_pageviews,
      COALESCE((SELECT SUM(unique_visitors) FROM site_traffic),0) AS total_visitors,
      (SELECT count(*) FROM site_traffic_realtime WHERE last_seen_at>=now()-interval '15 minutes') AS active`);
    const row=rows[0];
    if (!row) return unavailable();
    const state=queueState(pool);
    const summary={ availability:state.failures || state.dropped ? 'partial' : 'measured', measuredAt:new Date().toISOString(),
      todayPageviews:Number(row.today_pageviews), todayVisitors:Number(row.today_visitors),
      totalPageviews:Number(row.total_pageviews), totalVisitors:Number(row.total_visitors), activeNow:Number(row.active) };
    lastGoodSummary.set(pool,summary);
    return summary;
  } catch { return unavailable(); }
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
      ['/readyz', '/livez', '/healthz', '/health'].includes(p) ||
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
      res.once('finish', () => {
        const statusCode = res.statusCode ?? 200;
        if (statusCode >= 200 && statusCode < 300) enqueueVisit(pool, visit);
      });
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
  _testReset() {}
};
