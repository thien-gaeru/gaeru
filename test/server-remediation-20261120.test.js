'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { loadConfig } = require('../src/config');
const { FailoverSyncManager } = require('../src/failover-sync');
const { createAdminNotifications } = require('../src/admin-notifications');
const { adminProductList, listParams } = require('../src/admin-product-list');
const { recordVisit, getTrafficSummary } = require('../src/traffic-tracker');

test('staging generates independent credentials; legacy mode accepts only explicit true', () => {
  const config = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/fixture',
    SESSION_SECRET: 'session-fixture'.repeat(4), ADMIN_USERNAME: 'manager',
    ADMIN_PASSWORD_HASH: require('bcryptjs').hashSync('fixture password', 4) };
  const blueprint = fs.readFileSync(path.join(__dirname, '../render.yaml'), 'utf8');
  assert.match(blueprint, /key: SESSION_SECRET\s+generateValue: true/);
  assert.match(blueprint, /key: AUTH_ENCRYPTION_KEY\s+generateValue: true/);
  assert.throws(() => loadConfig({ ...config, ALLOW_LEGACY_SESSION_ENCRYPTION: 'false' }), /AUTH_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...config, AUTH_ENCRYPTION_KEY: config.SESSION_SECRET, ALLOW_LEGACY_SESSION_ENCRYPTION: 'true' }), /AUTH_ENCRYPTION_KEY/);
  assert.equal(loadConfig({ ...config, AUTH_ENCRYPTION_KEY: 'key-fixture'.repeat(4) }).ALLOW_LEGACY_SESSION_ENCRYPTION, false);
  assert.equal(loadConfig({ ...config, ALLOW_LEGACY_SESSION_ENCRYPTION: 'true' }).ALLOW_LEGACY_SESSION_ENCRYPTION, true);
});

test('failover measures readiness, shares each recent probe and exposes lag', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaeru-freshness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const config = { FAILOVER_STATE_PATH: path.join(dir, 'state.json'), SERVER_ROLE: 'standby',
    failoverHealthFetcher: async (url, opts) => {
      calls++;
      assert.equal(url.pathname, '/readyz');
      assert.equal(opts.method, 'HEAD');
      return { status: 503 };
    } };
  const manager = new FailoverSyncManager(config);
  assert.equal(manager.getStatus().primaryHealth.online, null);
  assert.equal(manager.getStatus().readyForTraffic, false);
  await Promise.all([manager.refreshStatus(), manager.refreshStatus()]);
  assert.equal(calls, 1);
  assert.equal(manager.getStatus().primaryHealth.online, false);
  manager.state.lastSyncTime = new Date(Date.now() - manager.getStatus().maxSyncAgeMs - 1000).toISOString();
  assert.equal(manager.getStatus().syncState, 'stale');
  assert.equal(manager.getStatus().readyForTraffic, false);
  manager.state.lastSyncTime = new Date().toISOString();
  assert.equal(manager.getStatus().catalogReady, true);
  assert.equal(manager.getStatus().readyForTraffic, false);
  assert.equal(manager.getStatus().trafficReadiness, 'not_verified');
  manager.state.status = 'syncing';
  assert.equal(manager.getStatus().catalogReady, false);
  manager.state.lastError = 'fixture failed';
  manager.saveState();
  assert.equal(new FailoverSyncManager(config).getStatus().readyForTraffic, false);
  manager.state.role = 'primary';
  assert.equal(manager.getStatus().readyForTraffic, false);
  await manager.checkPrimaryHealth({ fetcher: async () => ({ status: 200 }) });
  assert.equal(manager.getStatus().readyForTraffic, true);
  manager.state.primaryHealth.checkedAt = new Date(Date.now() - 61000).toISOString();
  assert.equal(manager.getStatus().readyForTraffic, false);
});

