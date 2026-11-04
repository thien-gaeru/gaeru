'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const { reserveStock } = require('../src/inventory');
const { retryPendingInvoices } = require('../src/misa-einvoice');
const { syncStockToChannel } = require('../src/omnichannel-sync');
const account = require('../src/marketplace-account');
const { seal } = require('../src/totp');
const express = require('express');

async function setupTestDb(t) {
  const db = new PGlite();
  const pool = {
    async query(sql, values) {
      if (!values && sql.includes(';')) {
        const res = await db.exec(sql);
        return res.at(-1) || { rows: [], rowCount: 0 };
      }
      const res = await db.query(sql, values);
      return { rows: res.rows || [], rowCount: res.affectedRows ?? res.rows?.length ?? 0 };
    },
    async connect() {
      return {
        query: (...args) => pool.query(...args),
        release() {}
      };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);
  return pool;
}

test('STT 1: Đơn hàng ⟷ Kho chi nhánh: reserveStock allocates from specified warehouseId', async (t) => {
  const pool = await setupTestDb(t);
  const p = (await pool.query("INSERT INTO products(name,slug,category,active) VALUES('Sync Prod','sync-prod','audio',true) RETURNING id")).rows[0];
  const v = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SKU-WH1','V1',100000,10,true) RETURNING id", [p.id])).rows[0];
  
  const w1 = (await pool.query("INSERT INTO warehouses(code,name,active) VALUES('WH1','Kho Hà Nội',true) RETURNING id")).rows[0];
  const w2 = (await pool.query("INSERT INTO warehouses(code,name,active) VALUES('WH2','Kho HCM',true) RETURNING id")).rows[0];
  
  await pool.query("INSERT INTO warehouse_stock(warehouse_id,variant_id,quantity) VALUES($1,$2,4)", [w1.id, v.id]);
  await pool.query("INSERT INTO warehouse_stock(warehouse_id,variant_id,quantity) VALUES($1,$2,6)", [w2.id, v.id]);

  const order = (await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd)
    VALUES('ORD-WH-001','Tester','t@test.com','0912345678','123 Hang Bai','Hà Nội','cod',100000,100000) RETURNING id`)).rows[0];

  await reserveStock(pool, {
    variantId: v.id,
    quantity: 3,
    orderId: order.id,
    actor: { username: 'admin' },
    warehouseId: w1.id
  });

  const w1After = (await pool.query("SELECT quantity FROM warehouse_stock WHERE warehouse_id=$1 AND variant_id=$2", [w1.id, v.id])).rows[0].quantity;
  const w2After = (await pool.query("SELECT quantity FROM warehouse_stock WHERE warehouse_id=$1 AND variant_id=$2", [w2.id, v.id])).rows[0].quantity;
  assert.equal(w1After, 1);
  assert.equal(w2After, 6);

  const order2 = (await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,subtotal_vnd,total_vnd)
    VALUES('ORD-WH-002','Tester2','t2@test.com','0912345678','123 Hang Bai','Hà Nội','cod',500000,500000) RETURNING id`)).rows[0];

  await assert.rejects(
    reserveStock(pool, {
      variantId: v.id,
      quantity: 5,
      orderId: order2.id,
      actor: { username: 'admin' },
      warehouseId: w1.id
    }),
    /Kho được chọn không đủ tồn khả dụng/
  );
});

test('STT 2: MISA e-Invoice: retryPendingInvoices scans pending completed orders safely', async (t) => {
  const pool = await setupTestDb(t);
  await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd)
    VALUES('ORD-MISA-001','Buyer MISA','misa@test.com','0912345678','Address','Hà Nội','cod','paid','completed',200000,200000)`);
  
  const sweep = await retryPendingInvoices(pool, {}, { limit: 10 });
  assert.equal(sweep.success, true);
  assert.equal(sweep.pendingCount, 1);
  assert.equal(sweep.retriedCount, 1);
  assert.equal(sweep.results[0].skipped, true);
  assert.equal(sweep.results[0].reason, 'misa_protocol_unverified');
});

test('STT 3: RMA Sau bán hàng: approving exchange when product is completely out of stock throws 400/409', async (t) => {
  const pool = await setupTestDb(t);
  const p = (await pool.query("INSERT INTO products(name,slug,category,active) VALUES('RMA Prod','rma-prod','audio',true) RETURNING id")).rows[0];
  const v = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SKU-RMA','V1',200000,0,true) RETURNING id", [p.id])).rows[0];
  
  const order = (await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd)
    VALUES('ORD-RMA-001','Buyer RMA','rma@test.com','0912345678','Address','Hà Nội','cod','paid','completed',200000,200000) RETURNING id`)).rows[0];
  await pool.query(`INSERT INTO order_items(order_id,variant_id,product_name,variant_name,sku,unit_price_vnd,quantity,line_total_vnd)
    VALUES($1,$2,'RMA Prod','V1','SKU-RMA',200000,1,200000)`, [order.id, v.id]);

  const rmaCase = (await pool.query(`INSERT INTO order_after_sales(order_id,kind,return_type,status,reason,version)
    VALUES($1,'return','exchange','requested','Defective product',1) RETURNING id`, [order.id])).rows[0];

  const { afterSalesRouter } = require('../src/order-after-sales');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.admin = { username: 'test-admin', permissions: ['orders.write'] };
    next();
  });
  app.use('/api', afterSalesRouter(pool));
  app.use((err, req, res, next) => res.status(err.status || 400).json({ error: err.message }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/orders/after-sales/${rmaCase.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      status: 'approved',
      resolution: 'Đồng ý đổi sản phẩm mới'
    })
  });

  assert.equal(res.status, 409);
  const data = await res.json();
  assert.match(data.error, /hết tồn kho khả dụng để đổi mới/);
});

