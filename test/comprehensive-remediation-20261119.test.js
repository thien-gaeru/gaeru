'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');

async function createDb(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const prev = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await prev;
    return release;
  }
  async function query(sql, values) {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) { const r = await lock(); try { return await query(sql, values); } finally { r(); } },
    async connect() { const r = await lock(); return { query, release: r }; },
    async end() { await db.close(); }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

test('store-api RBAC rejects unprivileged roles and VNPAY IPN guards returned orders', async (t) => {
  const { createStoreApi } = require('../src/store-api');
  const pool = await createDb(t);

  const csrfToken = 'csrf-remediation-test-token-1234567890';
  let currentAdmin = { username: 'viewer1', role: 'viewer', source: 'staff', permissions: ['dashboard.read', 'catalog.read', 'orders.read', 'customers.read'] };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: currentAdmin, csrfToken };
    req.admin = currentAdmin;
    next();
  });
  app.use('/api', createStoreApi(pool, {
    ordersEnabled: true,
    vnpayConfig: {
      tmnCode: 'GAERU001',
      hashSecret: 'test-vnpay-hash-secret-32-chars!!',
      paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
      returnUrl: 'https://store.example/api/payments/vnpay/return'
    }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Viewer gets 200 on allowed reads
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/products`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/customers`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/orders`)).status, 200);

  // Viewer gets 403 on write/settings routes
  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken };
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/products`, { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/settings`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/settings`, { method: 'PUT', headers, body: '{}' })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/customers/${randomUUID()}`, { method: 'PATCH', headers, body: '{}' })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/uploads`, { method: 'POST', headers: { 'x-csrf-token': csrfToken } })).status, 403);

  // Restricted admin without orders.read or dashboard.read
  currentAdmin = { username: 'nodash', role: 'custom', source: 'staff', permissions: ['inventory.read'] };
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/orders`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/summary`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/traffic-summary`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/gaeru_ceo/customers`)).status, 403);

  // VNPAY IPN must refuse orders already returned (return_completed_at IS NOT NULL)
  const ordRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_status, return_completed_at)
     VALUES ('GR-20261119-RET1', 'Return Buyer', 'ret@example.test', '0901234567', '12 Pho Hue', 'Ha Noi', 'vnpay', 200000, 0, 200000, 'completed', 'pending', now())
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO payment_attempts (order_id, provider, transaction_ref, amount_vnd, status, expires_at)
     VALUES ($1, 'vnpay', 'GR-20261119-RET1', 200000, 'pending', now() + interval '15 minutes')`,
    [ordRes.rows[0].id]
  );

  const crypto = require('node:crypto');
  const params = {
    vnp_Amount: '20000000',
    vnp_BankCode: 'NCB',
    vnp_Command: 'pay',
    vnp_CreateDate: '20261119050000',
    vnp_CurrCode: 'VND',
    vnp_OrderInfo: 'Thanh toan GR-20261119-RET1',
    vnp_PayDate: '20261119050100',
    vnp_ResponseCode: '00',
    vnp_TmnCode: 'GAERU001',
    vnp_TransactionNo: '998877',
    vnp_TransactionStatus: '00',
    vnp_TxnRef: 'GR-20261119-RET1'
  };
  const signData = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(params[k]).replace(/%20/g, '+')}`).join('&');
  params.vnp_SecureHash = crypto.createHmac('sha512', reqSecret()).update(Buffer.from(signData, 'utf8')).digest('hex');
  function reqSecret() { return 'test-vnpay-hash-secret-32-chars!!'; }

  const ipnRes = await fetch(`${baseUrl}/api/payments/vnpay/ipn?${new URLSearchParams(params)}`);
  assert.equal(ipnRes.status, 200);
  const ipnBody = await ipnRes.json();
  assert.equal(ipnBody.RspCode, '02');
  const afterOrd = (await pool.query('SELECT payment_status FROM orders WHERE id = $1', [ordRes.rows[0].id])).rows[0];
  assert.equal(afterOrd.payment_status, 'pending');
});

