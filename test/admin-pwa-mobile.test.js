const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const { createApp } = require('../src/app');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');

test('Admin PWA for Android and iOS is configured, served, and installable', async t => {
  // 1. Verify app icons on disk
  const icon192 = path.join(__dirname, '../assets/brand/gaeru-app-192.png');
  const icon512 = path.join(__dirname, '../assets/brand/gaeru-app-512.png');
  assert.ok(fs.existsSync(icon192), '192x192 PNG app icon must exist');
  assert.ok(fs.existsSync(icon512), '512x512 PNG app icon must exist');
  assert.ok(fs.statSync(icon192).size > 1000, '192x192 icon must be a valid PNG');
  assert.ok(fs.statSync(icon512).size > 5000, '512x512 icon must be a valid PNG');

  // 2. Verify manifest.webmanifest contents
  const manifestRaw = fs.readFileSync(path.join(__dirname, '../admin/manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.short_name, 'GAERU CEO');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/gaeru_ceo');
  assert.equal(manifest.scope, '/gaeru_ceo');
  assert.ok(manifest.icons.some(i => i.sizes === '192x192' && i.purpose.includes('maskable')));
  assert.ok(manifest.icons.some(i => i.sizes === '512x512' && i.purpose.includes('maskable')));
  assert.ok(manifest.shortcuts.length >= 3);

  // 3. Verify notification-worker.js lifecycle and push handlers
  const workerCode = fs.readFileSync(path.join(__dirname, '../admin/notification-worker.js'), 'utf8');
  assert.ok(workerCode.includes("addEventListener('install'"), 'Must handle install event for PWA');
  assert.ok(workerCode.includes("addEventListener('activate'"), 'Must handle activate event for PWA');
  assert.ok(workerCode.includes("addEventListener('notificationclick'"), 'Must handle notificationclick event');
  assert.ok(workerCode.includes("addEventListener('push'"), 'Must handle push notifications');

  // 4. Verify admin/index.html includes manifest and iOS meta tags
  const indexHtml = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  assert.ok(indexHtml.includes('rel="manifest" href="/gaeru_ceo/manifest.webmanifest"'), 'Must link to manifest');
  assert.ok(indexHtml.includes('name="apple-mobile-web-app-capable" content="yes"'), 'Must declare iOS standalone capable');
  assert.ok(indexHtml.includes('name="apple-mobile-web-app-title" content="GAERU CEO"'), 'Must declare iOS app title');
  assert.ok(indexHtml.includes('rel="apple-touch-icon"'), 'Must specify Apple touch icon');
  assert.ok(indexHtml.includes('data-pwa-install-action'), 'Must contain in-app install action');

  // 5. Test Express server routes for manifest and pwa-install.js
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() { let release; const previous = queue; queue = new Promise(r => release = r); await previous; return release; }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    async connect() { const release = await lock(); return { query, release }; }
  };

  t.after(() => db.close());
  await migrateDatabase(pool);

  const sessionStore = new session.MemoryStore();
  const app = createApp({
    pool,
    sessionStore,
    config: {
      ADMIN_PASSWORD_HASH: 'dummy-hash',
      SESSION_SECRET: 'test-secret-at-least-32-chars-long!!'
    }
  });
  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Test webmanifest endpoint
  const manifestRes = await fetch(`${baseUrl}/gaeru_ceo/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  assert.ok(manifestRes.headers.get('content-type').includes('application/manifest+json'));
  const fetchedManifest = await manifestRes.json();
  assert.equal(fetchedManifest.short_name, 'GAERU CEO');

  // Test json alias endpoint
  const jsonRes = await fetch(`${baseUrl}/gaeru_ceo/manifest.json`);
  assert.equal(jsonRes.status, 200);

  // Test pwa-install.js asset endpoint
  const pwaJsRes = await fetch(`${baseUrl}/gaeru_ceo/assets/pwa-install.js`);
  assert.equal(pwaJsRes.status, 200);
  const pwaJsText = await pwaJsRes.text();
  assert.ok(pwaJsText.includes('getPlatformInfo'));
  assert.ok(pwaJsText.includes('openAppInstallModal'));

  // Test notification-worker.js endpoint
  const swRes = await fetch(`${baseUrl}/gaeru_ceo/notification-worker.js`);
  assert.equal(swRes.status, 200);
  assert.equal(swRes.headers.get('service-worker-allowed'), '/gaeru_ceo/');
});
