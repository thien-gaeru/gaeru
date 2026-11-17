'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const sharp = require('sharp');

const { parseStrictPositiveInt, assertUuid, parseOptionalUuid } = require('../src/lib/input-validation');
const { resolveGoogleIdentity } = require('../src/customer-oauth');
const { verifyGatewayPayload } = require('../src/payment-channels');
const localMedia = require('../src/lib/filesystem-media');
const storedMedia = require('../src/lib/stored-media');
const { ClusterStockCoordinator } = require('../src/lib/cluster-stock-coordinator');
const { createInternalAiRouter } = require('../src/internal-ai');
const { createBusinessApi } = require('../src/business-api');
const { createInventoryForecastApi } = require('../src/inventory-forecast');
const { mountBundles } = require('../src/product-bundles');
const { createOmnichannelSync } = require('../src/omnichannel-sync');
const checkoutFlow = require('../checkout-flow');
const careLive = require('../care-live');
const { ROLE_PERMISSIONS } = require('../src/staff-access');

function makeJsonApp(mountFn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.admin = { id: 'admin-1', username: 'owner', role: 'owner', source: 'bootstrap', isOwner: true, permissions: [...ROLE_PERMISSIONS.owner] };
    req.session = { csrfToken: 'test-csrf', admin: req.admin };
    req.headers['x-csrf-token'] = 'test-csrf';
    next();
  });
  mountFn(app);
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: err.message || 'error' });
  });
  return app;
}

test('input-validation strictly rejects floats, Infinity, negatives and malformed UUIDs', () => {
  assert.equal(parseStrictPositiveInt(undefined), 1);
  assert.equal(parseStrictPositiveInt(''), 1);
  assert.equal(parseStrictPositiveInt('3'), 3);
  for (const bad of ['0', '-1', '1.5', 'Infinity', 'NaN', '1e3', 'abc']) {
    assert.throws(() => parseStrictPositiveInt(bad), { status: 400 });
  }
  assert.equal(parseOptionalUuid(''), null);
  assert.equal(assertUuid('11111111-1111-4111-8111-111111111111'), '11111111-1111-4111-8111-111111111111');
  assert.throws(() => assertUuid('not-a-uuid'), { status: 400 });
  assert.throws(() => parseOptionalUuid('not-a-uuid'), { status: 400 });
});

test('routes validate page integers and UUIDs with HTTP 400 instead of DB 500', async (t) => {
  const noopPool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const app = makeJsonApp((a) => {
    const bundleAdmin = express.Router();
    mountBundles({ admin: bundleAdmin, publicRouter: express.Router() }, noopPool);
    a.use('/api/gaeru_ceo', bundleAdmin);
    a.use('/api/gaeru_ceo', createOmnichannelSync(noopPool, {}).admin);
    a.use('/api/gaeru_ceo', createInventoryForecastApi(noopPool));
    a.use('/api/gaeru_ceo', createBusinessApi(noopPool, {}));
    a.use('/api/gaeru_ceo/internal-ai', createInternalAiRouter(noopPool, {}));
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  t.after(() => new Promise(r => srv.close(r)));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const cases = [
    { url: '/api/gaeru_ceo/marketing/bundles?page=1.5', method: 'GET' },
    { url: '/api/gaeru_ceo/marketplace/orders?page=Infinity', method: 'GET' },
    { url: '/api/gaeru_ceo/inventory/forecast?warehouseId=bad-uuid', method: 'GET' },
    { url: '/api/gaeru_ceo/inventory/forecast/variant/bad-uuid', method: 'GET' },
    { url: '/api/gaeru_ceo/business/invoice/bad-uuid/issue', method: 'POST', body: {} },
    { url: '/api/gaeru_ceo/internal-ai/actions/bad-uuid/cancel', method: 'POST', body: {} }
  ];
  for (const c of cases) {
    const r = await fetch(base + c.url, {
      method: c.method,
      headers: { 'Content-Type': 'application/json' },
      ...(c.body ? { body: JSON.stringify(c.body) } : {})
    });
    assert.equal(r.status, 400, `${c.method} ${c.url} expected 400, got ${r.status}`);
  }
});

test('customer-oauth rejects soft-deleted email login with 403 restore message instead of 23505 collision', async () => {
  const client = {
    release() {},
    query: async (sql) => {
      const s = String(sql);
      if (s === 'BEGIN' || s === 'ROLLBACK' || s === 'COMMIT') return { rows: [] };
      if (s.includes('auth_identities')) return { rows: [] };
      if (s.includes('customers WHERE google_id = ')) return { rows: [] };
      if (s.includes('FROM customers WHERE lower(email) = ')) {
        assert.ok(!s.includes('AND deleted_at IS NULL'), 'Query must inspect soft-deleted records before INSERT');
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            email: 'deleted@example.com',
            fullName: 'Deleted User',
            phone: '0900000001',
            emailVerified: true,
            active: false,
            deletedAt: new Date().toISOString()
          }]
        };
      }
      throw new Error('Unexpected SQL query: ' + s);
    }
  };
  const mockPool = { connect: async () => client, query: client.query };
  await assert.rejects(
    resolveGoogleIdentity(mockPool, {
      sub: 'new-google-sub',
      issuer: 'https://accounts.google.com',
      email: 'deleted@example.com',
      emailVerified: true,
      name: 'Deleted User'
    }),
    (err) => err.status === 403 && /khôi phục tài khoản/.test(err.message)
  );
});

