'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const sharp = require('sharp');

process.env.MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-batch-upload-test-'));

test('imageProcessor module exports and processProductImage batch core execution', async () => {
  const rootProcessor = require('../imageProcessor');
  const srcProcessor = require('../src/imageProcessor');
  assert.equal(typeof rootProcessor.processProductImage, 'function');
  assert.equal(typeof srcProcessor.processProductImage, 'function');

  const svg = Buffer.from('<svg width="600" height="600"><rect width="600" height="600" fill="white"/><rect x="150" y="150" width="300" height="300" fill="#224466"/></svg>');
  const png = await sharp(svg).png().toBuffer();

  const result = await rootProcessor.processProductImage(png, { enableShadow: true, mainSize: 1000, thumbSize: 400 });
  assert.ok(result);
  assert.ok(result.mainBuffer);
  assert.ok(result.thumbBuffer);

  const mainMeta = await sharp(result.mainBuffer).metadata();
  assert.equal(mainMeta.width, 1000);
  assert.equal(mainMeta.height, 1000);

  const thumbMeta = await sharp(result.thumbBuffer).metadata();
  assert.equal(thumbMeta.width, 400);
  assert.equal(thumbMeta.height, 400);
});

test('Batch Upload API processes multi-image album, dual resolutions, and disk copy', async t => {
  const { createLocalPool } = require('../src/local-server');
  const pool = await createLocalPool();
  await require('../src/migrate').migrateDatabase(pool);
  t.after(() => pool.end());

  const password = crypto.randomBytes(20).toString('hex');
  const config = {
    NODE_ENV: 'test',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_USERNAME: 'test-batch-admin',
    ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync(password, 4),
    PUBLIC_BASE_URL: 'https://gaeru.com'
  };

  const app = require('../src/app').createApp({
    config,
    pool,
    sessionStore: new (require('express-session').MemoryStore)(),
    customerMailer: { sendMail: async () => ({ accepted: [], rejected: [] }) }
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => {
    server.closeAllConnections();
    server.close(r);
  }));

  const base = 'http://127.0.0.1:' + server.address().port;

  // Login as admin
  let r = await fetch(base + '/api/csrf');
  let cookie = r.headers.get('set-cookie').split(';')[0];
  let token = (await r.json()).csrfToken;

  r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token },
    body: JSON.stringify({ username: 'test-batch-admin', password })
  });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  token = (await r.json()).csrfToken;
  const adminHeaders = { Cookie: cookie, 'X-CSRF-Token': token };

  // Prepare 3 test product images with white background
  const img1 = await sharp(Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="white"/><rect x="40" y="40" width="120" height="120" fill="#e11d48"/></svg>')).png().toBuffer();
  const img2 = await sharp(Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="white"/><circle cx="100" cy="100" r="60" fill="#2563eb"/></svg>')).png().toBuffer();
  const img3 = await sharp(Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="white"/><polygon points="100,30 170,170 30,170" fill="#16a34a"/></svg>')).png().toBuffer();

  await t.test('POST /api/upload-batch-products public route is closed (returns 404)', async () => {
    const form = new FormData();
    form.append('images', new Blob([img1], { type: 'image/png' }), 'product-1.png');

    const res = await fetch(base + '/api/upload-batch-products', {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 404);
  });

  await t.test('POST /api/gaeru_ceo/upload-batch-products requires admin auth and CSRF (returns 401)', async () => {
    const form = new FormData();
    form.append('images', new Blob([img1], { type: 'image/png' }), 'product-1.png');

    const res = await fetch(base + '/api/gaeru_ceo/upload-batch-products', {
      method: 'POST',
      body: form
    });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/gaeru_ceo/upload-batch-products accepts multiple images with admin auth', async () => {
    const form = new FormData();
    form.append('images', new Blob([img1], { type: 'image/png' }), 'product-1.png');
    form.append('images', new Blob([img2], { type: 'image/png' }), 'product-2.png');
    form.append('images', new Blob([img3], { type: 'image/png' }), 'product-3.png');
    form.append('enableShadow', 'true');

    const res = await fetch(base + '/api/gaeru_ceo/upload-batch-products', {
      method: 'POST',
      headers: adminHeaders,
      body: form
    });

    assert.equal(res.status, 201);
    const result = await res.json();
    assert.equal(result.success, true);
    assert.equal(result.count, 3);
    assert.equal(result.data.length, 3);

    for (let i = 0; i < 3; i++) {
      const item = result.data[i];
      assert.ok(item.imageUrl, 'has imageUrl');
      assert.ok(item.thumbUrl, 'has thumbUrl');
      assert.equal(item.backgroundRemoved, true);

      // Verify main image dimensions (1000x1000 WebP)
      const mainResp = await fetch(base + item.imageUrl.replace('/api/', '/api/gaeru_ceo/'), { headers: adminHeaders });
      const mainBuf = Buffer.from(await mainResp.arrayBuffer());
      const mainMeta = await sharp(mainBuf).metadata();
      assert.equal(mainMeta.format, 'webp');
      assert.equal(mainMeta.width, 1000);
      assert.equal(mainMeta.height, 1000);

      // Verify thumb image dimensions (400x400 WebP)
      const thumbResp = await fetch(base + item.thumbUrl.replace('/api/', '/api/gaeru_ceo/'), { headers: adminHeaders });
      const thumbBuf = Buffer.from(await thumbResp.arrayBuffer());
      const thumbMeta = await sharp(thumbBuf).metadata();
      assert.equal(thumbMeta.format, 'webp');
      assert.equal(thumbMeta.width, 400);
      assert.equal(thumbMeta.height, 400);

      // Verify static disk file is served under /public/uploads/
      if (item.publicUrl) {
        const pubResp = await fetch(base + item.publicUrl);
        assert.equal(pubResp.status, 200);
        assert.equal(pubResp.headers.get('content-type'), 'image/webp');
      }
    }
  });

  await t.test('POST /api/gaeru_ceo/catalog-images/batch with admin CSRF auth', async () => {
    const form = new FormData();
    form.append('images', new Blob([img1], { type: 'image/png' }), 'album-a.png');
    form.append('images', new Blob([img2], { type: 'image/png' }), 'album-b.png');
    form.append('enableShadow', 'true');

    const res = await fetch(base + '/api/gaeru_ceo/catalog-images/batch', {
      method: 'POST',
      headers: adminHeaders,
      body: form
    });

    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.count, 2);
    assert.equal(body.data.length, 2);
    assert.match(body.data[0].imageUrl, /^\/api\/catalog-images\/[0-9a-f-]{36}$/);
  });

  await t.test('Batch Upload rejects empty submission with 400', async () => {
    const form = new FormData();
    const res = await fetch(base + '/api/gaeru_ceo/upload-batch-products', {
      method: 'POST',
      headers: adminHeaders,
      body: form
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Vui lòng chọn ít nhất một file ảnh.');
  });
});
