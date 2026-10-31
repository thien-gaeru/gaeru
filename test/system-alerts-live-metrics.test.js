'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers/pglite-db');
const { alertSystem, createSystemAlertsAdmin } = require('../src/system-alerts');

test('System Alerts: Live PostgreSQL logging, 10-minute anti-flood deduplication, Telegram and Webhook dispatch', async (t) => {
  const { db, pool } = await createTestDb();

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
        source text NOT NULL,
        message text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        sent_at timestamptz DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS system_alerts_severity_idx ON system_alerts (severity, created_at DESC);
    `);

    const calls = [];
    const mockFetcher = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const config = {
      ALERT_TELEGRAM_BOT_TOKEN: 'test_token',
      ALERT_TELEGRAM_CHAT_ID: '123456',
      ALERT_WEBHOOK_URL: 'https://webhook.internal/test'
    };

    await t.test('1. First Alert: Logs to database and dispatches Telegram and Webhook', async () => {
      const res = await alertSystem(pool, {
        severity: 'critical',
        source: 'payment_retry',
        message: 'Cổng thanh toán MoMo timeout sau 3 lần thử',
        metadata: { orderCode: 'GR-TEST-01' },
        config
      }, mockFetcher);

      assert.equal(res.logged, true);
      assert.equal(res.alerted, true);
      assert.equal(res.isDuplicate, false);

      const rows = (await pool.query('SELECT severity, source, message FROM system_alerts')).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].severity, 'critical');

      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.includes('telegram.org'));
      assert.match(calls[0].body.text, /🔥/);
      assert.ok(calls[1].url.includes('webhook.internal'));
    });

    await t.test('2. Anti-Flood: Suppresses duplicate external dispatch within 10 minutes but saves to DB', async () => {
      calls.length = 0;

      const res = await alertSystem(pool, {
        severity: 'critical',
        source: 'payment_retry',
        message: 'Cổng thanh toán MoMo timeout sau 3 lần thử',
        metadata: { retryAttempt: 2 },
        config
      }, mockFetcher);

      assert.equal(res.logged, true);
      assert.equal(res.isDuplicate, true);
      assert.equal(res.alerted, false);
      assert.equal(calls.length, 0);

      const count = (await pool.query('SELECT count(*)::int as count FROM system_alerts')).rows[0].count;
      assert.equal(count, 2);
    });

    await t.test('3. Fail-Safe Resilience: Network failure does not throw or crash application', async () => {
      const failingFetcher = async () => {
        throw new Error('ETIMEDOUT');
      };

      const res = await alertSystem(pool, {
        severity: 'error',
        source: 'db_pool',
        message: 'Kết nối CSDL bị chậm',
        config
      }, failingFetcher);

      assert.equal(res.logged, true);
      assert.equal(res.alerted, false);
    });

    await t.test('4. Admin Router: Exposes GET /system-alerts and POST /system-alerts/test', async () => {
      const router = createSystemAlertsAdmin(pool, config);
      assert.ok(router);

      // GET /system-alerts
      let getBody = null;
      const reqGet = { admin: { permissions: ['dashboard.read'] } };
      const resGet = { status() { return this; }, json(b) { getBody = b; return this; } };
      const getLayer = router.stack.find(l => l.route && l.route.path === '/system-alerts');
      await getLayer.route.stack[getLayer.route.stack.length - 1].handle(reqGet, resGet, () => {});

      assert.ok(Array.isArray(getBody.alerts));
      assert.ok(getBody.alerts.length >= 3);

      // POST /system-alerts/test
      let postBody = null;
      const reqPost = { admin: { username: 'admin', permissions: ['settings.write'] } };
      const resPost = { status() { return this; }, json(b) { postBody = b; return this; } };
      const postLayer = router.stack.find(l => l.route && l.route.path === '/system-alerts/test');
      await postLayer.route.stack[postLayer.route.stack.length - 1].handle(reqPost, resPost, () => {});

      assert.equal(postBody.ok, true);
      assert.equal(postBody.result.logged, true);
    });

  } finally {
    await db.close();
  }
});