test('realtime-sse validates staff auth_version and account_security.version plus backpressure', async (t) => {
  const { checkAdminSessionDbValid, openSseStream } = require('../src/realtime-sse');
  const pool = await createDb(t);

  const staff = (await pool.query(
    `INSERT INTO staff_accounts (username, full_name, role, active, password_hash, auth_version)
     VALUES ('sse_staff', 'SSE Staff', 'manager', true, 'hash', 2) RETURNING id`
  )).rows[0];
  await pool.query(`INSERT INTO account_security (account_key, version) VALUES ($1, 3)`, [`staff:${staff.id}`]);

  assert.equal(await checkAdminSessionDbValid(pool, {
    session: { adminAuthenticatedAt: Date.now(), adminLastSeenAt: Date.now(), admin: { source: 'staff', id: staff.id, authVersion: 2, securityVersion: 3 } },
    admin: { source: 'staff', id: staff.id, authVersion: 2, securityVersion: 3 }
  }), true);
  assert.equal(await checkAdminSessionDbValid(pool, {
    session: { adminAuthenticatedAt: Date.now(), adminLastSeenAt: Date.now(), admin: { source: 'staff', id: staff.id, authVersion: 1, securityVersion: 3 } },
    admin: { source: 'staff', id: staff.id, authVersion: 1, securityVersion: 3 }
  }), false);
  assert.equal(await checkAdminSessionDbValid(pool, {
    session: { adminAuthenticatedAt: Date.now(), adminLastSeenAt: Date.now(), admin: { source: 'staff', id: staff.id, authVersion: 2, securityVersion: 2 } },
    admin: { source: 'staff', id: staff.id, authVersion: 2, securityVersion: 2 }
  }), false);

  // Backpressure closes saturated stream cleanly instead of crashing
  const EventEmitter = require('node:events');
  const mockReq = new EventEmitter();
  let ended = false;
  let wrote = false;
  const mockRes = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writableLength: 600 * 1024,
    setHeader() {},
    writeHead() {},
    flushHeaders() {},
    write() { wrote = true; return true; },
    end() { ended = true; this.writableEnded = true; }
  });
  openSseStream(mockReq, mockRes, 'bp-test');
  wrote = false;
  const { defaultHub } = require('../src/realtime-sse');
  defaultHub.publish('bp-test', 'ping:test', { ok: true });
  assert.equal(ended, true);
  assert.equal(wrote, false);
});

test('payment_bank_transfer config schema and non-owner reconcile guard on cancelled/returned orders', async () => {
  const { schemas } = require('../src/admin-configuration');
  const { formatBankTransferInstructions, reconcilePrepaidOrder } = require('../src/payment-channels');

  assert.equal(schemas.payment_bank_transfer.safeParse({
    bankName: 'MBBank',
    accountNumber: '0987654321',
    accountHolder: 'GAERU STORE',
    branch: '',
    transferSyntax: 'GAERU {MA_DON}',
    webhookSecret: 'a'.repeat(24),
    webhookRequireHmac: true,
    enabled: true
  }).success, true);

  assert.equal(formatBankTransferInstructions({ webhookSecret: 'short-secret' }).autoReconcile, false);
  assert.equal(formatBankTransferInstructions({ webhookSecret: 'long-enough-secret-16+' }).autoReconcile, true);

  const mockClient = {
    async query(sql) {
      if (sql.includes('FROM payment_attempts p')) {
        return {
          rows: [{
            id: 'att-1', amountVnd: 100000, attemptStatus: 'pending',
            orderId: 'ord-1', orderNumber: 'GR-20261119-0001', orderStatus: 'cancelled',
            paymentMethod: 'vnpay', totalVnd: 100000, paymentStatus: 'pending', returnCompletedAt: null
          }]
        };
      }
      return { rows: [] };
    }
  };
  const mgrResult = await reconcilePrepaidOrder(mockClient, {
    provider: 'vnpay',
    orderNumber: 'GR-20261119-0001',
    amountVnd: 100000,
    actor: { username: 'mgr', role: 'manager' }
  });
  assert.equal(mgrResult.matched, false);
  assert.equal(mgrResult.code, '09');
});

