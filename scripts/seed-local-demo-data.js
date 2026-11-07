'use strict';
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const { randomUUID } = require('crypto');

async function seed() {
  const dbDir = path.join(__dirname, '..', '.local-data');
  const db = new PGlite(dbDir);
  console.log('Opened .local-data for seeding demo data...');

  try {
    // 1. Warehouse
    const wh = (await db.query(`
      INSERT INTO warehouses (name, code, address, active)
      VALUES ('Kho tổng Hà Nội', 'MAIN', 'Đại Mỗ, Nam Từ Liêm, Hà Nội', true)
      ON CONFLICT (code) DO UPDATE SET active = true
      RETURNING id
    `)).rows[0];
    const warehouseId = wh.id;

    // 2. Products and Variants
    const prod1 = (await db.query(`
      INSERT INTO products (slug, name, category, descriptor, description, image_url, image_alt, active, sort_order)
      VALUES ('gaeru-k9', 'GAERU K9', 'audio', 'Mic cài áo nhỏ gọn', 'Micro thu âm không dây cài áo', '/assets/products/k9.webp', 'GAERU K9', true, 10)
      ON CONFLICT (slug) DO UPDATE SET active = true
      RETURNING id
    `)).rows[0];

    const prod2 = (await db.query(`
      INSERT INTO products (slug, name, category, descriptor, description, image_url, image_alt, active, sort_order)
      VALUES ('gaeru-m3', 'GAERU M3', 'audio', 'Micro thu âm cao cấp', 'Micro thu âm kèm dock sạc hiển thị pin', '/assets/products/m3-home-cutout.webp', 'GAERU M3', true, 20)
      ON CONFLICT (slug) DO UPDATE SET active = true
      RETURNING id
    `)).rows[0];

    // Variants
    const v1 = (await db.query(`
      INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
      VALUES ($1, 'K9-TYPEC', 'Chân cắm Type-C', 202300, 50, true)
      ON CONFLICT (sku) DO UPDATE SET stock_quantity = 50
      RETURNING id
    `, [prod1.id])).rows[0];

    const v2 = (await db.query(`
      INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
      VALUES ($1, 'K9-LIGHTNING', 'Chân cắm Lightning', 220000, 30, true)
      ON CONFLICT (sku) DO UPDATE SET stock_quantity = 30
      RETURNING id
    `, [prod1.id])).rows[0];

    const v3 = (await db.query(`
      INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active)
      VALUES ($1, 'M3-PRO-DUAL', 'Bản 2 Micro kèm Hộp sạc', 840000, 25, true)
      ON CONFLICT (sku) DO UPDATE SET stock_quantity = 25
      RETURNING id
    `, [prod2.id])).rows[0];

    // Warehouse stock
    for (const v of [v1, v2, v3]) {
      await db.query(`
        INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
        VALUES ($1, $2, 50)
        ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = 50
      `, [warehouseId, v.id]);
    }

    // 3. Customers
    const cust1 = (await db.query(`
      INSERT INTO customers (full_name, email, phone, password_hash, active)
      VALUES ('Nguyễn Văn An', 'an.nguyen@example.com', '0987654321', 'fakehash', true)
      ON CONFLICT (email) DO UPDATE SET full_name = 'Nguyễn Văn An'
      RETURNING id
    `)).rows[0];

    const cust2 = (await db.query(`
      INSERT INTO customers (full_name, email, phone, password_hash, active)
      VALUES ('Trần Thị Bình', 'binh.tran@example.com', '0912345678', 'fakehash', true)
      ON CONFLICT (email) DO UPDATE SET full_name = 'Trần Thị Bình'
      RETURNING id
    `)).rows[0];

    // Loyalty
    await db.query(`
      INSERT INTO customer_loyalty (customer_id, points_balance, lifetime_earned, tier)
      VALUES ($1, 1500, 1500, 'bronze')
      ON CONFLICT (customer_id) DO NOTHING
    `, [cust1.id]);

    // 4. Orders across all 4 workflows
    // Order 1: Pending
    const o1 = (await db.query(`
      INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd, note)
      VALUES ('GR-20261107-001', $1, 'Nguyễn Văn An', 'an.nguyen@example.com', '0987654321', 'Số 10 Phố Huế, Hàng Bài', 'Hà Nội', 'cod', 'pending', 'pending', 202300, 25000, 227300, 'Giao giờ hành chính')
      ON CONFLICT (order_number) DO NOTHING
      RETURNING id
    `, [cust1.id])).rows[0];

    if (o1) {
      await db.query(`
        INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
        VALUES ($1, $2, 'GAERU K9', 'Chân cắm Type-C', 'K9-TYPEC', 202300, 1, 202300)
      `, [o1.id, v1.id]);
    }

    // Order 2: Processing (Đang xử lý)
    const o2 = (await db.query(`
      INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd, note)
      VALUES ('GR-20261107-002', $1, 'Trần Thị Bình', 'binh.tran@example.com', '0912345678', '123 Lê Lợi, Phường Bến Nghé', 'TP. Hồ Chí Minh', 'bank_transfer', 'paid', 'processing', 840000, 30000, 870000, 'Đã chuyển khoản Vietcombank')
      ON CONFLICT (order_number) DO NOTHING
      RETURNING id
    `, [cust2.id])).rows[0];

    if (o2) {
      await db.query(`
        INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
        VALUES ($1, $2, 'GAERU M3', 'Bản 2 Micro kèm Hộp sạc', 'M3-PRO-DUAL', 840000, 1, 840000)
      `, [o2.id, v3.id]);
      await db.query(`
        INSERT INTO sales_receipts (order_id, amount_vnd, method, reference, note, request_key, request_hash, created_by)
        VALUES ($1, 870000, 'bank_transfer', 'VCB-FT260029', 'Thu đủ qua chuyển khoản ngân hàng', 'req-002', 'hash-002', 'admin')
        ON CONFLICT (request_key) DO NOTHING
      `, [o2.id]);
    }

    // Order 3: Shipped (Đang giao - có vận đơn Viettel Post)
    const o3 = (await db.query(`
      INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd, note)
      VALUES ('GR-20261107-003', $1, 'Lê Hoàng Long', 'long.le@example.com', '0933445566', '45 Trần Phú, Phường 4', 'Đà Nẵng', 'cod', 'pending', 'shipped', 422300, 30000, 452300, 'Kiểm tra hàng trước khi nhận')
      ON CONFLICT (order_number) DO NOTHING
      RETURNING id
    `, [cust1.id])).rows[0];

    if (o3) {
      await db.query(`
        INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
        VALUES ($1, $2, 'GAERU K9', 'Chân cắm Type-C', 'K9-TYPEC', 202300, 1, 202300),
               ($1, $3, 'GAERU K9', 'Chân cắm Lightning', 'K9-LIGHTNING', 220000, 1, 220000)
      `, [o3.id, v1.id, v2.id]);

      await db.query(`
        INSERT INTO carrier_shipments (order_id, carrier_id, tracking_number, carrier_order_id, status, shipping_fee_vnd, cod_amount_vnd, tracking_history)
        VALUES ($1, 'viettel', '156668075672', 'VTP-20261107-003', 'delivering', 28000, 452300, $2)
      `, [o3.id, JSON.stringify([
        { timestamp: new Date(Date.now() - 86400000).toISOString(), status: 'created', description: 'Đã tạo vận đơn trên Viettel Post' },
        { timestamp: new Date(Date.now() - 43200000).toISOString(), status: 'picking', description: 'Bưu tá đã lấy hàng từ kho' },
        { timestamp: new Date().toISOString(), status: 'delivering', description: 'Đang luân chuyển qua bưu cục Đà Nẵng' }
      ])]);
    }

    // Order 4: Completed (Hoàn tất)
    const o4 = (await db.query(`
      INSERT INTO orders (order_number, customer_id, customer_name, email, phone, address, city, payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd)
      VALUES ('GR-20261107-004', $1, 'Phạm Minh Tuấn', 'tuan.pham@example.com', '0977889900', '12 Nguyễn Văn Cừ', 'Cần Thơ', 'cod', 'paid', 'completed', 840000, 35000, 875000)
      ON CONFLICT (order_number) DO NOTHING
      RETURNING id
    `, [cust2.id])).rows[0];

    if (o4) {
      await db.query(`
        INSERT INTO order_items (order_id, variant_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd)
        VALUES ($1, $2, 'GAERU M3', 'Bản 2 Micro kèm Hộp sạc', 'M3-PRO-DUAL', 840000, 1, 840000)
      `, [o4.id, v3.id]);
      await db.query(`
        INSERT INTO sales_receipts (order_id, amount_vnd, method, reference, note, request_key, request_hash, created_by)
        VALUES ($1, 875000, 'cash', 'COD-GR-20261107-004', 'Xác nhận thu tiền COD', 'req-004', 'hash-004', 'admin')
        ON CONFLICT (request_key) DO NOTHING
      `, [o4.id]);
    }

    console.log('Seeded demo products, variants, customers, and 4 orders across all workflows successfully.');
  } finally {
    await db.close();
  }
}

seed().catch(console.error);