test('filesystem-media accepts image/heic originals and stored-media applies valid scope caps and rollback removal', async (t) => {
  const prevRoot = process.env.MEDIA_ROOT;
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gaeru-heic-media-'));
  process.env.MEDIA_ROOT = tmpRoot;
  t.after(async () => {
    if (prevRoot === undefined) delete process.env.MEDIA_ROOT;
    else process.env.MEDIA_ROOT = prevRoot;
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  });

  const heicBytes = Buffer.from('000000186674797068656963', 'hex');
  const uploaded = await localMedia.uploadAsset('products', heicBytes, 'image/heic');
  assert.match(uploaded.key, /^products\/[0-9a-f-]{36}\.heic$/);
  const stored = await localMedia.readAsset(uploaded.key);
  assert.ok(stored.equals(heicBytes));

  const pngBytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 30, b: 40 } }
  }).png().toBuffer();
  const articleRes = await storedMedia.storeUpload('articles', pngBytes, 'image/png', null, { removeBackground: false });
  assert.equal(articleRes.mimeType, 'image/webp');
  assert.ok(Number.isSafeInteger(articleRes.byteSize) && articleRes.byteSize > 0);
  const meta = storedMedia.metadata(articleRes.content);
  assert.ok(meta && meta.key.startsWith('articles/'));
  const removed = await storedMedia.removeUploadedMedia(articleRes.content);
  assert.equal(removed, true);
  await assert.rejects(() => localMedia.readAsset(meta.key), { code: 'ENOENT' });
});

test('payment-channels strict HMAC mode binds x-timestamp into signature calculation', () => {
  const secret = 'bank-transfer-webhook-secret-32chars';
  const payload = { id: 'tx-hmac-1', orderNumber: 'GR-20261117-0001', amount: 450000 };
  const rawBody = JSON.stringify(payload);
  const nowSec = String(Math.floor(Date.now() / 1000));
  const settings = { webhookSecret: secret, webhookRequireHmac: true };

  // Legacy body-only signature must fail strict timestamp+HMAC verification
  const legacySig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const legacyRes = verifyGatewayPayload('bank_transfer', payload, settings, {
    rawBody,
    headers: { 'x-timestamp': nowSec, 'x-signature': legacySig }
  });
  assert.equal(legacyRes.valid, false);

  // Signature bound to timestamp.rawBody must pass
  const boundSig = crypto.createHmac('sha256', secret).update(`${nowSec}.${rawBody}`).digest('hex');
  const boundRes = verifyGatewayPayload('bank_transfer', payload, settings, {
    rawBody,
    headers: { 'x-timestamp': nowSec, 'x-signature': boundSig }
  });
  assert.equal(boundRes.valid, true);
});

