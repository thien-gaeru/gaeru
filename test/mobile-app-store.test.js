const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const { createApp } = require('../src/app');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');

test('GAERU Mobile App package and store distribution infrastructure is configured and served', async t => {
  // 1. Verify capacitor.config.json
  const capConfigPath = path.join(__dirname, '../mobile-app/capacitor.config.json');
  assert.ok(fs.existsSync(capConfigPath), 'Capacitor config must exist');
  const capConfig = JSON.parse(fs.readFileSync(capConfigPath, 'utf8'));
  assert.equal(capConfig.appId, 'com.gaeru.store');
  assert.equal(capConfig.appName, 'GAERU Store');
  assert.equal(capConfig.server.url, 'https://gaeru.com');

  // 2. Verify Android Project Manifest & Config
  const androidManifestPath = path.join(__dirname, '../mobile-app/android/app/src/main/AndroidManifest.xml');
  assert.ok(fs.existsSync(androidManifestPath), 'AndroidManifest.xml must exist');
  const androidManifest = fs.readFileSync(androidManifestPath, 'utf8');
  assert.ok(androidManifest.includes('android.permission.INTERNET'));
  assert.ok(androidManifest.includes('android.permission.POST_NOTIFICATIONS'));
  assert.ok(androidManifest.includes('host="gaeru.com"'), 'Must declare App Links for gaeru.com');

  const androidStringsPath = path.join(__dirname, '../mobile-app/android/app/src/main/res/values/strings.xml');
  assert.ok(fs.existsSync(androidStringsPath));
  const androidStrings = fs.readFileSync(androidStringsPath, 'utf8');
  assert.ok(androidStrings.includes('GAERU Store'));

  // 3. Verify iOS Project Config
  const iosPlistPath = path.join(__dirname, '../mobile-app/ios/App/App/Info.plist');
  assert.ok(fs.existsSync(iosPlistPath), 'iOS Info.plist must exist');
  const iosPlist = fs.readFileSync(iosPlistPath, 'utf8');
  assert.ok(iosPlist.includes('GAERU Store'));
  assert.ok(iosPlist.includes('NSCameraUsageDescription'));

  // 4. Verify Store Publishing Guide
  const guidePath = path.join(__dirname, '../docs/HUONG-DAN-XUAT-BAN-APP-KHO-UNG-DUNG.md');
  assert.ok(fs.existsSync(guidePath), 'Publishing guide must exist');
  const guideContent = fs.readFileSync(guidePath, 'utf8');
  assert.ok(guideContent.includes('Google Play'));
  assert.ok(guideContent.includes('App Store'));
  assert.ok(guideContent.includes('com.gaeru.store'));
  assert.ok(guideContent.includes('.aab'));

  // 5. Verify App landing page (app.html) & store-shell links
  const appHtmlPath = path.join(__dirname, '../app.html');
  assert.ok(fs.existsSync(appHtmlPath), 'app.html must exist');
  const appHtml = fs.readFileSync(appHtmlPath, 'utf8');
  assert.ok(appHtml.includes('Google Play'));
  assert.ok(appHtml.includes('App Store'));
  assert.ok(appHtml.includes('com.gaeru.store'));
  assert.ok(appHtml.includes('gaeru-store.apk'));

  const shellJs = fs.readFileSync(path.join(__dirname, '../store-shell.js'), 'utf8');
  assert.ok(shellJs.includes('app.html'), 'store-shell.js must link to app.html');

  // 6. Test Express server routes for App Links, Universal Links, and Landing Page
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
      SESSION_SECRET: 'mobile-app-store-session-secret-32-chars!'
    }
  });
  const server = app.listen(0);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Test /tai-app landing route
  const landingRes = await fetch(`${baseUrl}/tai-app`);
  assert.equal(landingRes.status, 200);
  const landingText = await landingRes.text();
  assert.ok(landingText.includes('GAERU Store App'));

  // Test Android assetlinks.json
  const assetLinksRes = await fetch(`${baseUrl}/.well-known/assetlinks.json`);
  assert.equal(assetLinksRes.status, 200);
  assert.ok(assetLinksRes.headers.get('content-type').includes('application/json'));
  const assetLinks = await assetLinksRes.json();
  assert.equal(assetLinks[0].target.package_name, 'com.gaeru.store');

  // Test Apple apple-app-site-association
  const appleSiteRes = await fetch(`${baseUrl}/.well-known/apple-app-site-association`);
  assert.equal(appleSiteRes.status, 200);
  assert.ok(appleSiteRes.headers.get('content-type').includes('application/json'));
  const appleSite = await appleSiteRes.json();
  assert.ok(appleSite.applinks.details[0].appID.includes('com.gaeru.store'));
});
