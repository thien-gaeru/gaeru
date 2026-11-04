'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { createOmnichannelSync } = require('../src/omnichannel-sync');
const { ingestMarketplaceOrder } = require('../src/omnichannel-sync');
const { withTransaction } = require('../src/db');

test('marketplace rejects unsigned callbacks and rolls back incomplete authorized stock deductions', async t => {
  const db = await PGlite.create();
  const pool = { async query(sql, values) { return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values); }, async connect() { return { query: pool.query, release() {} }; } };
  t.after(() => db.close());
  await migrateDatabase(pool);
  const p = (await pool.query("INSERT INTO products(slug,name,category) VALUES('unsigned-callback','Fixture','audio') RETURNING id")).rows[0];
  const v = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'CALLBACK-TARGET','Fixture',100,10,true) RETURNING id", [p.id])).rows[0];
  const app = express();
  app.use(express.json());
  app.use(createOmnichannelSync(pool, {}).publicApi);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const channel of ['shopee', 'tiktok', 'lazada']) {
    for (const status of ['PROCESSING', 'CANCELLED']) {
      const payload = { shop_id: 'untrusted', seller_id: 'untrusted', data: { order_sn: 'UNTRUSTED', order_id: 'UNTRUSTED', status, order_status: status, items: [{ externalSku: 'CALLBACK-TARGET', quantity: 10 }] } };
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/marketplace/' + channel + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-signature': 'invented' }, body: JSON.stringify(payload) });
      assert.equal(response.status, 501, channel + ' ' + status);
    }
  }
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1', [v.id])).rows[0].stock_quantity, 10);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM marketplace_orders')).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM marketplace_sync_events')).rows[0].n, 0);

  const order={externalOrderId:'AUTHORIZED-READ',rawStatus:'PROCESSING',items:[{externalSku:'CALLBACK-TARGET',quantity:2},{externalSku:'UNMAPPED',quantity:1}]};
  const ingest=()=>withTransaction(pool,c=>ingestMarketplaceOrder(c,{channel:'shopee',shopId:'configured-shop',order,autoDeductStock:true,actor:{username:'fixture'}}));
  await assert.rejects(ingest,e=>e.status===409&&e.message.includes('mapping'));
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[v.id])).rows[0].stock_quantity,10,'a later unmapped item rolls back earlier item deductions');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM marketplace_orders')).rows[0].n,0,'an incomplete deduction cannot be recorded as successful');
  order.items=[{externalSku:'CALLBACK-TARGET',quantity:11}];
  await assert.rejects(ingest,e=>e.status===409&&e.message.includes('không đủ'));
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[v.id])).rows[0].stock_quantity,10,'short stock is not silently clamped');
  order.items=[{externalSku:'CALLBACK-TARGET',quantity:2}];
  assert.equal((await ingest()).stock_deducted,true);
  assert.equal((await pool.query('SELECT stock_quantity FROM product_variants WHERE id=$1',[v.id])).rows[0].stock_quantity,8);
});
