const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { createApp } = require('../src/app');
const { migrateDatabase } = require('../src/migrate');

test('reports/overview and finance/summary automatically exclude cancelled and returned orders', { timeout: 60000 }, async t => {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    let release;
    const previous = queue;
    queue = new Promise(r => release = r);
    await previous;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  const pool = {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  await migrateDatabase(pool);

  const app = createApp({
    pool,
    sessionStore: new session.MemoryStore(),
    config: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'financial-exclusions-test-secret-32-chars!',
      ADMIN_USERNAME: 'owner',
      ADMIN_PASSWORD_HASH: bcrypt.hashSync('fixture-password', 4)
    }
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    await new Promise(r => server.close(r));
    await db.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  let cookie = '', csrf = '';
  async function call(path, method = 'GET', body) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        'X-CSRF-Token': csrf,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    const data = r.headers.get('content-type')?.includes('application/json') ? await r.json() : null;
    if (data?.csrfToken) csrf = data.csrfToken;
    return { status: r.status, data };
  }

  await call('/api/csrf');
  await call('/api/auth/login', 'POST', { username: 'owner', password: 'fixture-password' });

  // Create products
  const product = (await pool.query(
    "INSERT INTO products(slug,name,category,descriptor,description,image_url,image_alt,active) VALUES('ex-fixture','Ex Fixture','audio','','','/assets/products/k9.webp','Fixture',true) RETURNING id"
  )).rows[0];
  const variant = (await pool.query(
    "INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'EX-SKU-1','Standard',100000,50,true) RETURNING id",
    [product.id]
  )).rows[0];

  // Insert 3 orders:
  // 1. Normal completed & paid order: 100,000 VND
  const validOrder = (await pool.query(
    "INSERT INTO orders(order_number,customer_name,email,phone,address,city,status,payment_status,payment_method,subtotal_vnd,shipping_fee_vnd,discount_vnd,total_vnd) VALUES('GA-VALID','Valid Customer','valid@example.com','0911111111','123 St','HN','completed','paid','vnpay',100000,0,0,100000) RETURNING id"
  )).rows[0];
  await pool.query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,quantity,unit_price_vnd,line_total_vnd) VALUES($1,$2,'Ex Fixture','Standard','EX-SKU-1',1,100000,100000)", [validOrder.id, variant.id]);

  // 2. Cancelled order: 200,000 VND
  const cancelledOrder = (await pool.query(
    "INSERT INTO orders(order_number,customer_name,email,phone,address,city,status,payment_status,payment_method,subtotal_vnd,shipping_fee_vnd,discount_vnd,total_vnd) VALUES('GA-CANCEL','Cancel Customer','cancel@example.com','0922222222','456 St','HN','cancelled','pending','cod',200000,0,0,200000) RETURNING id"
  )).rows[0];
  await pool.query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,quantity,unit_price_vnd,line_total_vnd) VALUES($1,$2,'Ex Fixture','Standard','EX-SKU-1',2,100000,200000)", [cancelledOrder.id, variant.id]);

  // 3. Returned order: 300,000 VND (paid initially, but return_completed_at is set)
  const returnedOrder = (await pool.query(
    "INSERT INTO orders(order_number,customer_name,email,phone,address,city,status,payment_status,payment_method,subtotal_vnd,shipping_fee_vnd,discount_vnd,total_vnd,return_completed_at) VALUES('GA-RETURN','Return Customer','return@example.com','0933333333','789 St','HN','completed','paid','bank_transfer',300000,0,0,300000,now()) RETURNING id"
  )).rows[0];
  await pool.query("INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,quantity,unit_price_vnd,line_total_vnd) VALUES($1,$2,'Ex Fixture','Standard','EX-SKU-1',3,100000,300000)", [returnedOrder.id, variant.id]);

  // Query /reports/overview
  const reportRes = await call('/api/gaeru_ceo/reports/overview');
  assert.equal(reportRes.status, 200);
  const summary = reportRes.data.summary;

  assert.equal(summary.orderCount, 3);
  assert.equal(summary.orderValueVnd, 100000);
  assert.equal(summary.collectedVnd, 100000);
  assert.equal(summary.completedCount, 1);
  assert.equal(summary.cancelledCount, 1);
  assert.equal(summary.returnedCount, 1);
  assert.equal(summary.returnedValueVnd, 300000);

  // Top products must only have 1 item from valid order
  const topProduct = reportRes.data.topProducts[0];
  assert.equal(topProduct.quantity, 1);
  assert.equal(topProduct.salesVnd, 100000);

  // Finance summary must exclude cancelled and returned
  const finRes = await call('/api/gaeru_ceo/finance/summary');
  assert.equal(finRes.status, 200);
  assert.equal(finRes.data.summary.salesPaidVnd, 100000);
  assert.equal(finRes.data.summary.salesOutstandingVnd, 0);
});
