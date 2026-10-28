const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const local = require('../src/lib/filesystem-media');
const { createMarketing } = require('../src/marketing');
const { STORAGE_POINTER_PREFIX } = require('../src/lib/stored-images');

const bannerId = '8467673c-8a88-41f9-a6b1-ada46e04dec3';
const customerId = 'ce4ae2df-2de7-4298-b567-960d91b564b9';
const bannerKey = 'banners/' + bannerId + '.webp';
const adminPath = '/api/gaeru_ceo/marketing/banners/' + bannerId;
const customerPath = '/api/customer/marketing/banners/' + bannerId;

function get(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + path, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function start(t) {
  const fixture = {
    content: Buffer.from('legacy banner fixture'), mime: 'image/png',
    customerActive: true, campaignLinked: true, campaignActive: true, exists: true,
    storageBytes: Buffer.from('stored WebP banner fixture'), events: []
  };
  const send=t.mock.method(local,'readAsset',async key=>{fixture.events.push('storage');assert.equal(key,bannerKey);return fixture.storageBytes;});
  const pool = {
    async query(sql, values) {
      if (sql === 'SELECT id FROM customers WHERE id=$1 AND active=true') {
        fixture.events.push('customer');
        assert.deepEqual(values, [customerId]);
        return { rows: fixture.customerActive ? [{ id: customerId }] : [] };
      }
      if (sql.startsWith('SELECT content,mime_type FROM marketing_banner_images WHERE id=$1')) {
        fixture.events.push('banner');
        assert.deepEqual(values, [bannerId]);
        const customerRead = sql.includes('EXISTS');
        if (customerRead) assert.match(sql, /EXISTS\(SELECT 1 FROM marketing_campaigns WHERE banner_id=\$1 AND active=true AND now\(\) BETWEEN starts_at AND ends_at\)/);
        const visible = fixture.exists && (!customerRead || fixture.campaignLinked && fixture.campaignActive);
        return { rows: visible ? [{ content: fixture.content, mime_type: fixture.mime }] : [] };
      }
      throw new Error('Unexpected query in read-only banner test');
    }
  };
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers['x-test-admin']) req.admin = { permissions: req.headers['x-test-admin'] === 'read' ? ['marketing.read'] : [] };
    req.session = req.headers['x-test-customer'] ? { customer: { id: customerId } } : {};
    next();
  });
  const marketing = createMarketing(pool);
  app.use('/api/gaeru_ceo', marketing.admin);
  app.use('/api/customer/marketing', marketing.customer);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { fixture, send, base: 'http://127.0.0.1:' + server.address().port };
}

function assertPrivateImage(response, mime, bytes) {
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], mime);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(response.body, bytes);
}

test('authorized banner reads support legacy bytes and storage pointers after their access checks', async t => {
  const { fixture, send, base } = await start(t);
  const roles = [
    { path: adminPath, headers: { 'x-test-admin': 'read' }, checks: ['banner'] },
    { path: customerPath, headers: { 'x-test-customer': 'active' }, checks: ['customer', 'banner'] }
  ];
  for (const role of roles) {
    fixture.events.length = 0;
    const response = await get(base, role.path, role.headers);
    assertPrivateImage(response, fixture.mime, fixture.content);
    assert.deepEqual(fixture.events, role.checks);
  }
  assert.equal(send.mock.callCount(), 0);

  fixture.content = Buffer.concat([STORAGE_POINTER_PREFIX, Buffer.from(bannerKey)]);
  fixture.mime = 'image/webp';
  for (const role of roles) {
    fixture.events.length = 0;
    const response = await get(base, role.path, role.headers);
    assertPrivateImage(response, 'image/webp', fixture.storageBytes);
    assert.deepEqual(fixture.events, [...role.checks, 'storage']);
  }
  assert.equal(send.mock.callCount(), 2);
});

test('banner readers deny missing permissions and inactive customer sessions before object retrieval', async t => {
  const { fixture, send, base } = await start(t);
  fixture.content = Buffer.concat([STORAGE_POINTER_PREFIX, Buffer.from(bannerKey)]);
  fixture.mime = 'image/webp';
  for (const scenario of [
    { path: adminPath, headers: {}, status: 401, events: [] },
    { path: adminPath, headers: { 'x-test-admin': 'denied' }, status: 403, events: [] },
    { path: customerPath, headers: {}, status: 401, events: [] }
  ]) {
    fixture.events.length = 0;
    assert.equal((await get(base, scenario.path, scenario.headers)).status, scenario.status);
    assert.deepEqual(fixture.events, scenario.events);
  }
  fixture.customerActive = false;
  fixture.events.length = 0;
  assert.equal((await get(base, customerPath, { 'x-test-customer': 'inactive' })).status, 401);
  assert.deepEqual(fixture.events, ['customer']);
  assert.equal(send.mock.callCount(), 0);
});

test('invalid, missing and campaign-ineligible banners return 404 without object retrieval', async t => {
  const { fixture, send, base } = await start(t);
  fixture.content = Buffer.concat([STORAGE_POINTER_PREFIX, Buffer.from(bannerKey)]);
  fixture.mime = 'image/webp';
  assert.equal((await get(base, adminPath.replace(bannerId, 'not-a-uuid'), { 'x-test-admin': 'read' })).status, 404);
  assert.deepEqual(fixture.events, []);

  for (const condition of ['campaignLinked', 'campaignActive']) {
    fixture[condition] = false;
    fixture.events.length = 0;
    assert.equal((await get(base, customerPath, { 'x-test-customer': 'active' })).status, 404);
    assert.deepEqual(fixture.events, ['customer', 'banner']);
    fixture[condition] = true;
  }
  fixture.exists = false;
  fixture.events.length = 0;
  assert.equal((await get(base, adminPath, { 'x-test-admin': 'read' })).status, 404);
  assert.deepEqual(fixture.events, ['banner']);
  assert.equal(send.mock.callCount(), 0);
});