test('oauth-link-helper prevents stealing existing OAuth identity and rejects expired pending links', async (t) => {
  const { applyPendingOAuthLink } = require('../src/audit-fixes/oauth-link-helper');
  const pool = await createDb(t);

  const victim = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash, google_id, active)
     VALUES ('Victim', 'victim@example.test', '0900000011', 'hash', 'sub-victim-1', true) RETURNING id, email`
  )).rows[0];
  await pool.query(
    `INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
     VALUES ($1, 'google', 'https://accounts.google.com', 'sub-victim-1', 'victim@example.test')`,
    [victim.id]
  );

  const attacker = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash, active)
     VALUES ('Attacker', 'attacker@example.test', '0900000022', 'hash', true) RETURNING id, email`
  )).rows[0];

  const stolen = await applyPendingOAuthLink(pool, attacker, {
    provider: 'google',
    email: 'attacker@example.test',
    googleSub: 'sub-victim-1',
    createdAt: Date.now()
  });
  assert.equal(stolen, false);
  const ownerRow = (await pool.query(
    `SELECT customer_id FROM auth_identities WHERE provider_subject = 'sub-victim-1'`
  )).rows[0];
  assert.equal(ownerRow.customer_id, victim.id);

  // Expired pending link (> 15 minutes old)
  const expired = await applyPendingOAuthLink(pool, attacker, {
    provider: 'google',
    email: 'attacker@example.test',
    googleSub: 'sub-fresh-new',
    createdAt: Date.now() - 16 * 60 * 1000
  });
  assert.equal(expired, false);
});

test('POST /bundles/quote applies active product promotions before bundle discount', async (t) => {
  const { mountBundles } = require('../src/product-bundles');
  const pool = await createDb(t);

  const p = (await pool.query(`INSERT INTO products (name, slug, category, active) VALUES ('GAERU K9', 'k9-promo-combo', 'audio', true) RETURNING id`)).rows[0];
  const v1 = (await pool.query(`INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'K9-P', 'K9 Main', 200000, 10, true) RETURNING id`, [p.id])).rows[0];
  const v2 = (await pool.query(`INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'CBL-S', 'Adapter', 100000, 10, true) RETURNING id`, [p.id])).rows[0];

  const promo = (await pool.query(
    `INSERT INTO product_promotions (title, type, kind, amount, starts_at, ends_at, active)
     VALUES ('Flash 50%', 'flash', 'percent', 50, now() - interval '1 hour', now() + interval '1 day', true) RETURNING id`
  )).rows[0];
  await pool.query(`INSERT INTO product_promotion_variants (promotion_id, variant_id) VALUES ($1, $2)`, [promo.id, v1.id]);

  const bundle = (await pool.query(
    `INSERT INTO product_bundles (title, discount_type, discount_value, starts_at, ends_at, active)
     VALUES ('Combo', 'fixed', 20000, now() - interval '1 hour', now() + interval '1 day', true) RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO product_bundle_items (bundle_id, variant_id, is_primary, min_quantity) VALUES ($1, $2, true, 1), ($1, $3, false, 1)`,
    [bundle.id, v1.id, v2.id]
  );

  const app = express();
  app.use(express.json());
  const adminRouter = express.Router();
  const publicRouter = express.Router();
  mountBundles({ admin: adminRouter, publicRouter }, pool);
  app.use('/api', publicRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/bundles/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ variantId: v1.id, quantity: 1 }, { variantId: v2.id, quantity: 1 }] })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  // v1 discounted 50% (200k -> 100k) + v2 (100k) = 200k subtotal, minus 20k bundle = 180k
  assert.equal(body.bundleDiscountVnd, 20000);
  assert.equal(body.finalSubtotalVnd, 180000);
});

