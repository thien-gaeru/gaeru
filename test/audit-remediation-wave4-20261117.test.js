'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cluster = require('node:cluster');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { execSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const { migrateDatabase } = require('../src/migrate');
const { createApp } = require('../src/app');
const { seal } = require('../src/totp');
const { IpcFanoutHub } = require('../src/lib/cluster-fanout');
const { EdgePurgeService } = require('../src/lib/edge-purge');
const {
  viettelAdapter,
  jtAdapter,
  spxAdapter,
  applyViettelProvinceCatalogSnapshot,
  resolveViettelProvinceId
} = require('../src/shipping-adapters');
const { createWaybill, cancelWaybill } = require('../src/shipping-management');
const { checkReturnEligibility, afterSalesRouter } = require('../src/order-after-sales');
const { createInternalAiRouter } = require('../src/internal-ai');
const { createRmaApi } = require('../src/rma-tickets');
const { globalForecastCache, invalidateForecastCache } = require('../src/inventory-forecast');
const { clearWebKnowledgeCache, loadLiveSiteFacts } = require('../src/chat-web-knowledge');

const ROOT_DIR = path.resolve(__dirname, '..');

async function createIsolatedPool(t) {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const before = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await before;
    return release;
  }
  async function query(sql, values) {
    const res = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...res, rows: res?.rows || [], rowCount: res?.affectedRows ?? res?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

test('Wave 4.1: HTML cache-busting ?v= versions are consistent and CI/backup scripts use LF endings', () => {
  const htmlFiles = execSync('git ls-files *.html admin/*.html', { cwd: ROOT_DIR, encoding: 'utf8' })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  const versionsByAsset = new Map();
  for (const rel of htmlFiles) {
    const html = fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
    const re = /(?:src|href)="([^"?#]+)\?v=([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (!versionsByAsset.has(m[1])) versionsByAsset.set(m[1], new Set());
      versionsByAsset.get(m[1]).add(m[2]);
    }
  }

  for (const [asset, versions] of versionsByAsset.entries()) {
    assert.equal(versions.size, 1, `Asset ${asset} has conflicting ?v= versions: ${[...versions].join(', ')}`);
  }

  for (const modified of [
    '/action-feedback.js',
    'care.js',
    'warranty.js',
    '/account-deletion.js',
    '/customer-marketing.js',
    'account.js',
    'customer-experience.js',
    'support.js',
    '/gaeru_ceo/assets/care.js',
    '/gaeru_ceo/assets/warranty.js'
  ]) {
    assert.deepEqual([...(versionsByAsset.get(modified) || [])], ['20261117-remediation'], `${modified} must use 20261117-remediation`);
  }

  const lfFiles = [
    ...execSync('git ls-files .github/workflows/*.yml', { cwd: ROOT_DIR, encoding: 'utf8' }).trim().split(/\r?\n/),
    ...execSync('git ls-files scripts/mi6-backup/*.sh', { cwd: ROOT_DIR, encoding: 'utf8' }).trim().split(/\r?\n/)
  ].filter(Boolean);

  for (const rel of lfFiles) {
    const buf = fs.readFileSync(path.join(ROOT_DIR, rel));
    assert.equal(buf.includes(Buffer.from('\r\n')), false, `${rel} must use LF line endings`);
  }

  const gdriveSync = fs.readFileSync(path.join(ROOT_DIR, 'scripts/mi6-backup/gaeru-gdrive-sync.sh'), 'utf8');
  assert.match(gdriveSync, /gaeru-gdrive-daily-pg\.date/);
});