test('cluster-stock-coordinator rejects zero, negative, and non-integer stock mutations', async () => {
  const coord = new ClusterStockCoordinator();
  coord.isClustered = false;
  coord.setStock('v1', 5);
  assert.equal((await coord.atomicDecrement('v1', 0)).error, 'INVALID_QUANTITY');
  assert.equal((await coord.atomicDecrement('v1', -2)).error, 'INVALID_QUANTITY');
  assert.equal((await coord.atomicIncrement('v1', 'abc')).error, 'INVALID_QUANTITY');
  assert.equal(await coord.checkStock('v1'), 5);
  coord.setStock('v1', -9);
  assert.equal(await coord.checkStock('v1'), 5);
});

test('storefront checkout-flow normalizes uppercase Đ provinces and care-live closes SSE on 401/403', async () => {
  assert.equal(checkoutFlow.cityKey('Đà Nẵng'), 'da nang');
  assert.equal(checkoutFlow.cityKey('Đắk Lắk'), 'dak lak');
  assert.equal(checkoutFlow.cityKey('Đồng Nai'), 'dong nai');
  assert.equal(checkoutFlow.cityKey('Điện Biên'), 'dien bien');

  let esClosed = false;
  const fakeEnv = {
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    navigator: { onLine: true },
    EventSource: class {
      close() { esClosed = true; }
      addEventListener() {}
    },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {}
  };
  const controller = careLive.poll({
    streamUrl: '/api/realtime',
    environment: fakeEnv,
    delay: 10000,
    run: async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); },
    status: () => {}
  });
  controller.refresh();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(esClosed, true, 'SSE EventSource must be closed when 401/403 stops polling');
  controller.stop();
});

test('storefront and admin UI regression assertions across fixed modules', () => {
  const root = path.join(__dirname, '..');
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

  assert.match(read('admin/marketing.js'), /showTab\('promotions',create\.dataset\.pNew\)/);
  assert.match(read('admin/marketing.js'), /admin\.can\('marketing\.write'\)&&admin\.can\('customers\.read'\)/);
  assert.match(read('admin/configuration.js'), /function owner\(\)\{return Boolean\(admin\.user\?\.role==='owner'&&admin\.user\?\.source==='bootstrap'\);?\}/);
  assert.match(read('admin/internal-ai.js'), /#admin-navigation \.nav-item/);
  assert.match(read('admin/news.js'), /preview\.onerror=revoke/);
  assert.match(read('admin/admin.js'), /addEventListener\('session-expired'/);
  assert.match(read('admin/shopping-chat.js'), /if\(loading\)return;/);
  assert.match(read('admin/shopping-chat.js'), /!root\.hidden/);
  assert.match(read('admin/marketplace-sync.js'), /pagerFailed/);
  assert.match(read('admin/product-editor.js'), /remainingSlots=Math\.max\(0,9-model\.gallery\.length-imageUploads\.length\)/);
  assert.match(read('admin/product-editor.js'), /targetIndex=model\.gallery\.indexOf\(url\)/);
  assert.match(read('admin/barcode.js'), /window\.GAERUAdmin\.can\("orders\.write"\)/);
  assert.match(read('admin/cod-return.js'), /can\?\.\('inventory\.write'\)/);
  assert.match(read('admin/ai-knowledge.js'), /a\.can\('settings\.write'\)/);
  assert.match(read('care.js'), /failed=true/);
  assert.match(read('tracking.js'), /clipboard\?\.writeText[\s\S]*\.catch\(/);
  assert.match(read('vietnam-address.js'), /if\(!wrap\.isConnected\)\{doc\.removeEventListener\('click',onDocClick\);return;\}/);
  assert.match(read('action-feedback.js'), /const escModal =/);
  assert.match(read('store-shell.js'), /ket-qua-thanh-toan/);
  assert.doesNotMatch(read('store-shell.js'), /addEventListener\([^)]*credentials:/);
});
