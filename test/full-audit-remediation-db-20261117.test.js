'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');

const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const { createInternalAiRouter } = require('../src/internal-ai');
const { settleSingleCarrierCodInTx } = require('../src/shipping-management');
const { deleteOrderPermanently } = require('../src/order-deletion');
const { sendRecoveryEmail, optOutAbandonedCart } = require('../src/abandoned-cart');
const { createEmailMarketing } = require('../src/email-marketing');
const { ingestMarketplaceOrder } = require('../src/omnichannel-sync');
const { createCareCustomerApi } = require('../src/care-api');
const inventory = require('../src/inventory');

async function createDbPool(t) {
  const db = await PGlite.create();
  t.after(() => db.close());
  let queue = Promise.resolve();
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await prev;
    return release;
  }
  const execSql = async (sql, values) => {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  };
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await execSql(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return {
        query: (sql, values) => execSql(sql, values),
        release
      };
    }
  };
  await migrateDatabase(pool);
  return pool;
}

test('PGlite integration: internal AI care overview queries warranty_activations & order_after_sales accurately', async (t) => {
  const pool = await createDbPool(t);

  const cust = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, active) VALUES ('AI Care User', 'aicare@example.test', '0911111222', true) RETURNING id`
  )).rows[0];
  const prod = (await pool.query(
    `INSERT INTO products (name, slug, category, active) VALUES ('GAERU Test Mic', 'gaeru-test-mic', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'AI-MIC-01', 'Standard', 500000, 10, true) RETURNING id`,
    [prod.id]
  )).rows[0];
  const ord = (await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd)
     VALUES ('GR-20261117-AI01', $1, 'AI Care User', 'aicare@example.test', '0911111222', '123 St', 'Hà Nội', 'cod', 'completed', 'paid', 500000, 500000) RETURNING id`,
    [cust.id]
  )).rows[0];
  const item = (await pool.query(
    `INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, quantity, unit_price_vnd, line_total_vnd)
     VALUES ($1, $2, 'GAERU Test Mic', 'Standard', 'AI-MIC-01', 1, 500000, 500000) RETURNING id`,
    [ord.id, variant.id]
  )).rows[0];

  await pool.query(
    `INSERT INTO warranty_activations (customer_id, order_item_id, request_key, status)
     VALUES ($1, $2, $3, 'active'), ($1, $2, $4, 'revoked')`,
    [cust.id, item.id, randomUUID(), randomUUID()]
  );
  await pool.query(
    `INSERT INTO order_after_sales (order_id, kind, status, reason)
     VALUES ($1, 'return', 'requested', 'Kiểm tra trả hàng')`,
    [ord.id]
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { id: 'owner-1', username: 'owner', role: 'owner', source: 'bootstrap', isOwner: true, permissions: ['*'] };
    req.session = { admin: req.admin, csrfToken: 'db-remediation-csrf' };
    next();
  });
  app.use('/api/gaeru_ceo/internal-ai', createInternalAiRouter(pool, {}));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  t.after(() => new Promise(r => srv.close(r)));

  const base = `http://127.0.0.1:${srv.address().port}`;
  const tRes = await fetch(`${base}/api/gaeru_ceo/internal-ai/threads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'db-remediation-csrf' }, body: JSON.stringify({ title: 'CSKH Test' })
  });
  const threadId = (await tRes.json()).thread.id;
  const chatRes = await fetch(`${base}/api/gaeru_ceo/internal-ai/threads/${threadId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'db-remediation-csrf' },
    body: JSON.stringify({ question: 'Tình hình CSKH, bảo hành và khiếu nại đổi trả hiện tại thế nào?' })
  });
  assert.equal(chatRes.status, 200);
  const body = await chatRes.json();
  const replyText = body.answer || '';
  const activeCountInDb = (await pool.query("SELECT COUNT(*)::int AS n FROM warranty_activations WHERE status = 'active'")).rows[0].n;
  const totalCountInDb = (await pool.query("SELECT COUNT(*)::int AS n FROM warranty_activations")).rows[0].n;
  assert.ok(totalCountInDb > activeCountInDb, 'Fixture must include non-active revoked row to verify status filter');
  assert.ok(replyText.includes(`**${activeCountInDb}** thiết bị`), `Expected active warranty count ${activeCountInDb} in: ${replyText}`);
  assert.match(replyText, /\*\*1\*\* hồ sơ/);
});

