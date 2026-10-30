'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers/pglite-db');
const { withTransaction } = require('../src/db');
const { CatalogService } = require('../src/domain/catalog/catalog-service');
const { PricingEngine } = require('../src/domain/pricing/pricing-engine');
const { InventoryService } = require('../src/domain/inventory/inventory-service');
const { WorkerManager } = require('../src/workers');
const { enqueueJob } = require('../src/job-queue');

test('Phase B - 6: CatalogService chuẩn hóa update/visibility/delete/restore/purge có kiểm tra edit_version và ghi audit', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const actor = { id: null, username: 'ceo_admin', role: 'owner' };

  // 1. Tạo sản phẩm nháp
  const created = await withTransaction(pool, client =>
    CatalogService.createProduct(client, {
      data: {
        slug: 'gaeru-b6-mic',
        name: 'GAERU B6 Studio',
        category: 'audio',
        descriptor: 'Mic thu âm chuẩn phòng thu',
        description: 'Mô tả chi tiết sản phẩm B6',
        imageUrl: '/assets/products/k9.webp',
        imageAlt: 'GAERU B6',
        sortOrder: 1
      },
      actor
    })
  );
  assert.equal(created.slug, 'gaeru-b6-mic');
  assert.equal(created.active, false);
  assert.equal(created.version, 1);

  // Thêm 1 biến thể active (tồn kho = 0 để lát nữa test purge)
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-B6-01', 'Bản Chuẩn', 600000, 0, true) RETURNING id`,
    [created.id]
  )).rows[0];

  // 2. Cập nhật sản phẩm với sai edit_version -> phải chặn 409
  await assert.rejects(
    async () => {
      await withTransaction(pool, client =>
        CatalogService.updateProduct(client, {
          productId: created.id,
          expectedVersion: 99,
          data: {
            slug: 'gaeru-b6-mic',
            name: 'GAERU B6 Updated',
            category: 'audio',
            descriptor: 'Mic thu âm',
            description: 'Mô tả mới',
            imageUrl: '/assets/products/k9.webp',
            imageAlt: 'GAERU B6',
            active: false,
            sortOrder: 2
          },
          actor
        })
      );
    },
    (err) => err.status === 409
  );

  // Cập nhật đúng version = 1 -> thành công, edit_version tăng lên 2
  const updated = await withTransaction(pool, client =>
    CatalogService.updateProduct(client, {
      productId: created.id,
      expectedVersion: 1,
      data: {
        slug: 'gaeru-b6-mic',
        name: 'GAERU B6 Studio Pro',
        category: 'audio',
        descriptor: 'Mic thu âm',
        description: 'Mô tả mới',
        imageUrl: '/assets/products/k9.webp',
        imageAlt: 'GAERU B6',
        active: false,
        sortOrder: 2
      },
      actor
    })
  );
  assert.equal(updated.name, 'GAERU B6 Studio Pro');
  assert.equal(updated.version, 2);

  // 3. Xuất bản sản phẩm qua setProductVisibility với expectedVersion = 2 -> version tăng lên 3
  const published = await withTransaction(pool, client =>
    CatalogService.setProductVisibility(client, {
      productId: created.id,
      active: true,
      expectedVersion: 2,
      actor
    })
  );
  assert.equal(published.active, true);
  assert.equal(published.version, 3);

  // 4. Xóa mềm (softDeleteProduct) với expectedVersion = 3 -> version tăng lên 4
  await withTransaction(pool, client =>
    CatalogService.softDeleteProduct(client, {
      productId: created.id,
      expectedVersion: 3,
      actor
    })
  );

  // 5. Khôi phục và kích hoạt lại (restoreProduct) với expectedVersion = 4 -> version tăng lên 5
  const restored = await withTransaction(pool, client =>
    CatalogService.restoreProduct(client, {
      productId: created.id,
      expectedVersion: 4,
      activate: true,
      actor
    })
  );
  assert.equal(restored.active, true);

  // 6. Xóa mềm lại (version = 5 -> 6) rồi xóa vĩnh viễn (purgeProduct) với expectedVersion = 6 và confirmation = slug
  await withTransaction(pool, client =>
    CatalogService.softDeleteProduct(client, {
      productId: created.id,
      expectedVersion: 5,
      actor
    })
  );

  // Sai confirmation slug -> 400
  await assert.rejects(
    async () => {
      await withTransaction(pool, client =>
        CatalogService.purgeProduct(client, {
          productId: created.id,
          expectedVersion: 6,
          confirmation: 'wrong-slug',
          actor
        })
      );
    },
    (err) => err.status === 400
  );

  // Đúng confirmation slug & version = 6 -> xóa thành công
  await withTransaction(pool, client =>
    CatalogService.purgeProduct(client, {
      productId: created.id,
      expectedVersion: 6,
      confirmation: 'gaeru-b6-mic',
      actor
    })
  );

  const checkDeleted = await pool.query(`SELECT id FROM products WHERE id = $1`, [created.id]);
  assert.equal(checkDeleted.rows.length, 0, 'Sản phẩm đã được xóa vĩnh viễn');

  // Kiểm tra nhật ký kiểm toán (audit_events) đã ghi nhận đầy đủ các bước
  const audits = await pool.query(
    `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY id ASC`,
    [String(created.id)]
  );
  const actions = audits.rows.map(r => r.action);
  assert.ok(actions.includes('catalog.product.create'));
  assert.ok(actions.includes('catalog.product.update'));
  assert.ok(actions.includes('catalog.product.publish'));
  assert.ok(actions.includes('catalog.product.delete'));
  assert.ok(actions.includes('catalog.product.reactivate'));
  assert.ok(actions.includes('catalog.product.purge'));
});

