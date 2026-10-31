'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  normalizeZaloPhone,
  sendZaloZns,
  createZaloZnsAdmin
} = require('../src/zalo-zns');

test('Zalo ZNS: Phone normalization, Dry-run simulation, Live Zalo OpenAPI dispatch, Error handling, and Admin Test Endpoint', async (t) => {
  await t.test('1. normalizeZaloPhone cleans and converts Vietnamese phone numbers to 84 international prefix', () => {
    assert.equal(normalizeZaloPhone('0912345678'), '84912345678');
    assert.equal(normalizeZaloPhone('+84912345678'), '84912345678');
    assert.equal(normalizeZaloPhone('098 765 4321'), '84987654321');
    assert.equal(normalizeZaloPhone('84901234567'), '84901234567');
  });

  await t.test('2. sendZaloZns throws HTTP 400 when phone number has fewer than 11 digits', async () => {
    await assert.rejects(
      async () => sendZaloZns({ phone: '0901', templateId: '123' }),
      /Số điện thoại không hợp lệ/
    );
  });

  await t.test('3. sendZaloZns operates in Dry-run Simulation Mode when token is missing', async () => {
    const res = await sendZaloZns({
      phone: '0988776655',
      templateId: 'tpl_order_confirmed',
      templateData: { order_code: 'GR-TEST' },
      config: {}
    });

    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(res.phone, '84988776655');
    assert.match(res.message, /ZNS mô phỏng/);
  });

  await t.test('4. sendZaloZns dispatches JSON payload with access_token to Zalo OpenAPI', async () => {
    let captured = null;
    const mockFetcher = async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          error: 0,
          message: 'Success',
          data: { msg_id: 'zns_998811' }
        })
      };
    };

    const res = await sendZaloZns({
      phone: '0909123456',
      templateId: 'tpl_order_shipping',
      templateData: { order_code: 'GR-SHIP-01', carrier: 'SPX' },
      config: { ZALO_OA_ACCESS_TOKEN: 'live_token_123' }
    }, mockFetcher);

    assert.equal(res.ok, true);
    assert.equal(res.phone, '84909123456');
    assert.equal(res.result.data.msg_id, 'zns_998811');

    assert.equal(captured.url, 'https://business.openapi.zalo.me/message/template');
    assert.equal(captured.options.headers.access_token, 'live_token_123');
    assert.equal(captured.body.phone, '84909123456');
    assert.equal(captured.body.template_id, 'tpl_order_shipping');
    assert.equal(captured.body.template_data.order_code, 'GR-SHIP-01');
  });

  await t.test('5. Fail-Safe: Catches Zalo business error code and network timeout gracefully', async () => {
    // 5A: Zalo error response
    const mockZaloError = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: -124, message: 'Invalid access token' })
    });
    const errRes = await sendZaloZns({
      phone: '0909123456',
      templateId: 'tpl_test',
      config: { ZALO_OA_ACCESS_TOKEN: 'bad_token' }
    }, mockZaloError);
    assert.equal(errRes.ok, false);
    assert.equal(errRes.result.error, -124);

    // 5B: Network timeout
    const mockTimeout = async () => { throw new Error('ETIMEDOUT'); };
    const netRes = await sendZaloZns({
      phone: '0909123456',
      templateId: 'tpl_test',
      config: { ZALO_OA_ACCESS_TOKEN: 'valid_token' }
    }, mockTimeout);
    assert.equal(netRes.ok, false);
    assert.match(netRes.error, /ETIMEDOUT/);
  });

  await t.test('6. Admin Router POST /zns/test dispatches test message', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_test', username: 'marketing_admin', permissions: ['marketing.write'] };
      next();
    });

    const mockFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: 0, message: 'Success', data: { msg_id: 'test_msg_123' } })
    });

    app.use('/api/gaeru_ceo', createZaloZnsAdmin({ ZALO_OA_ACCESS_TOKEN: 'token_abc' }, mockFetcher));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const res = await fetch(`${base}/api/gaeru_ceo/zns/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '0912345678',
          templateId: 'tpl_admin_test',
          templateData: { test: true }
        })
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.phone, '84912345678');
      assert.equal(data.result.data.msg_id, 'test_msg_123');
    } finally {
      server.close();
    }
  });
});
