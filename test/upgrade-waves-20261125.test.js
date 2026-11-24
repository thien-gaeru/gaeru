'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const session = require('express-session');
const { createApp, attachTransactionalCacheInvalidation } = require('../src/app');
const { MIGRATION_FILES } = require('../src/migrate');
const { readRecord } = require('../src/admin-configuration');
const { createAccountSecurity } = require('../src/account-security');
const { sealWithPrimaryKey, resolveEncryptionKeys } = require('../src/audit-fixes/encryption-key');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Wave 1 (A1): Production proxy IP trust requires valid CF-Ray alongside CF-Connecting-IP', async (t) => {
  const pool = { query: async () => ({ rows: [] }) };
  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://gaeru.com',
      SESSION_SECRET: 'wave1-proxy-test-secret-at-least-32-chars'
    }
  });
  let observedIp = null;
  // Inspect req.ip via a probe route mounted on an express wrapper
  const express = require('express');
  const hostApp = express();
  hostApp.use((req, _res, next) => {
    resHook(req);
    next();
  });
  function resHook(req) {
    Object.defineProperty(req, '__captureIp', {
      configurable: true,
      get() { return req.ip; }
    });
  }
  // Directly test createApp's /api/csrf while observing rate-limit / req headers mutation
  let capturedHeaders = null;
  pool.query = async () => ({ rows: [] });
  const server = http.createServer((req, res) => {
    res.on('finish', () => {
      capturedHeaders = { xff: req.headers['x-forwarded-for'], cfIp: req.headers['cf-connecting-ip'] };
    });
    app(req, res);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;

  const reqWithHeaders = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/csrf', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, captured: { ...capturedHeaders } }));
    }).on('error', reject);
  });

  // 1. Spoofed CF-Connecting-IP without CF-Ray -> stripped in production
  const spoofed = await reqWithHeaders({
    Host: 'gaeru.com',
    'X-Forwarded-Proto': 'https',
    'CF-Connecting-IP': '198.51.100.77',
    'X-Forwarded-For': '198.51.100.77'
  });
  assert.equal(spoofed.captured.xff, undefined);
  assert.equal(spoofed.captured.cfIp, undefined);

  // 2. Valid Cloudflare Tunnel request (CF-Connecting-IP + valid CF-Ray) -> trusted
  const genuine = await reqWithHeaders({
    Host: 'gaeru.com',
    'X-Forwarded-Proto': 'https',
    'CF-Connecting-IP': '203.0.113.42',
    'CF-Ray': '8e8f9a0b1c2d3e4f-SGN'
  });
  assert.equal(genuine.captured.xff, '203.0.113.42');
});