test('Phase B - 7: PricingEngine là nguồn giá duy nhất cho Catalog, Voucher Quote và Checkout', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const mainProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('b7-main', 'GAERU B7 Main', 'audio', true) RETURNING id`
  )).rows[0];
  const accProd = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('b7-acc', 'GAERU B7 Accessory', 'accessory', true) RETURNING id`
  )).rows[0];

  const mainVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-B7-MAIN', 'Main', 500000, 10, true) RETURNING id`,
    [mainProd.id]
  )).rows[0];
  const accVar = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-B7-ACC', 'Acc', 200000, 10, true) RETURNING id`,
    [accProd.id]
  )).rows[0];

  await pool.query(
    `INSERT INTO product_bundles (main_product_slug, bundle_product_slug, bundle_title, discount_percent, active)
     VALUES ('b7-main', 'b7-acc', 'Combo B7 Giảm 20%', 20, true)`
  );

  // Tạo khách hàng và cấp voucher giảm 10%
  const customer = (await pool.query(
    `INSERT INTO customers (full_name, email, phone, password_hash, active)
     VALUES ('Khách B7', 'b7@example.com', '0907778888', 'hash', true) RETURNING id`
  )).rows[0];
  const voucher = (await pool.query(
    `INSERT INTO marketing_vouchers (code, title, kind, amount, max_discount_vnd, min_spend_vnd, starts_at, ends_at, total_limit, per_customer_limit, public_claim, active)
     VALUES ('B7SALE10', 'Giảm 10%', 'percent', 10, 500000, 300000, now() - interval '1 hour', now() + interval '1 day', 100, 5, true, true)
     RETURNING id`
  )).rows[0];
  await pool.query(
    `INSERT INTO customer_vouchers (customer_id, voucher_id, source) VALUES ($1, $2, 'saved')`,
    [customer.id, voucher.id]
  );

  // 1. quoteCatalogPrices: Phụ kiện giữ nguyên giá 200.000đ
  const catalogPrices = await PricingEngine.quoteCatalogPrices(pool, [
    { id: mainVar.id, priceVnd: 500000 },
    { id: accVar.id, priceVnd: 200000 }
  ]);
  assert.equal(catalogPrices[1].priceVnd, 200000);

  // 2. quoteOrder (dùng chung bởi Voucher Quote API và Checkout):
  // 1 sản phẩm chính (500.000đ) + 3 phụ kiện (1 chiếc giảm 20% = 160.000đ, 2 chiếc giá gốc = 400.000đ -> 560.000đ)
  // Tổng tiền hàng (subtotalVnd) = 1.060.000đ (tuyệt đối không bị lệch 1đ do làm tròn đơn giá!)
  // Voucher giảm 10% của 1.060.000đ = 106.000đ
  const orderQuote = await PricingEngine.quoteOrder(pool, {
    items: [
      { id: mainVar.id, priceVnd: 500000, quantity: 1, productSlug: 'b7-main' },
      { id: accVar.id, priceVnd: 200000, quantity: 3, productSlug: 'b7-acc' }
    ],
    voucherCode: 'B7SALE10',
    customerId: customer.id,
    lockVoucher: false,
    city: 'Hà Nội',
    shippingRates: { 'Hà Nội': 30000 }
  });

  assert.equal(orderQuote.subtotalVnd, 1060000, 'Subtotal của 1 chính + 3 phụ kiện phải chính xác là 1.060.000đ');
  assert.equal(orderQuote.discountVnd, 106000, 'Voucher 10% phải tính trên đúng 1.060.000đ = 106.000đ');
  assert.equal(orderQuote.shippingFeeVnd, 30000);
  assert.equal(orderQuote.totalVnd, 984000);
});