test('marketplace normalizeStatus avoids substring collisions and cache.js SWR inflight returns data', async () => {
  const { normalizeStatus } = require('../src/marketplace-connectors');
  assert.equal(normalizeStatus('shopee', 'UNPROCESSED'), 'pending');
  assert.equal(normalizeStatus('shopee', 'DISCLOSED'), 'pending');
  assert.equal(normalizeStatus('shopee', 'READY_TO_SHIP'), 'processing');
  assert.equal(normalizeStatus('tiktok', 'AWAITING_COLLECTION'), 'processing');
  assert.equal(normalizeStatus('lazada', 'shipped'), 'shipped');
  assert.equal(normalizeStatus('shopee', 'COMPLETED'), 'completed');
  assert.equal(normalizeStatus('shopee', 'CANCELLED'), 'cancelled');
  assert.equal(normalizeStatus('shopee', 'RETURNED'), 'returned');

  const cache = require('../cache');
  const { inferDevicePortsFromText, PORT_TYPES } = require('../src/lib/phone-compatibility');
  const { shouldCompress } = require('../src/lib/public-compression');
  const { detectWarrantySpam } = require('../src/warranty-spam');

  // Phone compatibility retains explicit lightning when Android brand is also mentioned
  const ports = inferDevicePortsFromText('So sánh Samsung S24 và iPhone 13 chân Lightning');
  assert.equal(ports.has(PORT_TYPES.TYPE_C), true);
  assert.equal(ports.has(PORT_TYPES.LIGHTNING), true);

  // Public compression allows /api/search-index.json and /api/settings/public
  const mockRes = () => ({ headers: {}, getHeader(k) { return this.headers[k]; }, setHeader(k, v) { this.headers[k] = v; } });
  const rSearch = mockRes();
  shouldCompress({ originalUrl: '/api/search-index.json', headers: {} }, rSearch);
  assert.equal(rSearch.headers['Cache-Control'], undefined);
  const rSettings = mockRes();
  shouldCompress({ originalUrl: '/api/settings/public', headers: {} }, rSettings);
  assert.equal(rSettings.headers['Cache-Control'], undefined);
  const rPrivate = mockRes();
  assert.equal(shouldCompress({ originalUrl: '/api/customer/orders', headers: {} }, rPrivate), false);

  // Warranty spam catches obfuscated zeros without false positives on valid IDs
  assert.equal(detectWarrantySpam({ contactPhone: '0912345678', contactName: 'Nguyen Van An', serial: '000000' }).isSpam, true);
  assert.equal(detectWarrantySpam({ contactPhone: '0912345678', contactName: 'Nguyen Van An', serial: 'TEST-1234' }).isSpam, true);
  assert.equal(detectWarrantySpam({ contactPhone: '0912345678', contactName: 'Nguyen Van An', serial: 'SN-K9-VALID-888', externalOrderNumber: '123987654321' }).isSpam, false);

  // cache.js SWR background refresh returns data even if entry evicted mid-flight
  cache.flushAllCache();
  let calls = 0;
  let releaseSecond;
  const secondGate = new Promise(r => { releaseSecond = r; });
  const fetcher = async () => {
    calls++;
    if (calls === 1) return { v: 1 };
    await secondGate;
    return { v: 2 };
  };
  assert.deepEqual(await cache.getFreshData('test:swr:evict', fetcher, 10), { v: 1 });
  await new Promise(r => setTimeout(r, 25));
  // Trigger SWR background refresh -> returns stale { v: 1 } immediately while bg is inflight
  const stale = await cache.getFreshData('test:swr:evict', fetcher, 10);
  assert.deepEqual(stale, { v: 1 });
  // Flush cache before bg finishes; concurrent caller awaits inflight and must NOT get undefined
  cache.flushAllCache();
  const concurrentPromise = cache.getFreshData('test:swr:evict', fetcher, 10);
  releaseSecond();
  const concurrentResult = await concurrentPromise;
  assert.deepEqual(concurrentResult, { v: 2 });
});

test('gpu-ai-client records failure on malformed 200 payload and gates half-open probe', async () => {
  const client = require('../src/lib/gpu-ai-client');
  client.resetGpuAiState();
  process.env.GAERU_GPU_AI_ENABLED = '1';
  const origFetch = global.fetch;
  try {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [] }] })
      };
    };
    const r1 = await client.embedTexts(['micro khong day']);
    assert.equal(r1, null);
    assert.equal(client.isCircuitOpen(), false);
    const r2 = await client.embedTexts(['chan cam iphone']);
    assert.equal(r2, null);
    assert.equal(client.isCircuitOpen(), true);
    const r3 = await client.embedTexts(['blocked while open']);
    assert.equal(r3, null);
    assert.equal(calls, 2);
  } finally {
    global.fetch = origFetch;
    client.resetGpuAiState();
    delete process.env.GAERU_GPU_AI_ENABLED;
  }
});

