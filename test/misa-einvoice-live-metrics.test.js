'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers/pglite-db');
const { writeRecord } = require('../src/admin-configuration');
const {
  getMisaApiUrl,
  expandItemToExactInvoiceLines,
  buildInvoicePayload,
  probeConnection,
  issueInvoice,
  autoIssueForOrder
} = require('../src/misa-einvoice');

test('MISA eInvoice: Strict tax line math, API connection probe, Payload building, Auto-issuing, and Idempotency', async (t) => {
  const { db, pool } = await createTestDb({ migrate: true });

  const testConfig = {
    NODE_ENV: 'test',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef'
  };

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  await t.test('1. expandItemToExactInvoiceLines: ensures Quantity * UnitPrice === Amount for single, bundle, and remainder lines', () => {
    // 1A. Regular single item
    const single = expandItemToExactInvoiceLines({
      product_name: 'Tai Nghe K9',
      quantity: 2,
      unit_price_vnd: 250000,
      line_total_vnd: 500000
    });
    assert.equal(single.length, 1);
    assert.equal(single[0].Quantity * single[0].UnitPrice, single[0].Amount);

    // 1B. Multi-tier allocations (combo discount)
    const combo = expandItemToExactInvoiceLines({
      product_name: 'Bộ Combo Phụ Kiện',
      sku: 'COMBO-01',
      quantity: 2,
      line_total_vnd: 450000,
      allocations: [
        { quantity: 1, unit_price_vnd: 250000, line_total_vnd: 250000, tier_kind: 'regular' },
        { quantity: 1, unit_price_vnd: 200000, line_total_vnd: 200000, tier_kind: 'bundle_discounted', discount_percent: 20 }
      ]
    });
    assert.equal(combo.length, 2);
    assert.match(combo[1].ItemName, /Ưu đãi Combo -20%/);
    for (const l of combo) {
      assert.equal(l.Quantity * l.UnitPrice, l.Amount);
    }

    // 1C. Indivisible remainder (100k for 3 items)
    const rem = expandItemToExactInvoiceLines({
      product_name: 'Bông Lọc',
      quantity: 3,
      line_total_vnd: 100000
    });
    assert.equal(rem.length, 2);
    const sumTotal = rem.reduce((acc, l) => acc + l.Amount, 0);
    assert.equal(sumTotal, 100000);
    for (const l of rem) {
      assert.equal(l.Quantity * l.UnitPrice, l.Amount);
    }
  });

  await t.test('2. getMisaApiUrl and probeConnection handle environments and credential validation', async () => {
    assert.equal(getMisaApiUrl({ environment: 'production' }), 'https://eshopapi.misa.vn');
    assert.equal(getMisaApiUrl({ environment: 'sandbox' }), 'https://testeshopapi.misa.vn');
    assert.equal(getMisaApiUrl({ apiUrl: 'https://custom-misa.vn/' }), 'https://custom-misa.vn');

    // Missing credentials
    await assert.rejects(
      async () => probeConnection({ appId: 'test' }),
      /Vui lòng cấu hình App ID, Store ID và Khóa bí mật/
    );

    // Successful probe with mock fetcher
    const mockFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ Success: true })
    });
    const probe = await probeConnection({
      appId: 'APP1',
      secret: 'SEC1',
      storeId: 'STORE1'
    }, { fetcher: mockFetcher });
    assert.equal(probe.verified, true);
  });

  await t.test('3. buildInvoicePayload creates Decree 123 payload with shipping line and accurate total', () => {
    const order = {
      id: 'ord_123',
      order_number: 'GR-TEST-001',
      customer_name: 'Nguyễn Văn A',
      email: 'a@gaeru.com',
      phone: '0901234567',
      payment_method: 'cod',
      shipping_fee_vnd: 25000,
      total_vnd: 525000
    };
    const items = [
      { product_name: 'Bàn Phím Cơ', quantity: 1, unit_price_vnd: 500000, line_total_vnd: 500000 }
    ];
    const payload = buildInvoicePayload(order, items, { series: 'C26TGA', templateCode: '1/001' });

    assert.equal(payload.RefNo, 'GR-TEST-001');
    assert.equal(payload.PaymentMethod, 'TM'); // COD -> TM
    assert.equal(payload.Items.length, 2); // 1 item + 1 shipping
    assert.equal(payload.Items[1].ItemCode, 'SHIPPING');
    assert.equal(payload.TotalAmount, 525000);
  });

  await t.test('4. autoIssueForOrder: publishes invoice, persists in DB, protects against duplication, and logs audit', async () => {
    // Configure MISA in admin_configuration
    await writeRecord(pool, testConfig, 'misa', {
      enabled: true,
      autoIssue: true,
      appId: 'MISA_TEST_APP',
      secret: 'MISA_TEST_SEC',
      storeId: 'MISA_TEST_STORE',
      taxCode: '0101234567',
      templateCode: '1/001',
      series: 'C26TGA'
    }, 0, { username: 'admin', role: 'owner' });

    // Seed order in DB
    const orderRes = (await pool.query(
      `INSERT INTO orders (
         order_number, customer_name, email, phone, address, city,
         payment_method, payment_status, status, subtotal_vnd, shipping_fee_vnd, total_vnd
       ) VALUES (
         'GR-MISA-AUTO-01', 'Lê Thuỳ Linh', 'linh@test.com', '0988776655',
         'Cầu Giấy', 'Hà Nội', 'cod', 'paid', 'completed', 750000, 30000, 780000
       ) RETURNING id`
    )).rows[0];

    await pool.query(
      `INSERT INTO order_items (
         order_id, product_name, variant_name, sku, unit_price_vnd, quantity, line_total_vnd
       ) VALUES ($1, 'Chuột Gaming M1', 'Đen', 'M1-BLK', 750000, 1, 750000)`,
      [orderRes.id]
    );

    let callCount = 0;
    const mockFetcher = async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          InvoiceNo: '0001234',
          InvoiceSeries: 'C26TGA',
          TemplateCode: '1/001',
          TransactionID: 'TX-TEST-UUID-1234',
          ViewUrl: 'https://meinvoice.vn/view/TX-TEST-UUID-1234'
        })
      };
    };

    // First issue call
    const res1 = await autoIssueForOrder(pool, testConfig, orderRes.id, { fetcher: mockFetcher });
    assert.equal(res1.success, true);
    assert.equal(res1.einvoice.invoice_number, '0001234');
    assert.equal(res1.einvoice.transaction_id, 'TX-TEST-UUID-1234');
    assert.equal(callCount, 1);

    // Second issue call on same order -> must be skipped idempotently
    const res2 = await autoIssueForOrder(pool, testConfig, orderRes.id, { fetcher: mockFetcher });
    assert.equal(res2.skipped, true);
    assert.equal(res2.reason, 'already_issued');
    assert.equal(callCount, 1); // No new network call!

    // Verify audit record in audit_events
    const auditRes = await pool.query(
      `SELECT * FROM audit_events WHERE action = 'einvoice.issue' AND entity_id = $1`,
      [orderRes.id]
    );
    assert.equal(auditRes.rows.length, 1);
    assert.equal(auditRes.rows[0].metadata.invoiceNumber, '0001234');
  });

  await t.test('5. autoIssueForOrder skips unpaid or uncompleted orders safely', async () => {
    const pendingOrder = (await pool.query(
      `INSERT INTO orders (
         order_number, customer_name, email, phone, address, city,
         payment_method, payment_status, status, subtotal_vnd, total_vnd
       ) VALUES (
         'GR-PENDING-01', 'Khách Chờ', 'pending@test.com', '0900000001',
         'HN', 'HN', 'cod', 'pending', 'pending', 300000, 300000
       ) RETURNING id`
    )).rows[0];

    const res = await autoIssueForOrder(pool, testConfig, pendingOrder.id);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, 'order_not_completed_or_paid');
  });
});