test('Wave 4.2: Wildcard edge purge expands enterprise tags cleanly and multi-worker IPC fans out cache invalidations', async () => {
  const capturedBodies = [];
  const purge = new EdgePurgeService({
    zoneId: 'zone-1',
    apiToken: 'token-1',
    fetcher: async (_url, opts) => {
      capturedBodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ success: true }) };
    }
  });

  const prevTagMode = process.env.CLOUDFLARE_TAG_PURGE;
  try {
    process.env.CLOUDFLARE_TAG_PURGE = 'true';
    await purge.purgeTags(['*']);
    assert.equal(capturedBodies.length, 1);
    assert.equal(capturedBodies[0].tags.includes('*'), false, 'Cloudflare Enterprise tag purge must not emit raw "*" tag');
    for (const tag of ['gaeru-catalog', 'gaeru-html', 'settings', 'home-banner', 'news']) {
      assert.ok(capturedBodies[0].tags.includes(tag), `Expanded wildcard purge must include ${tag}`);
    }

    delete process.env.CLOUDFLARE_TAG_PURGE;
    await purge.purgeTags(['*']);
    assert.equal(capturedBodies.length, 2);
    assert.ok(Array.isArray(capturedBodies[1].files));
    assert.ok(capturedBodies[1].files.some((u) => u.endsWith('/api/settings/public')));
    assert.ok(capturedBodies[1].files.some((u) => u.endsWith('/api/home-banner')));
  } finally {
    if (prevTagMode === undefined) delete process.env.CLOUDFLARE_TAG_PURGE;
    else process.env.CLOUDFLARE_TAG_PURGE = prevTagMode;
  }

  const hub = new IpcFanoutHub();
  const prevWorkers = cluster.workers;
  const w1Sent = [];
  const w2Sent = [];
  cluster.workers = {
    '1': { id: 1, isConnected: () => true, send: (m) => w1Sent.push(m) },
    '2': { id: 2, isConnected: () => true, send: (m) => w2Sent.push(m) }
  };
  try {
    hub.handleWorkerMessage(cluster.workers['1'], { type: 'FORECAST_CACHE_INVALIDATE', prefix: 'wh-1' });
    hub.handleWorkerMessage(cluster.workers['1'], { type: 'SHIPPING_CACHE_INVALIDATE' });
    hub.handleWorkerMessage(cluster.workers['1'], {
      type: 'VIETTEL_PROVINCE_CATALOG_SYNC',
      entries: [['test dac biet', 999]],
      syncedAt: '2026-11-17T10:00:00.000Z'
    });
    assert.equal(w1Sent.length, 0);
    assert.equal(w2Sent.length, 3);
    assert.equal(w2Sent[0].type, 'FORECAST_CACHE_INVALIDATE');
    assert.equal(w2Sent[1].type, 'SHIPPING_CACHE_INVALIDATE');
    assert.equal(w2Sent[2].type, 'VIETTEL_PROVINCE_CATALOG_SYNC');
  } finally {
    cluster.workers = prevWorkers;
  }

  applyViettelProvinceCatalogSnapshot([['test dac biet', 999], ['ha noi', 1]], '2026-11-17T10:00:00.000Z');
  assert.equal(resolveViettelProvinceId('Tỉnh Test Đặc Biệt', { strict: true }), 999);

  globalForecastCache.set('forecast:wh-1:30', { cached: true });
  invalidateForecastCache('wh-1', { broadcast: false });
  assert.equal(globalForecastCache.get('forecast:wh-1:30'), null);

  let dbHits = 0;
  const fakePool = {
    async query(sql) {
      if (sql.includes('store_settings')) dbHits++;
      return { rows: [] };
    }
  };
  await loadLiveSiteFacts(fakePool);
  await loadLiveSiteFacts(fakePool);
  assert.equal(dbHits, 1);
  clearWebKnowledgeCache();
  await loadLiveSiteFacts(fakePool);
  assert.equal(dbHits, 2);
});

