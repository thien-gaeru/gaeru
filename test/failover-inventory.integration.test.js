'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { withTransaction } = require('../src/db');
const inventory = require('../src/inventory');
const { FailoverSyncManager } = require('../src/failover-sync');

async function fixture(t) {
  const db = await PGlite.create();
  t.after(() => db.close());
  let queue = Promise.resolve();
  async function lock() { const prior = queue; let release; queue = new Promise(r => { release = r; }); await prior; return release; }
  async function query(sql, values) { const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values); return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 }; }
  const pool = {
    async query(sql, values) { const release = await lock(); try { return await query(sql, values); } finally { release(); } },
    async connect() { const release = await lock(); return { query, release }; }
  };
  await migrateDatabase(pool);
  const manager = new FailoverSyncManager({}, pool);
  manager.saveState = () => {};
  const snapshot = quantity => [{ slug: 'failover-test', name: 'Test product', category: 'audio', variants: [{ sku: 'FAILOVER-SKU', name: 'Test variant', priceVnd: 100000, stockQuantity: quantity }] }];
  const fetcher = (products, settings = { shippingRates: {} }) => async url => ({ ok: true, json: async () => url.endsWith('/api/products') ? { products } : settings });
  const balance = async () => (await pool.query("SELECT v.id,v.stock_quantity,COALESCE(SUM(w.quantity),0)::int AS warehouse_quantity FROM product_variants v LEFT JOIN warehouse_stock w ON w.variant_id=v.id WHERE v.sku='FAILOVER-SKU' GROUP BY v.id")).rows[0];
  return { pool, manager, snapshot, fetcher, balance };
}

test('failover initializes warehouse stock, preserves IDs/history, and imported inventory can be reserved', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.syncFromPrimary({ fetcher: f.fetcher(f.snapshot(7)) })).ok, true);
  const first = await f.balance();
  assert.equal(first.stock_quantity, 7); assert.equal(first.warehouse_quantity, 7);
  const firstMovements = (await f.pool.query('SELECT id FROM inventory_movements WHERE variant_id=$1', [first.id])).rows.map(r => r.id);
  assert.ok(firstMovements.length > 0);
  assert.equal((await f.manager.syncFromPrimary({ fetcher: f.fetcher(f.snapshot(7)) })).ok, true);
  assert.deepEqual((await f.pool.query('SELECT id FROM inventory_movements WHERE variant_id=$1', [first.id])).rows.map(r => r.id), firstMovements, 'identical snapshot must not duplicate stock movements');
  assert.equal((await f.manager.syncFromPrimary({ fetcher: f.fetcher(f.snapshot(4)) })).ok, true);
  assert.deepEqual(await f.balance(), { id: first.id, stock_quantity: 4, warehouse_quantity: 4 });
  const remainingIds = new Set((await f.pool.query('SELECT id FROM inventory_movements WHERE variant_id=$1', [first.id])).rows.map(r => r.id));
  assert.ok(firstMovements.every(id => remainingIds.has(id)), 'previous movements remain immutable');
  const order = (await f.pool.query("INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd) VALUES('GR-20261110-FAILOVER','Test','test@example.invalid','0900000000','Test','Test','cod',100000,100000) RETURNING id")).rows[0];
  await withTransaction(f.pool, client => inventory.reserveStock(client, { variantId: first.id, quantity: 1, orderId: order.id, actor: { username: 'test' } }));
  assert.deepEqual(await f.balance(), { id: first.id, stock_quantity: 3, warehouse_quantity: 3 });
});

test('failed inventory reconciliation rolls back the complete snapshot and retains last successful sync', async t => {
  const f = await fixture(t);
  await f.manager.syncFromPrimary({ fetcher: f.fetcher(f.snapshot(7), { marker: 'before' }) });
  const before = await f.balance(), lastSync = f.manager.state.lastSyncTime;
  await f.pool.query('UPDATE warehouse_stock SET quantity=6 WHERE variant_id=$1', [before.id]);
  const products = [{ slug: 'a-new-product', name: 'New', category: 'audio', variants: [] }, ...f.snapshot(9)];
  const result = await f.manager.syncFromPrimary({ fetcher: f.fetcher(products, { marker: 'after' }) });
  assert.equal(result.ok, false); assert.match(result.error, /chưa khớp/);
  assert.equal(f.manager.state.status, 'error'); assert.equal(f.manager.state.lastSyncTime, lastSync);
  assert.equal((await f.pool.query("SELECT id FROM products WHERE slug='a-new-product'")).rows.length, 0);
  assert.equal((await f.balance()).stock_quantity, 7);
  assert.equal((await f.pool.query("SELECT setting_value FROM store_settings WHERE setting_key='public_config'")).rows[0].setting_value.marker, 'before');
});

test('failed settings request or invalid stock cannot leave a partially imported catalog', async t => {
  const f = await fixture(t);
  const requestFailure = await f.manager.syncFromPrimary({ fetcher: async url => url.endsWith('/api/products') ? { ok: true, json: async () => ({ products: f.snapshot(7) }) } : { ok: false, status: 503 } });
  assert.equal(requestFailure.ok, false);
  assert.equal(await f.balance(), undefined);
  const invalid = await f.manager.syncFromPrimary({ fetcher: f.fetcher(f.snapshot(3.5)) });
  assert.equal(invalid.ok, false);
  assert.equal(await f.balance(), undefined);
  assert.equal((await f.pool.query("SELECT id FROM products WHERE slug='failover-test'")).rows.length, 0);
});

test('SKU conflict across products rolls back instead of moving existing stock history', async t => {
  const f = await fixture(t);
  await f.manager.syncFromPrimary({ fetcher: f.fetcher(f.snapshot(7)) });
  const original = await f.balance();
  const incoming = f.snapshot(9); incoming[0].slug = 'another-product';
  const result = await f.manager.syncFromPrimary({ fetcher: f.fetcher(incoming) });
  assert.equal(result.ok, false); assert.match(result.error, /sản phẩm khác/);
  assert.deepEqual(await f.balance(), original);
  assert.equal((await f.pool.query("SELECT id FROM products WHERE slug='another-product'")).rows.length, 0);
});