test('PGlite integration: COD settlement succeeds for delivered orders with subsequent return, rejects undelivered returns', async (t) => {
  const pool = await createDbPool(t);

  const deliveredOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd, return_completed_at)
     VALUES ('GR-20261117-COD1', 'COD Returned User', 'codret@example.test', '0922222333', '456 St', 'Hà Nội', 'cod', 'completed', 'paid', 300000, 300000, now()) RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'viettel', 'VTP-DELIVERED-RET-1', 'delivered', 300000, 'unsettled')`,
    [deliveredOrder.id]
  );

  const settleRes = await withTransaction(pool, (client) => settleSingleCarrierCodInTx(client, {
    orderId: deliveredOrder.id,
    expectedCarrierId: 'viettel',
    providerTransactionRef: 'VTP-TX-RET-001',
    settledAmountVnd: 300000,
    evidenceRef: 'STMT-RET-001',
    actor: { username: 'owner', role: 'owner' }
  }));
  assert.equal(settleRes.success, true);

  // RTO parcel returned before delivery must stay blocked (409)
  const undeliveredOrder = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd, return_completed_at)
     VALUES ('GR-20261117-COD2', 'COD RTO User', 'codrto@example.test', '0922222444', '789 St', 'Hà Nội', 'cod', 'shipped', 'pending', 300000, 300000, now()) RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, status, cod_amount_vnd, cod_settlement_status)
     VALUES ($1, 'viettel', 'VTP-RTO-2', 'returned', 300000, 'unsettled')`,
    [undeliveredOrder.id]
  );
  await assert.rejects(
    withTransaction(pool, (client) => settleSingleCarrierCodInTx(client, {
      orderId: undeliveredOrder.id,
      expectedCarrierId: 'viettel',
      providerTransactionRef: 'VTP-TX-RTO-002',
      settledAmountVnd: 300000,
      evidenceRef: 'STMT-RTO-002',
      allowPreDeliveryOverride: true,
      overrideReason: 'Override reason at least 15 chars',
      actor: { username: 'owner', role: 'owner' }
    })),
    { status: 409 }
  );
});