test('STT 4: Sàn TMĐT: syncStockToChannel subtracts safetyStockBuffer = 2 to prevent overselling', async (t) => {
  const pool = await setupTestDb(t);
  const p = (await pool.query("INSERT INTO products(slug,name,category,active) VALUES('sync-buff-prod','Buff','audio',true) RETURNING id")).rows[0];
  const v1 = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SKU-BUF-10','V1',100,10,true) RETURNING id", [p.id])).rows[0];
  const v2 = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SKU-BUF-2','V2',100,2,true) RETURNING id", [p.id])).rows[0];
  const v3 = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SKU-BUF-1','V3',100,1,true) RETURNING id", [p.id])).rows[0];

  const creds = { partnerId: '123', shopId: '456', secret: 'key', accessToken: 'token', refreshToken: 'rtoken', tokenExpiresAt: '2099-01-01T00:00:00Z' };
  const verified = {
    ...creds,
    connectionVerifiedAt: new Date().toISOString(),
    verificationFingerprint: account.fingerprint('shopee', creds)
  };
  const cfg = { SESSION_SECRET: 'test-secret-omnichannel-buffer-001' };
  await pool.query(`INSERT INTO store_settings(setting_key,setting_value) VALUES($1,$2)`, [
    'private_admin:shopee',
    JSON.stringify({ version: 1, cipher: seal(JSON.stringify(verified), cfg.SESSION_SECRET) })
  ]);

  await pool.query(`INSERT INTO marketplace_sku_mappings(channel,shop_id,external_sku,variant_id,external_product_id,external_variant_id) VALUES('shopee','456','SKU-BUF-10',$1,'101','0')`, [v1.id]);
  await pool.query(`INSERT INTO marketplace_sku_mappings(channel,shop_id,external_sku,variant_id,external_product_id,external_variant_id) VALUES('shopee','456','SKU-BUF-2',$1,'102','0')`, [v2.id]);
  await pool.query(`INSERT INTO marketplace_sku_mappings(channel,shop_id,external_sku,variant_id,external_product_id,external_variant_id) VALUES('shopee','456','SKU-BUF-1',$1,'103','0')`, [v3.id]);

  const pushedStocks = [];
  const result = await syncStockToChannel(pool, cfg, 'shopee', {
    actor: { username: 'test' },
    fetcher: async (url, options) => {
      const b = JSON.parse(options.body);
      pushedStocks.push({ itemId: b.item_id, normalStock: b.stock_list[0].normal_stock });
      return { ok: true, json: async () => ({}) };
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.updatedCount, 3);
  assert.equal(pushedStocks.find(s => s.itemId === 101)?.normalStock, 8);
  assert.equal(pushedStocks.find(s => s.itemId === 102)?.normalStock, 0);
  assert.equal(pushedStocks.find(s => s.itemId === 103)?.normalStock, 0);
});

test('STT 5: Đổi giá sản phẩm ⟷ Giỏ hàng: /api/customer/cart/check-prices reports price differences', async (t) => {
  const pool = await setupTestDb(t);
  const cust = (await pool.query("INSERT INTO customers(full_name,email,phone,active) VALUES('Cart User','cart@test.com','0912345678',true) RETURNING id")).rows[0];
  const p = (await pool.query("INSERT INTO products(slug,name,category,active) VALUES('cart-prod','Cart Product','audio',true) RETURNING id")).rows[0];
  const v = (await pool.query("INSERT INTO product_variants(product_id,sku,name,price_vnd,stock_quantity,active) VALUES($1,'SKU-PRICE-UPD','Black',150000,10,true) RETURNING id", [p.id])).rows[0];

  // Put item into customer cart
  await pool.query("INSERT INTO customer_cart_items(customer_id,variant_id,quantity) VALUES($1,$2,2)", [cust.id, v.id]);

  const { createCustomerCartRouter } = require('../src/customer-cart');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { customer: { id: cust.id } };
    next();
  });
  app.use('/api/customer/cart', createCustomerCartRouter(pool));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;

  // 1. Client thinks price is 120,000, but in DB it was updated to 150,000
  const checkRes = await fetch(`http://127.0.0.1:${port}/api/customer/cart/check-prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ variantId: v.id, expectedPriceVnd: 120000 }]
    })
  });

  assert.equal(checkRes.status, 200);
  const checkData = await checkRes.json();
  assert.equal(checkData.hasPriceChanges, true);
  assert.equal(checkData.priceChanges.length, 1);
  assert.equal(checkData.priceChanges[0].oldPriceVnd, 120000);
  assert.equal(checkData.priceChanges[0].currentPriceVnd, 150000);
  assert.equal(checkData.priceChanges[0].differenceVnd, 30000);

  // 2. Client checks with matching price 150,000
  const matchRes = await fetch(`http://127.0.0.1:${port}/api/customer/cart/check-prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ variantId: v.id, expectedPriceVnd: 150000 }]
    })
  });
  const matchData = await matchRes.json();
  assert.equal(matchData.hasPriceChanges, false);
  assert.equal(matchData.priceChanges.length, 0);
});