test('removeWhiteBackground handles zero shadowBlur cleanly without crashing Sharp', async () => {
  const { removeWhiteBackground } = require('../src/lib/product-background');
  const buf = await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  })
    .composite([{
      input: await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer(),
      top: 40,
      left: 40
    }])
    .png()
    .toBuffer();

  const out = await removeWhiteBackground(buf, { autoCenterSquare: true, shadowBlur: 0, mainSize: 200, thumbSize: 100 });
  assert.ok(Buffer.isBuffer(out));
  assert.ok(out.length > 0);
});

test('omnichannel-sync blocks inactive-only warehouse deduction and handles multi-line duplicate SKUs symmetrically', async (t) => {
  const { ingestMarketplaceOrder } = require('../src/omnichannel-sync');
  const pool = await createDb(t);

  const p = (await pool.query(`INSERT INTO products (name, slug, category, active) VALUES ('GAERU K9', 'k9-omni-multi', 'audio', true) RETURNING id`)).rows[0];
  const v = (await pool.query(`INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'K9-MULTI-LINE', 'Standard', 200000, 10, true) RETURNING id`, [p.id])).rows[0];
  const wh = (await pool.query(`INSERT INTO warehouses (code, name, active) VALUES ('INACT1', 'Inactive WH', false) RETURNING id`)).rows[0];
  await pool.query(`INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10)`, [wh.id, v.id]);

  // Should reject 409 when stock only sits in an inactive warehouse
  await assert.rejects(
    () => pool.connect().then(async client => {
      try {
        return await ingestMarketplaceOrder(client, {
          channel: 'shopee',
          shopId: 'S1',
          order: { externalOrderId: 'SHP-INACT-1', rawStatus: 'PROCESSING', items: [{ externalSku: 'K9-MULTI-LINE', quantity: 2 }] },
          autoDeductStock: true
        });
      } finally { client.release(); }
    }),
    err => err.status === 409
  );

  // Activate warehouse and ingest multi-line order sharing same variantId, then cancel symmetrically
  await pool.query(`UPDATE warehouses SET active = true WHERE id = $1`, [wh.id]);
  const client = await pool.connect();
  t.after(() => client.release());
  const deducted = await ingestMarketplaceOrder(client, {
    channel: 'shopee',
    shopId: 'S1',
    order: {
      externalOrderId: 'SHP-MULTI-2',
      rawStatus: 'PROCESSING',
      items: [
        { externalSku: 'K9-MULTI-LINE', quantity: 2 },
        { externalSku: 'K9-MULTI-LINE', quantity: 3 }
      ]
    },
    autoDeductStock: true
  });
  assert.equal(deducted.stock_deducted, true);
  assert.equal((await client.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [wh.id, v.id])).rows[0].quantity, 5);

  const reversed = await ingestMarketplaceOrder(client, {
    channel: 'shopee',
    shopId: 'S1',
    order: { externalOrderId: 'SHP-MULTI-2', rawStatus: 'CANCELLED', items: [{ externalSku: 'K9-MULTI-LINE', quantity: 2 }, { externalSku: 'K9-MULTI-LINE', quantity: 3 }] },
    autoDeductStock: true
  });
  assert.equal(reversed.stock_reversed, true);
  assert.equal((await client.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [wh.id, v.id])).rows[0].quantity, 10);
  const mvCount = (await client.query(`SELECT movement_type, COUNT(*)::int AS cnt FROM inventory_movements WHERE reference_id = 'SHP-MULTI-2' GROUP BY movement_type`)).rows;
  assert.equal(mvCount.find(r => r.movement_type === 'sale_reservation')?.cnt, 2);
  assert.equal(mvCount.find(r => r.movement_type === 'sale_release')?.cnt, 2);
});

test('sitemap serves cached HTML template and XML cleanly', async (t) => {
  const { createSitemap } = require('../src/sitemap');
  const pool = await createDb(t);
  const app = express();
  app.use('/', createSitemap(pool, 'https://gaeru.com'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const html1 = await fetch(`${baseUrl}/sitemap.html`);
  assert.equal(html1.status, 200);
  const html2 = await fetch(`${baseUrl}/sitemap.html`);
  assert.equal(html2.status, 200);
  assert.ok((await html2.text()).includes('GAERU'));
  const xml = await fetch(`${baseUrl}/sitemap.xml`);
  assert.equal(xml.status, 200);
  assert.match(await xml.text(), /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
});