test('PGlite integration: deleteOrderPermanently does not restock non-restockable damaged returns on shipped orders', async (t) => {
  const pool = await createDbPool(t);

  const prod = (await pool.query(
    `INSERT INTO products (name, slug, category, active) VALUES ('GAERU Damaged Test', 'gaeru-dmg-test', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'DMG-01', 'Std', 100000, 5, true) RETURNING id`,
    [prod.id]
  )).rows[0];
  await withTransaction(pool, (c) => inventory.initializeVariantStock(c, { variantId: variant.id, quantity: 5, actor: { username: 'setup' } }));

  const ord = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, payment_status, subtotal_vnd, total_vnd)
     VALUES ('GR-20261117-DMG1', 'Dmg Buyer', 'dmg@example.test', '0933333444', '12 St', 'Hà Nội', 'cod', 'shipped', 'pending', 200000, 200000) RETURNING id`
  )).rows[0];
  await withTransaction(pool, (c) => inventory.reserveStock(c, { variantId: variant.id, quantity: 2, orderId: ord.id, actor: { username: 'setup' } }));
  await pool.query(`UPDATE orders SET return_completed_at = now() WHERE id = $1`, [ord.id]);
  await pool.query(
    `INSERT INTO order_after_sales (order_id, kind, status, restock_eligible, reason) VALUES ($1, 'return', 'resolved', false, 'Hàng vỡ nát')`,
    [ord.id]
  );

  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity, 3);
  await withTransaction(pool, (c) => deleteOrderPermanently(c, ord.id, { inventory, actor: { username: 'owner', role: 'owner', isOwner: true, source: 'bootstrap' } }));
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variant.id])).rows[0].stock_quantity, 3, 'Damaged returned items must never re-enter sellable stock on delete');
});

test('PGlite integration: abandoned-cart safeguards and newsletter opt-out recovery flow', async (t) => {
  const pool = await createDbPool(t);

  // 1. Send recovery refusal on recovered/expired carts & customer_id order match
  const cust = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, active) VALUES ('Cart Owner', 'cart-owner@example.test', '0944444555', true) RETURNING id`
  )).rows[0];
  const fakeMailer = { sendMail: async () => ({ accepted: ['cart@example.test'], messageId: 'm1' }) };
  const fakeCfg = { smtp: { from: 'noreply@gaeru.com', publicBaseUrl: 'https://gaeru.com' } };

  const resRec = await sendRecoveryEmail(pool, fakeCfg, { id: randomUUID(), email: 'cart@example.test', status: 'recovered', recovery_consent: true }, fakeMailer);
  assert.equal(resRec.success, false);
  const resExp = await sendRecoveryEmail(pool, fakeCfg, { id: randomUUID(), email: 'cart@example.test', status: 'expired', recovery_consent: true }, fakeMailer);
  assert.equal(resExp.success, false);

  // Order placed by same customer_id with different checkout email marks cart recovered
  const acRow = (await pool.query(
    `INSERT INTO abandoned_carts (customer_id, email, items, subtotal_vnd, recovery_token, recovery_token_hash, recovery_consent, status, created_at)
     VALUES ($1, 'cart-old@example.test', '[]'::jsonb, 100000, 'tok1234567890123456789012', 'hash1', true, 'abandoned', now() - interval '1 hour')
     RETURNING *`,
    [cust.id]
  )).rows[0];
  await pool.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd)
     VALUES ('GR-20261117-ORDC', $1, 'Cart Owner', 'other-email@example.test', '0944444555', 'St', 'Hà Nội', 'cod', 'pending', 100000, 100000)`,
    [cust.id]
  );
  const resCustOrder = await sendRecoveryEmail(pool, fakeCfg, acRow, fakeMailer);
  assert.equal(resCustOrder.success, false);
  assert.equal((await pool.query('SELECT status FROM abandoned_carts WHERE id = $1', [acRow.id])).rows[0].status, 'recovered');

  // 2. Opt-out from abandoned cart followed by newsletter re-subscribe -> confirm unlocks suppression
  const reEmail = 'reopt@example.test';
  await pool.query(
    `INSERT INTO marketing_email_subscriptions (email, status, consent_source, consent_version) VALUES ($1, 'subscribed', 'footer', 'v1')`,
    [reEmail]
  );
  const rawToken = 'abandoned_optout_token_1234567890';
  const tokHash = require('node:crypto').createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    `INSERT INTO abandoned_carts (email, items, subtotal_vnd, recovery_token, recovery_token_hash, recovery_consent, status)
     VALUES ($1, '[]'::jsonb, 100000, $2, $3, true, 'abandoned')`,
    [reEmail, rawToken, tokHash]
  );
  assert.equal(await optOutAbandonedCart(pool, rawToken), true);
  assert.equal((await pool.query('SELECT status FROM marketing_email_subscriptions WHERE email = $1', [reEmail])).rows[0].status, 'unsubscribed');

  const sentTokens = [];
  const subMailer = {
    sendMail: async (msg) => {
      const m = String(msg.text || '').match(/confirm\/([a-f0-9]{64})/);
      if (m) sentTokens.push(m[1]);
      return { accepted: [reEmail], messageId: 'sub-1' };
    }
  };
  const { publicApi } = createEmailMarketing(pool, { smtp: { from: 'noreply@gaeru.com' }, PUBLIC_BASE_URL: 'https://gaeru.com' }, { mailer: subMailer });
  const app = express();
  app.use(express.json());
  app.use('/api/marketing-email', publicApi);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  t.after(() => new Promise(r => srv.close(r)));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const subRes = await fetch(`${base}/api/marketing-email/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: reEmail, consent: true, source: 'footer' })
  });
  const subJson = await subRes.json();
  assert.equal(subJson.status, 'pending');
  assert.equal(sentTokens.length, 1);

  const confRes = await fetch(`${base}/api/marketing-email/confirm/${sentTokens[0]}`);
  assert.equal(confRes.status, 200);
  assert.equal((await pool.query('SELECT 1 FROM marketing_email_suppressions WHERE email = $1', [reEmail])).rows.length, 0);
  assert.equal((await pool.query('SELECT status FROM marketing_email_subscriptions WHERE email = $1', [reEmail])).rows[0].status, 'subscribed');
});