test('Wave 1 (A2, C3) & Nginx removal: Server Console enforces WS Origin, revokes old 2FA sessions, and removes Nginx', () => {
  const mi6Server = require('../infra/mi6/admin/server.js');
  const { sessions, checkSameOrigin } = mi6Server._test;
  const serverSrc = read('infra/mi6/admin/server.js');
  const indexHtml = read('infra/mi6/admin/public/index.html');
  const watchdogSh = read('scripts/network_watchdog.sh');
  const syncPs1 = read('scripts/sync-to-mi6.ps1');

  assert.doesNotMatch(serverSrc, /\['nginx'/);
  assert.doesNotMatch(serverSrc, /'nginx-access'/);
  assert.doesNotMatch(indexHtml, /'nginx'/);
  assert.doesNotMatch(watchdogSh, /ensure_upstart nginx/);
  assert.doesNotMatch(syncPs1, /nginx_static_cache|reload nginx/);
  assert.match(syncPs1, /\/run\/gaeru-deploy\.lock/);
  assert.match(read('scripts/node-app.conf'), /MALLOC_ARENA_MAX="\$\{MALLOC_ARENA_MAX:-2\}"/);

  // Same-site subdomain Origin (https://gaeru.com -> server.gaeru.com) must fail checkSameOrigin
  assert.equal(
    checkSameOrigin({
      headers: { host: 'server.gaeru.com', origin: 'https://gaeru.com', 'sec-fetch-site': 'same-site' }
    }),
    false
  );
  assert.equal(
    checkSameOrigin({
      headers: { host: 'server.gaeru.com', origin: 'https://server.gaeru.com', 'sec-fetch-site': 'same-origin' }
    }),
    true
  );
  assert.match(serverSrc, /if \(!req\.headers\.origin \|\| !checkSameOrigin\(req\)\) return socket\.destroy\(\);/);
  assert.match(serverSrc, /revokeOtherSessions/);
  assert.match(serverSrc, /fs\.statfsSync\(mount\)/);
  sessions.clear();
});

test('Wave 2 (B1, B2, B3, A4): Migration registered, L1 caches hit & purge on transactional commit, and sharedStore attached', async () => {
  assert.ok(MIGRATION_FILES.includes('performance-indexes-and-dedup-20261125.sql'));
  const sql = read('db/performance-indexes-and-dedup-20261125.sql');
  assert.match(sql, /DROP INDEX IF EXISTS idx_audit_events_created_id_desc;/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_shopping_chat_ai_jobs_active/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_order_email_outbox_active/);

  // Verify L1 cache hit + transactional invalidation for readRecord & accountSecurity.settings
  const cfg = {
    NODE_ENV: 'test',
    ENABLE_L1_CONFIG_CACHE: true,
    ENABLE_L1_SECURITY_CACHE: true,
    SESSION_SECRET: 'wave2-l1-cache-test-secret-32-bytes!!'
  };
  const keys = resolveEncryptionKeys(cfg);
  let settingsSelects = 0;
  let secSelects = 0;
  let secVersion = 2;
  let idleMinutes = 30;

  const mockPool = {
    async query(text) {
      if (text.includes('FROM store_settings')) {
        settingsSelects++;
        return {
          rows: [{
            setting_value: {
              version: 1,
              cipher: sealWithPrimaryKey(JSON.stringify({ idleMinutes, absoluteHours: 4 }), keys)
            }
          }]
        };
      }
      if (text.includes('FROM account_security')) {
        secSelects++;
        return { rows: [{ account_key: 'owner', method: 'app', version: secVersion, recovery_hashes: [] }] };
      }
      return { rows: [] };
    },
    async connect() {
      return {
        async query(text) { return mockPool.query(text); },
        release() {}
      };
    }
  };
  attachTransactionalCacheInvalidation(mockPool);
  const sec = createAccountSecurity(mockPool, cfg, null);

  const r1 = await readRecord(mockPool, cfg, 'security');
  const r2 = await readRecord(mockPool, cfg, 'security');
  assert.equal(r1.data.idleMinutes, 30);
  assert.equal(r2.data.idleMinutes, 30);
  assert.equal(settingsSelects, 1, 'Second readRecord should hit L1 cache');

  const s1 = await sec.settings('owner');
  const s2 = await sec.settings('owner');
  assert.equal(s1.version, 2);
  assert.equal(s2.version, 2);
  assert.equal(secSelects, 1, 'Second accountSecurity.settings should hit L1 cache');

  // Transactional client ('release' in client) must bypass L1 cache
  const txClient = await mockPool.connect();
  await readRecord(txClient, cfg, 'security');
  await sec.settings('owner', txClient);
  txClient.release();
  assert.equal(settingsSelects, 2);
  assert.equal(secSelects, 2);

  // Committing UPDATE on store_settings and account_security must auto-purge L1 caches
  idleMinutes = 45;
  secVersion = 3;
  const tx2 = await mockPool.connect();
  await tx2.query('BEGIN');
  await tx2.query("UPDATE store_settings SET updated_at = now() WHERE setting_key = 'private_admin:security'");
  await tx2.query("UPDATE account_security SET version = 3 WHERE account_key = 'owner'");
  await tx2.query('COMMIT');
  tx2.release();

  const r3 = await readRecord(mockPool, cfg, 'security');
  const s3 = await sec.settings('owner');
  assert.equal(r3.data.idleMinutes, 45);
  assert.equal(s3.version, 3);

  for (const rel of ['src/shipping-choice.js', 'src/omnichannel-sync.js', 'src/warranty-management.js', 'src/catalog-videos.js', 'src/product-workspace.js', 'src/barcode-api.js']) {
    assert.match(read(rel), /sharedStore\(/, `${rel} must wire sharedStore`);
  }
});

test('Wave 3 (C1): Admin HTML stamps content hashes, promotes matching ?v=<hash12> to immutable, and defers heavy tab bundles', async (t) => {
  const staticAssetCache = require('../src/lib/static-asset-cache');
  process.env.GAERU_ENABLE_MINIFY = '1';
  staticAssetCache._clearCacheForTest();
  t.after(() => {
    delete process.env.GAERU_ENABLE_MINIFY;
    staticAssetCache._clearCacheForTest();
  });
  const adminHtml = read('admin/index.html');
  assert.match(adminHtml, /<template data-admin-assets="barcode"><script src="\/gaeru_ceo\/assets\/barcode\.js/);
  assert.match(adminHtml, /<template data-admin-assets="shopping-chat"><script src="\/shopping-chat-client\.js/);
  assert.match(adminHtml, /<template data-admin-assets="inventory warehouses purchases suppliers finance reports staff departments audit"><script src="\/gaeru_ceo\/assets\/enterprise\.js/);

  const pool = { query: async () => ({ rows: [] }) };
  const server = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: { NODE_ENV: 'test', SESSION_SECRET: 'wave3-admin-asset-cache-secret-32!!' }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const get = (urlPath) => new Promise((resolve, reject) => {
    http.get(base + urlPath, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  const page = await get('/gaeru_ceo');
  assert.equal(page.status, 200);
  const html = page.body.toString('utf8');
  const match = /\/gaeru_ceo\/assets\/admin\.js\?v=([0-9a-f]{12})/.exec(html);
  assert.ok(match, 'Served /gaeru_ceo HTML must stamp 12-char SHA-256 onto admin.js');

  const assetImm = await get(`/gaeru_ceo/assets/admin.js?v=${match[1]}`);
  assert.equal(assetImm.status, 200);
  assert.equal(assetImm.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(assetImm.headers['content-encoding'], 'gzip');
  const decodedJs = zlib.gunzipSync(assetImm.body).toString('utf8');
  assert.ok(decodedJs.includes('GAERUAdmin'));
  assert.ok(decodedJs.length < fs.statSync(path.join(ROOT, 'admin', 'admin.js')).size, 'esbuild must minify JS payload');
});
