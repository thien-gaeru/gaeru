'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { seal } = require('../src/totp');
const { schemas, publicRecord } = require('../src/admin-configuration');
const { createShippingManagement, handleCarrierWebhook } = require('../src/shipping-management');

test('carrier webhooks fail closed before any shipment/payment write and require a header credential', async t => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) { return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values); },
    async connect() { return { query: pool.query, release() {} }; }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  const config = { SESSION_SECRET: 'isolated-carrier-webhook-encryption-secret' };
  const order = (await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd)
    VALUES('WEBHOOK-SECURITY','Fixture','fixture@example.invalid','0900000000','Fixture','Hà Nội','cod','pending','processing',100000,100000) RETURNING id`)).rows[0];
  await pool.query("INSERT INTO carrier_shipments(order_id,carrier_id,tracking_number,carrier_order_id,status,cod_amount_vnd) VALUES($1,'viettel','FIXTURE-TRACKING','WEBHOOK-SECURITY','created',100000)", [order.id]);
  let settlements = 0;
  const finance = { async recordFullOrderPayment() { settlements++; } };
  const app = express();
  app.use(express.json());
  app.use(createShippingManagement(pool, config, { finance }).publicApi);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Webhook rejected' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/shipping/viettel/webhook';
  const payload = { ORDER_NUMBER: 'FIXTURE-TRACKING', ORDER_STATUS: 'delivered' };
  const post = (headers = {}, body = payload) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const unchanged = async () => {
    assert.deepEqual((await pool.query('SELECT status,payment_status FROM orders WHERE id=$1', [order.id])).rows[0], { status: 'processing', payment_status: 'pending' });
    assert.equal((await pool.query('SELECT status FROM carrier_shipments WHERE order_id=$1', [order.id])).rows[0].status, 'created');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action='shipping.webhook.receive'")).rows[0].n, 0);
    assert.equal(settlements, 0);
  };
  assert.equal((await post()).status, 503, 'an unconfigured public webhook must be disabled');
  await unchanged();
  const webhookSecret = 'fixture-dedicated-webhook-secret-32-chars';
  const encrypted = JSON.stringify({ version: 1, cipher: seal(JSON.stringify({ secret: 'api-token', webhookSecret }), config.SESSION_SECRET) });
  await pool.query("INSERT INTO store_settings(setting_key,setting_value) VALUES('private_admin:shipping_viettel',$1)", [encrypted]);
  for (const [headers, body] of [[{}, payload], [{ 'x-webhook-secret': 'wrong' }, payload], [{}, { ...payload, webhookSecret }]]) {
    assert.equal((await post(headers, body)).status, 401);
    await unchanged();
  }
  await pool.query("UPDATE store_settings SET setting_value=$1 WHERE setting_key='private_admin:shipping_viettel'", [JSON.stringify({ version: 1, cipher: 'corrupt-cipher' })]);
  assert.equal((await post({ 'x-webhook-secret': webhookSecret })).status, 500, 'decryption errors cannot bypass authorization');
  await unchanged();
  await assert.rejects(() => handleCarrierWebhook({ async query() { throw Error('fixture database outage'); } }, config, 'viettel', payload), /fixture database outage/);
  await unchanged();
  await pool.query("UPDATE store_settings SET setting_value=$1 WHERE setting_key='private_admin:shipping_viettel'", [encrypted]);
  assert.equal((await post({ Authorization: 'Bearer ' + webhookSecret })).status, 200);
  assert.deepEqual((await pool.query('SELECT status,payment_status FROM orders WHERE id=$1', [order.id])).rows[0], { status: 'completed', payment_status: 'paid' });
  assert.equal(settlements, 1);
  assert.equal((await post({ 'x-webhook-secret': webhookSecret })).status, 200);
  assert.equal(settlements, 1, 'a repeated authenticated delivery cannot settle twice');
});

test('carrier webhook secret is validated, encrypted-record public views redact it, and blank updates preserve it', () => {
  const base = { accountId: '123', partnerCode: '', pickupName: 'Fixture', pickupPhone: '0900000000', pickupAddress: 'Fixture', secret: 'api-token' };
  const webhookSecret = 'fixture-dedicated-webhook-secret-32-chars';
  assert.equal(schemas.shipping_ghn.safeParse({ ...base, webhookSecret: 'short' }).success, false);
  const parsed = schemas.shipping_ghn.parse({ ...base, webhookSecret });
  const publicValue = publicRecord('shipping_ghn', { version: 1, data: parsed });
  assert.equal(publicValue.data.webhookSecretConfigured, true);
  assert.equal(JSON.stringify(publicValue).includes(webhookSecret), false);
  assert.equal(JSON.stringify(publicValue).includes(base.secret), false);
  assert.equal(Object.hasOwn(schemas.shipping_ghn.parse(base), 'webhookSecret'), false);
});