test('Wave 4.3: Replacement waybills suffix carrierOrderNumber after cancel and Viettel NLP fallback avoids duplicate rejected service', async (t) => {
  const pool = await createIsolatedPool(t);
  const config = { SESSION_SECRET: 'wave4-shipping-test-secret-32-chars!!' };
  const encKey = process.env.AUTH_ENCRYPTION_KEY || config.SESSION_SECRET;

  await pool.query(
    "INSERT INTO store_settings(setting_key,setting_value) VALUES('private_admin:shipping_viettel',$1)",
    [JSON.stringify({ version: 1, cipher: seal(JSON.stringify({ secret: 'eyJhbGciOiJFUzI1NiJ9.fixture', defaultService: 'LCOD' }), encKey) })]
  );
  await pool.query("INSERT INTO shipping_carrier_connections(carrier_id,config_version,verified_at,enabled) VALUES('viettel',1,now(),true)");

  const order = (await pool.query(
    `INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd)
     VALUES('GR-WAVE4-RETRY','Nguyen Test','retry@example.invalid','0912345678','10 Pho Hue','Hà Nội','cod','pending','confirmed',200000,200000) RETURNING id`
  )).rows[0];

  const createdRefs = [];
  let seq = 0;
  const mockFetcher = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/createOrder')) {
      createdRefs.push(body.ORDER_NUMBER);
      seq++;
      return { ok: true, json: async () => ({ status: 200, error: false, data: { ORDER_NUMBER: `VT-TRACK-${seq}`, MONEY_TOTAL: 25000 } }) };
    }
    if (url.endsWith('/UpdateOrder')) {
      return { ok: true, json: async () => ({ status: 200, error: false }) };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const first = await createWaybill(pool, config, { orderId: order.id, carrierId: 'viettel', actor: { username: 'owner' }, fetcher: mockFetcher });
  assert.equal(createdRefs[0], 'GR-WAVE4-RETRY');
  assert.equal(first.shipment.carrierOrderId, 'GR-WAVE4-RETRY');

  await cancelWaybill(pool, config, { orderId: order.id, actor: { username: 'owner' }, fetcher: mockFetcher });

  const second = await createWaybill(pool, config, { orderId: order.id, carrierId: 'viettel', actor: { username: 'owner' }, fetcher: mockFetcher });
  assert.equal(createdRefs[1], 'GR-WAVE4-RETRY-R2');
  assert.equal(second.shipment.carrierOrderId, 'GR-WAVE4-RETRY-R2');

  // Verify Viettel NLP fallback never retries the same rejected serviceCode even if it sits at services[0]
  const triedServices = [];
  const res = await viettelAdapter.createWaybill(
    { secret: 'eyJhbGciOiJFUzI1NiJ9.fixture', defaultService: 'LCOD', pickupAddress: 'Hà Nội' },
    {
      orderNumber: 'GR-NLP-1',
      carrierOrderNumber: 'GR-NLP-1-R2',
      customerName: 'Test',
      address: '123 Duong A',
      city: 'Hà Nội',
      phone: '0900000000',
      items: [{ productName: 'GAERU K9' }],
      subtotalVnd: 300000,
      codAmountVnd: 300000
    },
    {
      fetcher: async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (url.endsWith('/createOrder')) {
          triedServices.push(body.ORDER_SERVICE);
          if (body.ORDER_SERVICE === 'LCOD') {
            return { ok: true, json: async () => ({ status: 204, error: true, message: 'Price does not apply to this itinerary!' }) };
          }
          return { ok: true, json: async () => ({ status: 200, error: false, data: { ORDER_NUMBER: 'VT-NLP-OK', MONEY_TOTAL: 28000 } }) };
        }
        if (url.endsWith('/getPriceAllNlp')) {
          return {
            ok: true,
            json: async () => ({
              status: 200,
              RESULT: [
                { MA_DV_CHINH: 'LCOD', GIA_CUOC: 25000 },
                { MA_DV_CHINH: 'NCOD', GIA_CUOC: 28000 }
              ]
            })
          };
        }
        throw new Error('Unexpected: ' + url);
      }
    }
  );
  assert.deepEqual(triedServices, ['LCOD', 'NCOD']);
  assert.equal(res.carrierOrderId, 'GR-NLP-1-R2');

  // Verify J&T & SPX propagate carrierOrderNumber accurately too
  const spxCalls = [];
  const spxRes = await spxAdapter.createWaybill(
    { accountId: 'SPX1', secret: 'sec' },
    { orderNumber: 'GR-1', carrierOrderNumber: 'GR-1-R2', customerName: 'A', phone: '0900000000', address: 'A', city: 'Hà Nội', codAmountVnd: 100000 },
    {
      fetcher: async (_url, opts) => {
        spxCalls.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ code: 0, data: { tracking_number: 'SPX999', total_fee: 20000 } }) };
      }
    }
  );
  assert.equal(spxCalls[0].order_id, 'GR-1-R2');
  assert.equal(spxRes.carrierOrderId, 'GR-1-R2');

  // J&T payload verification
  const jtBodies = [];
  const jtRes = await jtAdapter.createWaybill(
    {
      protocol: 'jt-vn-open-platform-v1',
      environment: 'sandbox',
      accountId: 'VIP1',
      partnerCode: '90000000000000001',
      customerPassword: '00000000000000000000000000000000',
      secret: 'jt-sec',
      serviceType: 1,
      payType: 'PP_PM',
      pickupName: 'GAERU',
      pickupPhone: '0900000000',
      pickupAddress: '10 Pho Hue',
      pickupProvince: 'Hà Nội',
      pickupArea: 'Hai Bà Trưng'
    },
    {
      orderNumber: 'GR-2',
      carrierOrderNumber: 'GR-2-R3',
      weightGrams: 300,
      subtotalVnd: 200000,
      codAmountVnd: 200000,
      items: [{ productName: 'GAERU K9', variantName: 'Type-C', quantity: 1, priceVnd: 200000 }],
      receiver: { name: 'Khach', mobile: '0900000000', address: '20 Nguyen Hue', prov: 'Hồ Chí Minh', area: 'Quận 1' }
    },
    {
      fetcher: async (_url, opts) => {
        const params = new URLSearchParams(opts.body);
        const biz = JSON.parse(params.get('bizContent'));
        jtBodies.push(biz);
        return new Response(JSON.stringify({ code: '1', data: { txlogisticId: biz.txlogisticId, billCode: 'JT999', inquiryFee: 20000, codFee: 0, insuranceFee: 0 } }));
      }
    }
  );
  assert.equal(jtBodies[0].txlogisticId, 'GR-2-R3');
  assert.equal(jtRes.carrierOrderId, 'GR-2-R3');
});

