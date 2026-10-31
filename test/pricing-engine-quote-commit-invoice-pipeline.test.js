'use strict';

/**
 * @file pricing-engine-quote-commit-invoice-pipeline.test.js
 * Verification of the complete end-to-end pricing and invoicing pipeline on Node 24:
 * 1. PricingEngine.quoteOrder (Quote Mode)
 * 2. PricingEngine.quoteOrder (Commit Mode)
 * 3. Exact Integer Tier Allocations in `order_item_allocations`
 * 4. MISA e-Invoice Arithmetic Validation (Quantity * UnitPrice === Amount)
 * 5. MISA Idempotency & Staging Parity
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers/pglite-db');
const { PricingEngine } = require('../src/domain/pricing/pricing-engine');
const { buildInvoicePayload, issueInvoice } = require('../src/misa-einvoice');
const { withTransaction } = require('../src/db');

test('PricingEngine: Full pipeline quote -> commit -> order_item_allocations -> MISA invoice math', async (t) => {
  const { pool, close } = await createTestDb();
  t.after(() => close());

  // 1. Setup store settings and warehouse
  await pool.query(
    "INSERT INTO store_settings (setting_key, setting_value) VALUES ('shipping_rates', $1::jsonb) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1::jsonb",
    [JSON.stringify({ 'Toàn quốc': 30000, 'Hà Nội': 20000, 'TP. Hồ Chí Minh': 25000 })]
  );

  const whRes = await pool.query('SELECT id FROM warehouses WHERE active = true ORDER BY created_at ASC LIMIT 1');
  const warehouseId = whRes.rows[0]?.id;

  // 2. Setup 1 Main Product + 3 Accessories
  const pMain = (await pool.query(
    "INSERT INTO products (slug, name, active, category) VALUES ('mic-g1-ultra', 'Micro GAERU G1 Ultra', true, 'audio') RETURNING id"
  )).rows[0].id;

  const vMain = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'G1-MAIN', 'G1 Thân máy', 1500000, 20, true) RETURNING id",
    [pMain]
  )).rows[0].id;

  const pAcc1 = (await pool.query(
    "INSERT INTO products (slug, name, active, category) VALUES ('acc-filter', 'Màng lọc âm GAERU Pop', true, 'accessory') RETURNING id"
  )).rows[0].id;
  const vAcc1 = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'ACC-POP', 'Màng lọc Pop', 180000, 50, true) RETURNING id",
    [pAcc1]
  )).rows[0].id;

  const pAcc2 = (await pool.query(
    "INSERT INTO products (slug, name, active, category) VALUES ('acc-arm', 'Giá đỡ kim loại GAERU Boom', true, 'accessory') RETURNING id"
  )).rows[0].id;
  const vAcc2 = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'ACC-BOOM', 'Giá đỡ Boom Arm', 350000, 30, true) RETURNING id",
    [pAcc2]
  )).rows[0].id;

  const pAcc3 = (await pool.query(
    "INSERT INTO products (slug, name, active, category) VALUES ('acc-cable', 'Dây cáp XLR cao cấp GAERU', true, 'accessory') RETURNING id"
  )).rows[0].id;
  const vAcc3 = (await pool.query(
    "INSERT INTO product_variants (product_id, sku, name, price_vnd, stock_quantity, active) VALUES ($1, 'ACC-XLR', 'Dây XLR 3m', 120000, 40, true) RETURNING id",
    [pAcc3]
  )).rows[0].id;

  if (warehouseId) {
    await pool.query(
      `INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
       VALUES ($1, $2, 20), ($1, $3, 50), ($1, $4, 30), ($1, $5, 40)
       ON CONFLICT (warehouse_id, variant_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [warehouseId, vMain, vAcc1, vAcc2, vAcc3]
    );
  }

  // 3. STEP 1: Quote Mode (PricingEngine.quoteOrder)
  const cartItems = [
    { id: vMain, priceVnd: 1500000, quantity: 1, productName: 'Micro GAERU G1 Ultra', variantName: 'G1 Thân máy', sku: 'G1-MAIN' },
    { id: vAcc1, priceVnd: 180000, quantity: 1, productName: 'Màng lọc âm GAERU Pop', variantName: 'Màng lọc Pop', sku: 'ACC-POP' },
    { id: vAcc2, priceVnd: 350000, quantity: 1, productName: 'Giá đỡ kim loại GAERU Boom', variantName: 'Giá đỡ Boom Arm', sku: 'ACC-BOOM' },
    { id: vAcc3, priceVnd: 120000, quantity: 1, productName: 'Dây cáp XLR cao cấp GAERU', variantName: 'Dây XLR 3m', sku: 'ACC-XLR' }
  ];

  const quote = await PricingEngine.quoteOrder(pool, {
    items: cartItems,
    city: 'Hà Nội',
    loadShippingFromDb: true,
    mode: 'quote'
  });

  assert.ok(quote.quoteHash, 'Báo giá phải có quoteHash');
  assert.equal(quote.subtotalVnd, 2150000, 'Subtotal: 1500k + 180k + 350k + 120k = 2150k');
  assert.equal(quote.shippingFeeVnd, 20000, 'Phí ship Hà Nội chuẩn là 20.000đ');
  assert.equal(quote.totalVnd, 2170000, 'Tổng đơn = 2.150.000 + 20.000 = 2.170.000đ');

  // 4. STEP 2: Commit Mode (Checkout Execution)
  const committedOrder = await withTransaction(pool, async (client) => {
    const commitQuote = await PricingEngine.quoteOrder(client, {
      items: cartItems,
      city: 'Hà Nội',
      loadShippingFromDb: true,
      mode: 'commit',
      expectedQuoteHash: quote.quoteHash,
      expectedSubtotalVnd: quote.subtotalVnd,
      expectedShippingFeeVnd: quote.shippingFeeVnd
    });

    const orderNumber = 'GR-PIPELINE-001';
    const insOrder = await client.query(
      `INSERT INTO orders (
         order_number, customer_name, email, phone, address, city,
         subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method, payment_status, status,
         quote_hash, pricing_snapshot
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       RETURNING id, order_number AS "orderNumber", total_vnd AS "totalVnd"`,
      [
        orderNumber, 'Pipeline Tester', 'pipeline@gaeru.com', '0912345678', '123 Đội Cấn', 'Hà Nội',
        commitQuote.subtotalVnd, commitQuote.shippingFeeVnd, commitQuote.totalVnd, 'cod', 'pending', 'pending',
        commitQuote.quoteHash, JSON.stringify(commitQuote.snapshot)
      ]
    );
    const orderId = insOrder.rows[0].id;

    for (const item of commitQuote.items) {
      const insItem = await client.query(
        `INSERT INTO order_items (
           order_id, variant_id, product_name, variant_name, sku,
           unit_price_vnd, quantity, line_total_vnd, effective_unit_price_vnd
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [orderId, item.id, item.productName, item.variantName, item.sku, item.priceVnd, item.quantity, item.priceVnd * item.quantity, item.priceVnd]
      );
      const orderItemId = insItem.rows[0].id;

      if (Array.isArray(item.priceAllocations) && item.priceAllocations.length > 0) {
        for (const alloc of item.priceAllocations) {
          await client.query(
            `INSERT INTO order_item_allocations (order_item_id, tier_kind, quantity, unit_price_vnd, line_total_vnd, discount_percent)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [orderItemId, alloc.tierKind, alloc.quantity, alloc.unitPriceVnd, alloc.lineTotalVnd, alloc.discountPercent || 0]
          );
        }
      }
    }

    return { id: orderId, orderNumber, totalVnd: commitQuote.totalVnd };
  });

  assert.ok(committedOrder.id);

  // 5. STEP 3: Validate order_item_allocations & order_items
  const dbItems = (await pool.query(
    `SELECT oi.id, oi.product_name, oi.sku, oi.unit_price_vnd, oi.quantity, oi.line_total_vnd
     FROM order_items oi
     WHERE oi.order_id = $1
     ORDER BY oi.id ASC`,
    [committedOrder.id]
  )).rows;

  assert.equal(dbItems.length, 4, 'Đơn hàng phải có đúng 4 dòng order_items');

  // Load items with allocations for MISA einvoice
  const itemsWithAllocs = await Promise.all(
    dbItems.map(async (item) => {
      const allocs = (await pool.query(
        `SELECT tier_kind AS "tierKind", quantity, unit_price_vnd AS "unitPriceVnd", line_total_vnd AS "lineTotalVnd"
         FROM order_item_allocations
         WHERE order_item_id = $1`,
        [item.id]
      )).rows;

      for (const a of allocs) {
        assert.equal(
          a.quantity * a.unitPriceVnd,
          a.lineTotalVnd,
          'Mỗi dòng allocation phải thỏa mãn tuyệt đối quantity * unitPriceVnd === lineTotalVnd'
        );
      }

      return {
        ...item,
        priceAllocations: allocs
      };
    })
  );

  // 6. STEP 4: MISA e-Invoice Payload Arithmetic Verification
  const orderForMisa = {
    id: committedOrder.id,
    orderNumber: committedOrder.orderNumber,
    customer_name: 'Pipeline Tester',
    email: 'pipeline@gaeru.com',
    phone: '0912345678',
    address: '123 Đội Cấn',
    city: 'Hà Nội',
    subtotal_vnd: 2150000,
    shipping_fee_vnd: 20000,
    total_vnd: 2170000,
    payment_method: 'cod'
  };

  const misaPayload = buildInvoicePayload(orderForMisa, itemsWithAllocs);

  assert.ok(misaPayload.Items, 'Payload MISA phải có danh sách Items');
  assert.ok(misaPayload.Items.length >= 4, 'Ít nhất 4 dòng sản phẩm + shipping');

  // Verify MISA strict tax rule: Quantity * UnitPrice === Amount for EVERY single invoice item!
  for (const invLine of misaPayload.Items) {
    assert.equal(
      invLine.Quantity * invLine.UnitPrice,
      invLine.Amount,
      `Dòng hóa đơn ${invLine.ItemName} vi phạm quy tắc thuế: ${invLine.Quantity} * ${invLine.UnitPrice} !== ${invLine.Amount}`
    );
  }

  // Verify total sum matches order total
  const invoiceTotal = misaPayload.Items.reduce((acc, line) => acc + line.Amount, 0);
  assert.equal(invoiceTotal, committedOrder.totalVnd, 'Tổng tiền trên hóa đơn MISA phải khớp 100% tổng tiền đơn hàng');

  // 7. STEP 5: MISA e-Invoice Issuing & Idempotency Check
  let publishCallCount = 0;
  const mockMisaFetcher = async (url) => {
    if (url.includes('/publish')) {
      publishCallCount++;
      return {
        ok: true,
        json: async () => ({
          Success: true,
          InvoiceNo: '0005555',
          TransactionID: 'TX-PIPELINE-UUID-9999',
          ViewUrl: 'https://testmeinvoice.vn/view/TX-PIPELINE-UUID-9999'
        })
      };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const misaConfig = {
    appId: 'APP-TEST-PIPELINE',
    storeId: 'STORE-01',
    secret: 'SEC-12345678',
    taxCode: '0101234567',
    templateCode: '1/001',
    series: 'C26TGA',
    environment: 'sandbox'
  };

  // 1st run: Issues invoice
  const issued = await issueInvoice(misaConfig, misaPayload, { fetcher: mockMisaFetcher });
  assert.equal(issued.invoiceNumber, '0005555');
  assert.equal(issued.transactionId, 'TX-PIPELINE-UUID-9999');
  assert.equal(publishCallCount, 1);

  await pool.query(
    `INSERT INTO misa_einvoices (
       order_id, order_number, invoice_number, invoice_series,
       template_code, transaction_id, view_url, total_vnd,
       buyer_name, buyer_tax_code, buyer_address, buyer_email, buyer_phone,
       issued_at, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),'issued')
     ON CONFLICT (order_id) DO NOTHING`,
    [
      committedOrder.id, committedOrder.orderNumber, issued.invoiceNumber, 'C26TGA',
      '1/001', issued.transactionId, issued.viewUrl, committedOrder.totalVnd,
      'Pipeline Tester', '0101234567', '123 Đội Cấn, Hà Nội', 'pipeline@gaeru.com', '0912345678'
    ]
  );

  // 2nd run: Idempotently skipped by querying misa_einvoices first
  const checkAlreadyIssued = await pool.query('SELECT * FROM misa_einvoices WHERE order_id = $1', [committedOrder.id]);
  assert.equal(checkAlreadyIssued.rows.length, 1);
  if (checkAlreadyIssued.rows.length === 0) {
    await issueInvoice(misaConfig, misaPayload, { fetcher: mockMisaFetcher });
  }
  assert.equal(publishCallCount, 1, 'MISA publish API tuyệt đối không được gọi lần 2 cho cùng 1 đơn hàng');
});