test('Phase B - 8: InventoryService thống nhất luồng phân bổ kho (warehouse allocations) khi giữ và hoàn tồn', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('b8-prod', 'GAERU B8', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-B8-01', 'B8 Standard', 400000, 8, true) RETURNING id`,
    [prod.id]
  )).rows[0];

  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  const auxWh = (await pool.query(`INSERT INTO warehouses (code, name, active) VALUES ('B8-AUX', 'Kho Phụ B8', true) RETURNING id`)).rows[0];

  await pool.query(`DELETE FROM warehouse_stock WHERE variant_id = $1`, [variant.id]);
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 4), ($3, $2, 4)`,
    [mainWh.id, variant.id, auxWh.id]
  );

  const order = (await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status, payment_status)
     VALUES ('ORD-B8-01', 'Khách B8', 'b8@example.com', '0908889999', '123 Cầu Giấy', 'Hà Nội', 'cod', 2400000, 2400000, 'pending', 'pending')
     RETURNING id`
  )).rows[0];

  // Giữ 6 sản phẩm qua InventoryService.reserveOrderStock -> Phải tạo phân bổ order_stock_allocations trên cả 2 kho (4 + 2)
  await withTransaction(pool, client =>
    InventoryService.reserveOrderStock(client, {
      orderId: order.id,
      items: [{ id: variant.id, sku: 'SKU-B8-01', quantity: 6 }],
      actor: { username: 'customer' }
    })
  );

  const allocs = (await pool.query(
    `SELECT warehouse_id, quantity, released_at FROM order_stock_allocations WHERE order_id = $1`,
    [order.id]
  )).rows;
  assert.equal(allocs.length, 2, 'InventoryService.reserveOrderStock phải ghi nhận phân bổ trên cả 2 kho');
  assert.equal(allocs.reduce((s, r) => s + r.quantity, 0), 6);

  // Hoàn kho qua InventoryService.restoreOrderStock -> Phải hoàn đúng từng kho và đánh dấu released_at
  await withTransaction(pool, client =>
    InventoryService.restoreOrderStock(client, {
      orderId: order.id,
      actor: { username: 'admin' }
    })
  );

  const mainAfter = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [mainWh.id, variant.id])).rows[0].quantity;
  const auxAfter = (await pool.query(`SELECT quantity FROM warehouse_stock WHERE warehouse_id = $1 AND variant_id = $2`, [auxWh.id, variant.id])).rows[0].quantity;
  assert.equal(mainAfter, 4);
  assert.equal(auxAfter, 4);
});