test('Wave 4.4: After-exchange return eligibility and finance retained clawback revenue reconcile cleanly', async (t) => {
  const afterExchange = checkReturnEligibility(
    { status: 'completed', updated_at: new Date().toISOString(), return_completed_at: null },
    null,
    { id: 'case-ex-1', return_type: 'exchange' },
    null
  );
  assert.equal(afterExchange.eligible, true);

  const afterRefund = checkReturnEligibility(
    { status: 'completed', updated_at: new Date().toISOString(), return_completed_at: null },
    null,
    { id: 'case-ref-1', return_type: 'refund' },
    null
  );
  assert.equal(afterRefund.eligible, false);
  assert.equal(afterRefund.code, 'ALREADY_RETURNED');

  const pool = await createIsolatedPool(t);
  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'wave4-finance-clawback-secret-32-chars',
      ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('fixture-password', 4)
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;

  let cookie = '', csrf = '';
  const call = async (p, method = 'GET', body) => {
    const r = await fetch(base + p, {
      method,
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    const d = await r.json();
    if (d?.csrfToken) csrf = d.csrfToken;
    return { status: r.status, data: d };
  };

  await call('/api/csrf');
  await call('/api/auth/login', 'POST', { username: 'owner', password: 'fixture-password' });

  const ord = (await pool.query(
    `INSERT INTO orders(order_number,customer_name,email,phone,address,city,status,payment_status,payment_method,subtotal_vnd,total_vnd,return_completed_at)
     VALUES('GR-CLAWBACK-FIN','Fin User','fin@example.invalid','0911111111','HN','Hà Nội','completed','paid','vnpay',1000000,1000000,now()) RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO order_after_sales(order_id,kind,return_type,status,reason,resolution,refund_amount_vnd,loyalty_clawback_vnd)
     VALUES($1,'return','refund','resolved','Trả hàng hoàn tiền','Khấu trừ Xu đã tiêu',990000,10000)`,
    [ord.id]
  );

  const fin = await call('/api/gaeru_ceo/finance/summary');
  assert.equal(fin.data.summary.salesPaidVnd, 10000);
  const ov = await call('/api/gaeru_ceo/reports/overview');
  assert.equal(ov.data.summary.collectedVnd, 10000);
});

test('Wave 4.5-4.8: RMA Referrer-Policy, client fetch hygiene, image-originals DB precheck & sub-router CSRF', async (t) => {
  const pool = await createIsolatedPool(t);

  // Sub-router standalone CSRF checks when req.session / Cookie exists
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { id: 'admin-1', username: 'owner', role: 'owner', isOwner: true, permissions: ['*'] };
    if (req.headers['x-with-session'] === '1') req.session = { csrfToken: 'valid-token' };
    next();
  });
  app.use('/ai', createInternalAiRouter(pool, {}));
  app.use('/after', afterSalesRouter(pool));
  app.use('/api', createRmaApi(pool).publicApi);

  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const missingCsrfAi = await fetch(`${base}/ai/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-with-session': '1' },
    body: JSON.stringify({ title: 'Blocked' })
  });
  assert.equal(missingCsrfAi.status, 403);

  const missingCsrfAfter = await fetch(`${base}/after/orders/${randomUUID()}/after-sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'sid=1' },
    body: JSON.stringify({ kind: 'return', reason: 'Missing CSRF' })
  });
  assert.equal(missingCsrfAfter.status, 403);

  // RMA Referrer-Policy & optional chaining on empty body
  const ord = (await pool.query(
    `INSERT INTO orders(order_number,customer_name,email,phone,address,city,status,payment_status,payment_method,subtotal_vnd,total_vnd)
     VALUES('GR-RMA-W4','RMA User','rma@example.invalid','0900000000','1 A','Hà Nội','completed','paid','cod',100000,100000) RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO order_after_sales(order_id,kind,return_type,status,reason,rma_number,rma_token)
     VALUES($1,'return','exchange','approved','RMA test','RMA-261117-W401','secret-rma-tok')`,
    [ord.id]
  );

  const rmaGet = await fetch(`${base}/api/rma/RMA-261117-W401?token=secret-rma-tok`);
  assert.equal(rmaGet.status, 200);
  assert.equal(rmaGet.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(rmaGet.headers.get('cache-control'), 'no-store');

  const rmaEmptyBody = await fetch(`${base}/api/rma/RMA-261117-W401/inbound`, {
    method: 'POST',
    headers: { 'x-rma-token': 'secret-rma-tok' }
  });
  assert.equal(rmaEmptyBody.status, 400);

  // Client fetch() hygiene check
  const accountJs = fs.readFileSync(path.join(ROOT_DIR, 'account.js'), 'utf8');
  assert.match(accountJs, /fetch\('\/api\/customer-auth\/oauth\/pending-link', \{ cache: 'no-store', credentials: 'same-origin' \}\)/);
  assert.match(accountJs, /fetch\('\/api\/customer-auth\/oauth\/config', \{ cache: 'no-store', credentials: 'same-origin' \}\)/);

  const custExpJs = fs.readFileSync(path.join(ROOT_DIR, 'customer-experience.js'), 'utf8');
  assert.match(custExpJs, /fetch\('\/api\/customer-auth\/me',\{cache:'no-store',credentials:'same-origin'\}\);if\(!response\.ok\)return;/);

  const supportJs = fs.readFileSync(path.join(ROOT_DIR, 'support.js'), 'utf8');
  assert.match(supportJs, /fetch\('\/api\/products', \{ cache: 'no-store', credentials: 'same-origin' \}\)/);

  // image-originals DB precheck fails closed before writing orphan files when DB query rejects
  const tmpMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-w4-media-'));
  const prevMedia = process.env.MEDIA_ROOT;
  process.env.MEDIA_ROOT = tmpMedia;
  t.after(() => {
    if (prevMedia === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prevMedia;
    fs.rmSync(tmpMedia, { recursive: true, force: true });
  });
  const { preserveOriginal } = require('../src/lib/image-originals');
  await assert.rejects(
    () => preserveOriginal(
      { query: async () => { throw new Error('db down'); } },
      { scope: 'products', buffer: Buffer.from([1, 2, 3, 4]), mime: 'image/png', derivativeKey: `products/${randomUUID()}.webp` }
    ),
    (e) => e.status === 503 && e.code === 'IMAGE_ORIGINAL_METADATA_FAILED'
  );
  assert.equal(fs.readdirSync(tmpMedia).length, 0, 'No orphan directory/file may be created when DB fails precheck');
});
