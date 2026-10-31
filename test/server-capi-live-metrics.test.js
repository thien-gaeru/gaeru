'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  hashSha256,
  normalizePhoneE164,
  logCapiEvent,
  dispatchServerCapi,
  createCapiAdminRouter
} = require('../src/server-capi');

test('Server CAPI: PII sanitization, Dual-platform Meta & TikTok dispatch, Simulation, Fail-Safe, and Admin endpoints', async (t) => {
  const { db, pool } = await createTestDb({ migrate: false });

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_capi_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id text NOT NULL,
      event_name text NOT NULL,
      platform text NOT NULL CHECK (platform IN ('meta', 'tiktok', 'simulated')),
      status text NOT NULL CHECK (status IN ('sent', 'failed', 'simulated')),
      payload_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      response_body text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS server_capi_event_idx ON server_capi_logs (event_name, created_at DESC);
  `);

  await t.test('1. hashSha256 and normalizePhoneE164 sanitize PII per Meta and TikTok ad privacy standards', () => {
    // Phone normalization
    assert.equal(normalizePhoneE164('0988776655'), '84988776655');
    assert.equal(normalizePhoneE164('+84 988 776 655'), '84988776655');
    assert.equal(normalizePhoneE164('84988776655'), '84988776655');
    assert.equal(normalizePhoneE164(''), null);
    assert.equal(normalizePhoneE164(null), null);

    // SHA-256 Hashing
    const emailHash = hashSha256('  John.Doe@Gaeru.VN ');
    assert.equal(emailHash, hashSha256('john.doe@gaeru.vn'));
    assert.equal(emailHash.length, 64);
    assert.equal(hashSha256(''), null);
  });

  await t.test('2. dispatchServerCapi enters Simulation mode when ad credentials are not configured', async () => {
    const result = await dispatchServerCapi(pool, {}, {
      eventName: 'Purchase',
      orderNumber: 'GR-SIM-001',
      amountVnd: 500000,
      email: 'test@gaeru.vn',
      phone: '0901234567'
    });

    assert.ok(result.eventId.startsWith('ev_'));
    assert.equal(result.meta.status, 'simulated');
    assert.equal(result.tiktok.status, 'simulated');

    // Audit logs persisted in database
    const rows = (await pool.query(`SELECT * FROM server_capi_logs WHERE event_id = $1`, [result.eventId])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'simulated');
    assert.equal(rows[1].status, 'simulated');
  });

  await t.test('3. dispatchServerCapi sends structured payloads to Meta Graph API and TikTok Events API', async () => {
    const liveConfig = {
      META_PIXEL_ID: '1234567890',
      META_CAPI_TOKEN: 'EAAG_MetaTestToken',
      TIKTOK_PIXEL_ID: 'TT_PIXEL_123',
      TIKTOK_EVENTS_TOKEN: 'tt_access_token_123'
    };

    const recordedCalls = [];
    const mockFetcher = async (url, options) => {
      const parsedBody = JSON.parse(options.body);
      recordedCalls.push({ url, options, body: parsedBody });

      if (url.includes('facebook.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ events_received: 1, fbtrace_id: 'TRACE_FB_101' })
        };
      }
      if (url.includes('tiktok.com')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0, message: 'OK' })
        };
      }
      return { ok: true, text: async () => '{}' };
    };

    const res = await dispatchServerCapi(pool, liveConfig, {
      eventName: 'Purchase',
      orderNumber: 'GR-LIVE-002',
      amountVnd: 1500000,
      email: 'customer@gaeru.com',
      phone: '0912345678',
      ip: '14.225.210.12',
      userAgent: 'Mozilla/5.0 Test Agent',
      contents: [{ sku: 'SKU-01', quantity: 2, priceVnd: 750000 }],
      fetcher: mockFetcher
    });

    assert.equal(res.meta.status, 'sent');
    assert.equal(res.tiktok.status, 'sent');
    assert.equal(recordedCalls.length, 2);

    // Verify Meta Request
    const metaCall = recordedCalls.find(c => c.url.includes('facebook.com'));
    assert.ok(metaCall);
    assert.match(metaCall.url, /1234567890\/events\?access_token=EAAG_MetaTestToken/);
    assert.equal(metaCall.body.data[0].event_name, 'Purchase');
    assert.equal(metaCall.body.data[0].custom_data.value, 1500000);
    assert.equal(metaCall.body.data[0].custom_data.order_id, 'GR-LIVE-002');
    assert.equal(metaCall.body.data[0].user_data.em[0].length, 64);

    // Verify TikTok Request
    const ttCall = recordedCalls.find(c => c.url.includes('tiktok.com'));
    assert.ok(ttCall);
    assert.equal(ttCall.options.headers['Access-Token'], 'tt_access_token_123');
    assert.equal(ttCall.body.data[0].event, 'CompletePayment');
    assert.equal(ttCall.body.data[0].properties.value, 1500000);
    assert.equal(ttCall.body.data[0].properties.order_id, 'GR-LIVE-002');

    // Verify DB log
    const logs = (await pool.query(`SELECT platform, status FROM server_capi_logs WHERE event_id = $1`, [res.eventId])).rows;
    assert.equal(logs.length, 2);
    assert.ok(logs.every(l => l.status === 'sent'));
  });

  await t.test('4. Fail-Safe: dispatchServerCapi catches network errors and logs them without throwing', async () => {
    const liveConfig = {
      META_PIXEL_ID: '1234567890',
      META_CAPI_TOKEN: 'EAAG_MetaTestToken',
      TIKTOK_PIXEL_ID: 'TT_PIXEL_123',
      TIKTOK_EVENTS_TOKEN: 'tt_access_token_123'
    };

    const timeoutFetcher = async () => {
      const err = new Error('Connection timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    };

    const res = await dispatchServerCapi(pool, liveConfig, {
      eventName: 'Purchase',
      orderNumber: 'GR-FAIL-003',
      amountVnd: 300000,
      fetcher: timeoutFetcher
    });

    assert.equal(res.meta.status, 'failed');
    assert.equal(res.tiktok.status, 'failed');
    assert.match(res.meta.error, /Connection timed out/);

    const logs = (await pool.query(`SELECT status FROM server_capi_logs WHERE event_id = $1`, [res.eventId])).rows;
    assert.equal(logs.length, 2);
    assert.ok(logs.every(l => l.status === 'failed'));
  });

  await t.test('5. Admin Router exposes GET /capi/logs and POST /capi/test-event', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_1', permissions: ['settings.read', 'settings.write'] };
      next();
    });
    app.use('/', createCapiAdminRouter(pool, {}));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;

    try {
      // Test GET /capi/logs
      const getLogs = await fetch(`http://127.0.0.1:${port}/capi/logs?limit=5`);
      assert.equal(getLogs.status, 200);
      const logsJson = await getLogs.json();
      assert.ok(Array.isArray(logsJson.logs));
      assert.ok(logsJson.logs.length >= 1);

      // Test POST /capi/test-event
      const postTest = await fetch(`http://127.0.0.1:${port}/capi/test-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventName: 'Purchase',
          orderNumber: 'GR-TEST-ADMIN',
          amountVnd: 200000
        })
      });
      assert.equal(postTest.status, 200);
      const postJson = await postTest.json();
      assert.equal(postJson.success, true);
      assert.ok(postJson.results.eventId);
    } finally {
      server.close();
    }
  });
});