test('Phase B - 9: WorkerManager quản lý lock/lease, idempotency cho JobQueue và đăng ký đầy đủ handlers', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  const prod = (await pool.query(
    `INSERT INTO products (slug, name, category, active) VALUES ('b9-prod', 'GAERU B9', 'audio', true) RETURNING id`
  )).rows[0];
  const variant = (await pool.query(
    `INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
     VALUES ($1, 'SKU-B9-JOB', 'B9 Job Variant', 350000, 10, true) RETURNING id`,
    [prod.id]
  )).rows[0];
  const mainWh = (await pool.query(`SELECT id FROM warehouses WHERE code = 'MAIN'`)).rows[0];
  await pool.query(
    `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity) VALUES ($1, $2, 10)
     ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 10`,
    [mainWh.id, variant.id]
  );

  const manager = new WorkerManager();
  t.after(() => manager.stopAll());

  // Chỉ khởi chạy leader lock + jobQueue (bỏ qua 9 timer định kỳ bằng cách mock requireFn nhẹ)
  const noopStopper = () => () => {};
  await manager.startAll(pool, {}, {
    requireFn: (mod) => {
      if (mod === './omnichannel-sync') return require('../src/omnichannel-sync');
      if (mod === './account-retention') return require('../src/account-retention');
      if (mod === './media-storage-audit') return require('../src/media-storage-audit');
      return {
        startChatFileRetentionWorker: noopStopper,
        startTikTokAdsWorker: noopStopper,
        startAIChatWorker: noopStopper,
        startChatCompressionWorker: noopStopper,
        startChatEmailWorker: noopStopper,
        startOrderEmailWorker: noopStopper,
        startWarrantyEmailWorker: noopStopper,
        startEmailWorker: noopStopper,
        startRetentionWorker: noopStopper
      };
    }
  });

  assert.equal(manager.isLeader, true, 'WorkerManager phải lấy được leader lock');
  assert.ok(manager.lastLeaseRenewalAt > 0, 'WorkerManager phải khởi tạo lease timestamp');
  assert.ok(manager.jobQueue, 'JobQueue phải được khởi tạo');

  const registered = manager.jobQueue.getRegisteredWorkers();
  for (const expectedName of [
    'omnichannel.sync',
    'account.retention',
    'media.audit',
    'email.order',
    'email.warranty',
    'email.marketing',
    'health.check'
  ]) {
    assert.ok(registered.includes(expectedName), `Handler "${expectedName}" phải được đăng ký`);
  }

  // Kiểm tra Idempotency khi đẩy job vào hàng đợi cùng idempotencyKey
  const job1 = await enqueueJob(pool, {
    name: 'omnichannel.sync',
    idempotencyKey: 'job-sync-b9-001',
    payload: {
      channel: 'shopee',
      sku: 'SKU-B9-JOB',
      quantityDelta: -2,
      payload: { eventId: 'evt-b9-001' }
    }
  });
  assert.equal(job1.duplicate, false);

  const job2 = await enqueueJob(pool, {
    name: 'omnichannel.sync',
    idempotencyKey: 'job-sync-b9-001',
    payload: {
      channel: 'shopee',
      sku: 'SKU-B9-JOB',
      quantityDelta: -2,
      payload: { eventId: 'evt-b9-001' }
    }
  });
  assert.equal(job2.duplicate, true, 'Enqueue trùng idempotencyKey không được tạo thêm bản ghi job mới');
  assert.equal(job2.id, job1.id);

  // Thực thi job từ hàng đợi
  await manager.jobQueue.processOne();

  const jobRow = (await pool.query(`SELECT status, attempts, last_error FROM system_jobs WHERE id = $1`, [job1.id])).rows[0];
  assert.equal(jobRow.status, 'completed', `Job omnichannel.sync phải được xử lý thành công (actual=${jobRow.status}, attempts=${jobRow.attempts}, err=${jobRow.last_error})`);

  const stockAfter = (await pool.query(`SELECT stock_quantity FROM product_variants WHERE id = $1`, [variant.id])).rows[0].stock_quantity;
  assert.equal(stockAfter, 8, 'Tồn kho phải giảm từ 10 xuống 8 sau khi worker xử lý job');

  await manager.stopAll();
});