test('operators can check the primary and see standby data age without automatic polling', async () => {
  const js = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../admin/index.html'), 'utf8');
  const first = js.indexOf('document.querySelector("#health-check-failover")');
  const snippet = js.slice(first, js.indexOf('async function loadSystemHealth()', first));
  assert.match(html, /id="health-check-failover"/);
  const result = {};
  let handler, calls = 0;
  const button = { addEventListener(type, fn) { assert.equal(type, 'click'); handler = fn; } };
  require('node:vm').runInNewContext(snippet, {
    document: { querySelector: id => id === '#health-check-failover' ? button : result },
    request: async () => {
      calls++;
      return { role:'standby', status:'idle', primaryHealth:{ online:false, checkedAt:'2026-02-10T10:11:12Z' },
        catalogReady:false, syncState:'stale', syncAgeMs:7200000 };
    }
  });
  assert.equal(calls, 0);
  await handler({ currentTarget:button });
  assert.equal(calls, 1);
  assert.match(result.textContent, /chưa sẵn sàng/);
  assert.match(result.textContent, /quá hạn · 120 phút trước/);
  assert.match(result.textContent, /Chưa xác minh khả năng tiếp nhận đơn hàng/);
  assert.equal(button.disabled, false);
});

test('PostgreSQL audit regressions for visitor counters, notifications, product pages and restored articles', async t => {
  const db = await PGlite.create();
  t.after(() => db.close());
  const query = async (sql, values) => values === undefined && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
  const pool = { query, connect: async () => ({ query, release() {} }) };
  await migrateDatabase(pool);
  await t.test('two workers count one visitor; retries after a committed write cannot double-count', async () => {
    let loseResponse = true;
    const flaky = { query: async (...args) => {
      const result = await query(...args);
      if (loseResponse && args[0].includes('INSERT INTO site_traffic_batch_receipts')) {
        loseResponse = false;
        throw Error('simulated interruption after commit');
      }
      return result;
    } };
    const visit = { path: '/fixture', ip: '127.0.0.1', userAgent: 'Fixture Browser' };
    await Promise.all([recordVisit(flaky, visit), recordVisit(pool, visit)]);
    const result = await getTrafficSummary(flaky);
    assert.equal(result.availability, 'measured');
    assert.equal(result.todayVisitors, 1);
    assert.equal(result.todayPageviews, 2);
    const unavailable = await getTrafficSummary({ query: async () => { throw Error('temporarily unavailable'); } });
    assert.equal(unavailable.availability, 'unavailable');
    assert.equal(unavailable.todayPageviews, null);
    assert.equal(unavailable.activeNow, null);
  });
  await db.exec(`INSERT INTO products(slug,name,category,active,description)
    SELECT 'qa-page-'||n,'QA page '||n,'audio',true,repeat('x',512) FROM generate_series(1,31)n;
    INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active)
    SELECT id,upper(slug),'Variant',1000,3,true FROM products WHERE slug LIKE 'qa-page-%';`);
  await t.test('filtered SQL pages return only compact rows and retain search and stock semantics', async () => {
    const list = opts => adminProductList(pool, listParams.parse(opts));
    const full = await list({ q:'QA page', page:2, pageSize:25, stock:'low' });
    assert.equal(full.total, 31);
    assert.equal(full.products.length, 6);
    assert.equal(full.pages, 2);
    const sku = await list({ q:'qa-page-31' });
    assert.equal(sku.products.length, 1);
    assert.equal(sku.products[0].variants[0].sku, 'QA-PAGE-31');
    assert.equal(Object.hasOwn(sku.products[0], 'description'), false);
    assert.equal(Object.hasOwn(sku.products[0], 'gallery'), false);
    assert.equal((await list({ q:'QA page', stock:'out' })).total, 0);
    assert.equal((await list({ q:'%', page:999 })).page, 1);
  });
  await t.test('all 31 notices can be seen and counted independently from the current page', async t => {
    const app = express();
    let listQueries = 0;
    let maxItems = 0;
    const feedPool = { query: async (...args) => {
      const result = await query(...args);
      if (args[0].includes('page_items AS')) {
        assert.equal(result.rows.length, 1);
        listQueries++;
        maxItems = Math.max(maxItems, result.rows[0].items.length);
      }
      return result;
    } };
    app.use(express.json(), (req,res,next) => {
      req.session = { csrfToken: 'fixture' };
      req.admin = { id:'fixture', permissions: ['dashboard.read', ...(req.get('x-restricted') ? [] : ['inventory.read'])] };
      next();
    }, createAdminNotifications(feedPool, {}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/notifications';
    const read = async payload => {
      const response = await fetch(endpoint + '/read', { method:'POST', headers:{'Content-Type':'application/json','x-csrf-token':'fixture'}, body:JSON.stringify(payload) });
      assert.equal(response.status, 200);
    };
    const get = async (page, extra={}) => (await fetch(endpoint+'?page='+page, { headers:extra })).json();
    const first = await get(1);
    assert.equal(first.total, 31);
    assert.equal(first.unread, 31);
    assert.equal(first.items.length, 25);
    for (const { key, version } of first.items) await read({ key, version });
    const second = await get(2);
    assert.equal(second.unread, 6);
    assert.equal(second.items.length, 6);
    assert.equal((await get(1, {'x-restricted':'yes'})).total, 0);
    await read({ all:true });
    assert.equal((await get(2)).unread, 0);
    await pool.query('UPDATE product_variants SET stock_quantity=2 WHERE sku=$1',['QA-PAGE-31']);
    assert.equal((await get(1)).unread, 1);
    assert.equal(listQueries, 4);
    assert.equal(maxItems, 25);
  });
  await t.test('timestamp notification versions preserve legacy reads in different time zones', async () => {
    const { noticePage, readNotices } = require('../src/admin-notice-feed');
    const admin = { permissions:['orders.read'] };
    const { rows:[order] } = await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd,created_at)
      VALUES('GR-20261120-READ','QA','qa@example.invalid','0900000000','QA','QA','cod',100,100,'2026-11-20T10:00:00.678Z') RETURNING id`);
    const key='order:'+order.id;
    const oldVersion='Fri Nov 20 2026 15:45:00 GMT+0545 (Nepal Time)';
    await pool.query('INSERT INTO admin_notice_reads(account_key,notice_key,seen_version) VALUES($1,$2,$3)',['account-tz',key,oldVersion]);
    const visible = await noticePage(pool, admin, {}, 'account-tz');
    assert.equal(visible.items.find(n => n.key === key).read, true);
    assert.equal(await readNotices(pool,admin,{},'account-two',{ key,version:oldVersion }), true);
    assert.equal(await readNotices(pool,admin,{},'account-two',{ key,version:'Fri Nov 20 2026 16:45:00 GMT+0545 (Nepal Time)' }), false);
    assert.equal((await noticePage(pool,admin,{},'account-two')).items.find(n => n.key === key).read,true);
  });
  await t.test('ten seeded stories have covers; reapplication preserves editorial changes', async () => {
    const sql = fs.readFileSync(path.join(__dirname,'../db/practical-guides-and-comparisons-20261117.sql'),'utf8');
    const slugs = [...sql.matchAll(/INSERT INTO news_posts[^\n]+\nVALUES\(\s*'([^']+)'/g)].map(m => m[1]);
    assert.equal(slugs.length, 10);
    const posts = (await pool.query('SELECT p.slug FROM news_posts p JOIN news_images i ON i.id=p.cover_id WHERE octet_length(i.content)>0 AND p.slug=ANY($1::text[])',[slugs])).rows;
    assert.equal(posts.length, 10);
    await pool.query("UPDATE news_posts SET title='Edited fixture',status='draft' WHERE slug=$1",[slugs[0]]);
    await db.exec(sql);
    assert.deepEqual((await pool.query('SELECT title,status FROM news_posts WHERE slug=$1',[slugs[0]])).rows[0], { title:'Edited fixture',status:'draft' });
  });
});