test('PGlite integration: omnichannel-sync inserts inventory_movements on deduct and reverse', async (t) => {
  const pool = await createDbPool(t);

  const prod = (await pool.query(
    `INSERT INTO products (name, slug, category, active) VALUES ('Omni Mic', 'omni-mic', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'OMNI-01', 'Std', 350000, 10, true) RETURNING id`,
    [prod.id]
  )).rows[0];
  await withTransaction(pool, (c) => inventory.initializeVariantStock(c, { variantId: variant.id, quantity: 10, actor: { username: 'setup' } }));
  await pool.query(
    `INSERT INTO marketplace_sku_mappings (channel, shop_id, variant_id, external_sku) VALUES ('shopee', 'SHOP1', $1, 'EXT-OMNI-01')`,
    [variant.id]
  );

  await withTransaction(pool, (c) => ingestMarketplaceOrder(c, {
    channel: 'shopee',
    shopId: 'SHOP1',
    order: { externalOrderId: 'SPX-ORD-001', status: 'confirmed', totalAmountVnd: 700000, items: [{ externalSku: 'EXT-OMNI-01', quantity: 2, unitPriceVnd: 350000 }] },
    autoDeductStock: true,
    actor: { username: 'omni-worker' }
  }));

  const deductMovs = (await pool.query(`SELECT movement_type, delta, quantity_before, quantity_after FROM inventory_movements WHERE variant_id = $1 AND movement_type = 'sale_reservation'`, [variant.id])).rows;
  assert.equal(deductMovs.length, 1);
  assert.equal(deductMovs[0].delta, -2);
  assert.equal(deductMovs[0].quantity_before, 10);
  assert.equal(deductMovs[0].quantity_after, 8);

  await withTransaction(pool, (c) => ingestMarketplaceOrder(c, {
    channel: 'shopee',
    shopId: 'SHOP1',
    order: { externalOrderId: 'SPX-ORD-001', status: 'cancelled', totalAmountVnd: 700000, items: [{ externalSku: 'EXT-OMNI-01', quantity: 2, unitPriceVnd: 350000 }] },
    autoDeductStock: true,
    actor: { username: 'omni-worker' }
  }));

  const revMovs = (await pool.query(`SELECT movement_type, delta, quantity_before, quantity_after FROM inventory_movements WHERE variant_id = $1 AND movement_type = 'sale_release'`, [variant.id])).rows;
  assert.equal(revMovs.length, 1);
  assert.equal(revMovs[0].delta, 2);
  assert.equal(revMovs[0].quantity_after, 10);
});

test('care-api file upload cleans up stored MEDIA_ROOT file if DB transaction throws', async (t) => {
  const prevRoot = process.env.MEDIA_ROOT;
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gaeru-care-rollback-'));
  process.env.MEDIA_ROOT = tmpRoot;
  t.after(async () => {
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prevRoot;
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  const careId = randomUUID();
  const fakePool = {
    async connect() {
      return {
        async query(sql) {
          const s = String(sql);
          if (s === 'BEGIN' || s === 'ROLLBACK') return { rows: [] };
          if (s.includes('FROM care_requests WHERE id=$1')) {
            return { rows: [{ id: careId, status: 'reviewing', response: 'GAERU ok', subject: 'S' }] };
          }
          if (s.includes('SELECT count(*) total FROM care_messages')) {
            return { rows: [{ total: 0 }] };
          }
          if (s.includes('INSERT INTO care_messages(')) {
            throw new Error('Simulated DB failure after file store');
          }
          return { rows: [] };
        },
        release() {}
      };
    }
  };

  const app = express();
  app.use((req, _res, next) => {
    req.session = { customer: { id: randomUUID() }, csrfToken: 'c-csrf' };
    req.headers['x-csrf-token'] = 'c-csrf';
    next();
  });
  app.use('/api/customer/care', createCareCustomerApi(fakePool, {}));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));

  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  t.after(() => new Promise(r => srv.close(r)));

  const fd = new FormData();
  fd.set('file', new Blob(['plain care note attachment'], { type: 'text/plain' }), 'note.txt');
  const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/customer/care/${careId}/files`, {
    method: 'POST',
    body: fd
  });
  assert.equal(res.status, 500);

  const careDir = path.join(tmpRoot, 'care');
  const filesAfter = fs.existsSync(careDir) ? await fs.promises.readdir(careDir) : [];
  assert.equal(filesAfter.length, 0, 'Rolled-back care upload must not leave orphaned files in MEDIA_ROOT/care');
});