test('STT 2 (Nâng cao): MISA e-Invoice: Exponential Backoff (5p, 15p, 1h) và cảnh báo đỏ chuông quản trị khi thất bại >= 3 lần', async (t) => {
  const pool = await setupTestDb(t);
  const { enqueueInvoiceRetry } = require('../src/misa-einvoice');
  const { notices } = require('../src/admin-notifications');

  const order = (await pool.query(`INSERT INTO orders(order_number,customer_name,email,phone,address,city,payment_method,payment_status,status,subtotal_vnd,total_vnd)
    VALUES('ORD-MISA-QUEUE','Queue Buyer','misa-q@test.com','0912345678','Address','Hà Nội','cod','paid','completed',300000,300000) RETURNING id`)).rows[0];

  // Lần 1: Next attempt sau 5 phút
  await enqueueInvoiceRetry(pool, order.id, 'Mạng MISA ngắt kết nối (500)');
  const row1 = (await pool.query("SELECT attempts, status, next_attempt_at FROM misa_einvoice_retry_queue WHERE order_id = $1", [order.id])).rows[0];
  assert.equal(row1.attempts, 1);
  assert.equal(row1.status, 'pending');

  // Lần 2: Next attempt sau 15 phút
  await enqueueInvoiceRetry(pool, order.id, 'Chữ ký số MISA hết hạn');
  const row2 = (await pool.query("SELECT attempts, status, next_attempt_at FROM misa_einvoice_retry_queue WHERE order_id = $1", [order.id])).rows[0];
  assert.equal(row2.attempts, 2);
  assert.equal(row2.status, 'pending');

  // Chưa có thông báo đỏ vì attempts < 3
  const adminNoticesBefore = await notices(pool, { source: 'owner', permissions: ['orders.read', 'invoice.approve'] }, {});
  assert.equal(adminNoticesBefore.some(n => n.key.includes('misa-invoice-failed')), false);

  // Lần 3: Thất bại lần 3 -> chuyển status = 'failed'
  await enqueueInvoiceRetry(pool, order.id, 'Mã số thuế không hợp lệ');
  const row3 = (await pool.query("SELECT attempts, status, last_error FROM misa_einvoice_retry_queue WHERE order_id = $1", [order.id])).rows[0];
  assert.equal(row3.attempts, 3);
  assert.equal(row3.status, 'failed');
  assert.equal(row3.last_error, 'Mã số thuế không hợp lệ');

  // Sau lần 3: Phải bắn cảnh báo đỏ (level = 'error', target = 'business') trên thanh chuông quản trị
  const adminNoticesAfter = await notices(pool, { source: 'owner', permissions: ['orders.read', 'invoice.approve'] }, {});
  const misaRedNotice = adminNoticesAfter.find(n => n.key.includes('misa-invoice-failed'));
  assert.ok(misaRedNotice, 'Phải có thông báo lỗi phát hành hóa đơn MISA trên thanh chuông quản trị');
  assert.equal(misaRedNotice.level, 'error');
  assert.equal(misaRedNotice.target, 'business');
  assert.match(misaRedNotice.detail, /thất bại sau 3 lần thử/);
});
