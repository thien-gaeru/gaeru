const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const { createApp } = require('../src/app');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');

test('GAERU Storefront Mobile App (PWA) is configured, served, and installable on Android & iOS', async t => {
  // 1. Verify app icons on disk
  const icon192 = path.join(__dirname, '../assets/brand/gaeru-app-192.png');
  const icon512 = path.join(__dirname, '../assets/brand/gaeru-app-512.png');
  assert.ok(fs.existsSync(icon192), '192x192 PNG app icon must exist');
  assert.ok(fs.existsSync(icon512), '512x512 PNG app icon must exist');
  assert.ok(fs.statSync(icon192).size > 1000, '192x192 icon must be a valid PNG');
  assert.ok(fs.statSync(icon512).size > 5000, '512x512 icon must be a valid PNG');

  // 2. Verify manifest.webmanifest contents for Shopping App
  const manifestRaw = fs.readFileSync(path.join(__dirname, '../manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.short_name, 'GAERU Store');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/?source=pwa');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.theme_color, '#0066cc');
  assert.ok(manifest.categories.includes('shopping'), 'Must be classified in shopping category');
  assert.ok(manifest.icons.some(i => i.sizes === '192x192' && i.purpose.includes('maskable')));
  assert.ok(manifest.icons.some(i => i.sizes === '512x512' && i.purpose.includes('maskable')));
  assert.ok(manifest.shortcuts.length >= 4, 'Must provide shortcuts for shop, cart, orders, and care');

  // 3. Verify storefront service worker lifecycle, caching and push handlers
  const swCode = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
  assert.ok(swCode.includes("addEventListener('install'"), 'Must handle install event for PWA caching');
  assert.ok(swCode.includes("addEventListener('activate'"), 'Must handle activate event for cache rotation');
  assert.ok(swCode.includes("addEventListener('fetch'"), 'Must handle fetch event for fast mobile loading');
  assert.ok(swCode.includes("addEventListener('push'"), 'Must handle push notifications for order updates');
  assert.ok(swCode.includes("addEventListener('notificationclick'"), 'Must handle notification click');

  // 4. Verify pwa-storefront.js features
  const pwaJs = fs.readFileSync(path.join(__dirname, '../pwa-storefront.js'), 'utf8');
  assert.ok(pwaJs.includes('beforeinstallprompt'), 'Must handle beforeinstallprompt for Android one-touch install');
  assert.ok(pwaJs.includes('mobile-app-bottom-nav'), 'Must render bottom app bar for smartphones');
  assert.ok(pwaJs.includes('isIOS'), 'Must detect iOS for Safari Add to Home Screen instructions');
  assert.ok(pwaJs.includes('qrserver.com'), 'Must provide QR code for scanning via smartphone camera');
  assert.ok(pwaJs.includes('syncBottomNavCartBadge'), 'Must sync cart count with mobile bottom bar');

  // 5. Verify pwa-storefront.css mobile styling
  const pwaCss = fs.readFileSync(path.join(__dirname, '../pwa-storefront.css'), 'utf8');
  assert.ok(pwaCss.includes('.mobile-app-bottom-nav'), 'Must define bottom app bar styles');
  assert.ok(pwaCss.includes('safe-area-inset-bottom'), 'Must support iOS home indicator safe area');
  assert.ok(pwaCss.includes('.pwa-smart-banner'), 'Must style mobile smart install banner');

  // 6. Verify storefront pages link to manifest and mobile app meta
  const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(indexHtml.includes('rel="manifest" href="/manifest.webmanifest"'), 'index.html must link to manifest');
  assert.ok(indexHtml.includes('name="apple-mobile-web-app-capable" content="yes"'), 'index.html must declare iOS standalone');
  assert.ok(indexHtml.includes('name="apple-mobile-web-app-title" content="GAERU Store"'), 'index.html must set iOS app title');
  assert.ok(indexHtml.includes('rel="apple-touch-icon"'), 'index.html must have apple touch icon');

  const shopHtml = fs.readFileSync(path.join(__dirname, '../shop.html'), 'utf8');
  assert.ok(shopHtml.includes('rel="manifest" href="/manifest.webmanifest"'), 'shop.html must link to manifest');

  const storeShellJs = fs.readFileSync(path.join(__dirname, '../store-shell.js'), 'utf8');
  assert.ok(storeShellJs.includes('data-storefront-pwa-install'), 'store-shell.js must include in-app install buttons');
  assert.ok(storeShellJs.includes('initPWAStorefront'), 'store-shell.js must bootstrap storefront PWA');

  // 7. Test Express server routes for manifest, sw.js, and static assets
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
      SESSION_SECRET: 'storefront-pwa-session-secret-32-chars!!'
    }
  });
  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Test webmanifest endpoint
  const manifestRes = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestRes.status, 200);
  assert.ok(manifestRes.headers.get('content-type').includes('application/manifest+json'));
  const fetchedManifest = await manifestRes.json();
  assert.equal(fetchedManifest.short_name, 'GAERU Store');
  assert.equal(fetchedManifest.display, 'standalone');

  // Test manifest.json alias endpoint
  const manifestJsonRes = await fetch(`${baseUrl}/manifest.json`);
  assert.equal(manifestJsonRes.status, 200);

  // Test Service Worker endpoint
  const swRes = await fetch(`${baseUrl}/sw.js`);
  assert.equal(swRes.status, 200);
  assert.ok(swRes.headers.get('content-type').includes('javascript'));
  assert.equal(swRes.headers.get('service-worker-allowed'), '/');

  // Test pwa-storefront.js endpoint
  const pwaJsRes = await fetch(`${baseUrl}/pwa-storefront.js`);
  assert.equal(pwaJsRes.status, 200);
  assert.ok(pwaJsRes.headers.get('content-type').includes('javascript'));

  // Test pwa-storefront.css endpoint
  const pwaCssRes = await fetch(`${baseUrl}/pwa-storefront.css`);
  assert.equal(pwaCssRes.status, 200);
  assert.ok(pwaCssRes.headers.get('content-type').includes('css'));
});
