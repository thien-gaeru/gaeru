'use strict';
const { Router } = require('express');
const { z } = require('zod');

const STATES = ['pending', 'retry', 'processing', 'unknown', 'dead', 'completed', 'skipped'];
const emailState = `CASE WHEN status='pending' AND COALESCE(attempts,0)>0 THEN 'retry'
  WHEN status='sending' THEN 'processing' WHEN status='failed' THEN 'dead'
  WHEN status='sent' THEN 'completed' ELSE status END`;
const plainEmail = table => `SELECT id,status,attempts,created_at,next_attempt_at,attempted_at,finished_at,
  NULL::timestamptz AS lease_until,NULL::text AS error_code,false AS retry_allowed,
  status='sending' AND attempted_at<now()-interval '2 minutes' AS stale FROM ${table}`;

// SQL identifiers and projections are entirely server-owned. Never accept table,
// column names or arbitrary order expressions from a request.
const QUEUES = Object.freeze([
  { id: 'order-email', title: 'Email đơn hàng và tạo tài khoản', href: '#orders', kind: 'email', state: emailState, sql: plainEmail('order_email_outbox') },
  { id: 'order-admin-email', title: 'Email báo đơn cho quản trị', href: '#orders', kind: 'email', state: emailState,
    sql: `SELECT q.id,q.status,q.attempts,o.created_at,q.next_attempt_at,q.attempted_at,q.finished_at,
      NULL::timestamptz AS lease_until,NULL::text AS error_code,false AS retry_allowed,
      q.status='sending' AND q.attempted_at<now()-interval '2 minutes' AS stale
      FROM order_admin_email_outbox q JOIN orders o ON o.id=q.order_id` },
  { id: 'chat-email', title: 'Email hội thoại hỗ trợ', href: '#shopping-chat', kind: 'email', state: emailState, sql: plainEmail('shopping_chat_email_outbox') },
  { id: 'care-email', title: 'Email GAERU Care+', href: '#care', kind: 'email', state: emailState, sql: plainEmail('care_email_outbox') },
  { id: 'warranty-email', title: 'Email kích hoạt bảo hành', href: '#warranty', kind: 'email', state: emailState, sql: plainEmail('warranty_email_outbox') },
  { id: 'marketing-email', title: 'Email chiến dịch', href: '#marketing', kind: 'email', state: emailState,
    sql: `SELECT r.id,r.status,NULL::integer AS attempts,c.created_at,c.scheduled_at AS next_attempt_at,
      r.attempted_at,r.finished_at,NULL::timestamptz AS lease_until,NULL::text AS error_code,false AS retry_allowed,
      r.status='sending' AND r.attempted_at<now()-interval '2 minutes' AS stale
      FROM marketing_email_recipients r JOIN marketing_email_campaigns c ON c.id=r.campaign_id` },
  { id: 'chat-compression', title: 'Tối ưu tệp hội thoại', href: '#shopping-chat', kind: 'compression',
    state: `CASE WHEN status='pending' AND attempts>0 THEN 'retry' WHEN status='failed' THEN 'dead'
      WHEN status IN ('compressed','optimal') THEN 'completed' ELSE status END`,
    sql: `SELECT id,compression_status AS status,compression_attempts AS attempts,created_at,
      compression_next_attempt_at AS next_attempt_at,NULL::timestamptz AS attempted_at,NULL::timestamptz AS finished_at,
      compression_lease_until AS lease_until,compression_last_error AS error_code,
      created_at>now()-interval '30 days' AND (compression_status='failed' OR
        (compression_status='processing' AND (compression_lease_until IS NULL OR compression_lease_until<now()))) AS retry_allowed,
      compression_status='processing' AND (compression_lease_until IS NULL OR compression_lease_until<now()) AS stale
      FROM shopping_chat_files WHERE deleted_at IS NULL` },
  { id: 'carrier-shipment', title: 'Yêu cầu tạo vận đơn', href: '#shipping', kind: 'carrier',
    state: `CASE WHEN status='sending' THEN 'processing' WHEN status IN ('succeeded','reconciled') THEN 'completed' ELSE status END`,
    sql: `SELECT id,status,NULL::integer AS attempts,created_at,NULL::timestamptz AS next_attempt_at,
      created_at AS attempted_at,CASE WHEN status IN ('succeeded','reconciled') THEN updated_at END AS finished_at,
      NULL::timestamptz AS lease_until,NULL::text AS error_code,false AS retry_allowed,
      status='sending' AND created_at<now()-interval '5 minutes' AS stale FROM carrier_shipment_attempts` }
]);

const queueById = new Map(QUEUES.map(queue => [queue.id, queue]));
const querySchema = z.object({
  state: z.enum(['all', ...STATES]).default('all'),
  page: z.coerce.number().int().min(1).max(10000).default(1)
}).strict();
const cte = queue => `WITH source AS (${queue.sql}), jobs AS (SELECT *,${queue.state} AS state FROM source)`;
const queueInfo = queue => ({ id: queue.id, title: queue.title, href: queue.href, kind: queue.kind });
const ownerOnly = (req, res, next) => {
  if (!req.admin) return res.status(401).json({ error: 'Vui lòng đăng nhập quản trị.' });
  if (req.admin.role !== 'owner' || req.admin.source !== 'bootstrap') {
    return res.status(403).json({ error: 'Chỉ chủ doanh nghiệp được xem toàn bộ hàng đợi vận hành.' });
  }
  next();
};

async function summarizeQueue(pool, queue) {
  try {
    const rows = (await pool.query(`${cte(queue)} SELECT state,count(*)::int AS count,
      min(created_at) AS oldest_created_at,min(next_attempt_at) FILTER(WHERE state IN ('pending','retry')) AS next_due_at,
      max(attempted_at) AS last_attempted_at,max(finished_at) AS last_finished_at,
      count(*) FILTER(WHERE stale)::int AS stale_count FROM jobs GROUP BY state`)).rows;
    const counts = Object.fromEntries(STATES.map(state => [state, 0]));
    let staleCount = 0;
    const timestamps = { oldestPendingAt: null, nextDueAt: null, lastAttemptedAt: null, lastFinishedAt: null };
    const choose = (key, value, earliest) => {
      if (value && (!timestamps[key] || (earliest ? new Date(value) < new Date(timestamps[key]) : new Date(value) > new Date(timestamps[key])))) timestamps[key] = value;
    };
    for (const row of rows) {
      if (STATES.includes(row.state)) counts[row.state] = Number(row.count);
      staleCount += Number(row.stale_count || 0);
      if (['pending', 'retry'].includes(row.state)) choose('oldestPendingAt', row.oldest_created_at, true);
      choose('nextDueAt', row.next_due_at, true);
      choose('lastAttemptedAt', row.last_attempted_at, false);
      choose('lastFinishedAt', row.last_finished_at, false);
    }
    return { ...queueInfo(queue), availability: 'measured', counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      staleCount, health: counts.unknown || counts.dead || staleCount ? 'attention' : 'measured', ...timestamps };
  } catch {
    // A missing migration or unavailable database must never appear as zero jobs.
    return { ...queueInfo(queue), availability: 'unavailable', health: 'unavailable', counts: null, total: null };
  }
}

function createOperationsQueues(pool, config = {}) {
  const router = Router();
  router.use('/owner/operations/queues', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, ownerOnly);
  router.get('/owner/operations/queues', async (_req, res) => {
    const queues = await Promise.all(QUEUES.map(queue => summarizeQueue(pool, queue)));
    res.json({ checkedAt: new Date().toISOString(), queues, senderConfigured: Boolean(config.smtp?.from),
      workerHeartbeat: 'not_measured', note: 'Số liệu từ cơ sở dữ liệu tại thời điểm kiểm tra; chưa đo nhịp hoạt động của tiến trình nền. SMTP tiếp nhận chưa xác nhận thư đến hộp thư.' });
  });
  router.get('/owner/operations/queues/:queueId/jobs', async (req, res) => {
    const queue = queueById.get(req.params.queueId);
    if (!queue) return res.status(404).json({ error: 'Không tìm thấy hàng đợi.' });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Bộ lọc hoặc số trang không hợp lệ.' });
    const { state, page } = parsed.data;
    try {
      const filter = `WHERE ($1='all' OR state=$1)`;
      const total = Number((await pool.query(`${cte(queue)} SELECT count(*)::int AS count FROM jobs ${filter}`, [state])).rows[0].count);
      const rows = (await pool.query(`${cte(queue)} SELECT id,status,state,attempts,created_at AS "createdAt",
        next_attempt_at AS "nextAttemptAt",attempted_at AS "attemptedAt",finished_at AS "finishedAt",
        lease_until AS "leaseUntil",error_code AS "errorCode",retry_allowed AS "retryAllowed",stale
        FROM jobs ${filter} ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $2`, [state, (page - 1) * 20])).rows;
      const jobs = rows.map(row => ({ ...row, errorCode: /^[A-Z0-9_]{1,50}$/.test(row.errorCode || '') ? row.errorCode : null,
        retryAllowed: queue.kind === 'compression' && row.retryAllowed === true }));
      res.json({ queue: queueInfo(queue), jobs, state, page, pageSize: 20, total, checkedAt: new Date().toISOString() });
    } catch {
      res.status(503).json({ error: 'Chưa đọc được hàng đợi này. Kiểm tra kết nối dữ liệu và phiên bản cơ sở dữ liệu rồi thử lại.' });
    }
  });
  return router;
}
module.exports = { createOperationsQueues, summarizeQueue, QUEUES, STATES };
