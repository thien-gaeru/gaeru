'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createTestDb } = require('./helpers/pglite-db');
const {
  ACTIVITY_LABELS,
  logOrderActivity,
  getOrderActivities,
  createOrderActivityAdminRouter
} = require('../src/order-activity');

test('Order Activity: Immutable audit trail, Actor type validation, Timeline lookup by UUID & Code, and Admin Notes API', async (t) => {
  const { db, pool } = await createTestDb({ migrate: true });

  t.after(async () => {
    await pool.end().catch(() => {});
  });

  // Create an order for foreign key reference
  const orderRes = await pool.query(
    `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, status, subtotal_vnd, total_vnd, created_at)
     VALUES ('GR-ORD-ACT-001', 'Lê Hoàng Nam', 'nam@test.com', '0912334455', 'Hoàn Kiếm', 'Hà Nội', 'cod', 'pending', 850000, 850000, now())
     RETURNING id, order_number`
  );
  const testOrder = orderRes.rows[0];

  await t.test('1. ACTIVITY_LABELS maps standard order lifecycle actions to Vietnamese descriptions', () => {
    assert.equal(ACTIVITY_LABELS.created, 'Đơn hàng được tạo thành công');
    assert.equal(ACTIVITY_LABELS.paid, 'Đã nhận thanh toán');
    assert.equal(ACTIVITY_LABELS.printed_packing_slip, 'Đã in phiếu giao hàng');
    assert.equal(ACTIVITY_LABELS.scanned_barcode, 'Đã quét mã vạch xuất kho');
    assert.equal(ACTIVITY_LABELS.tracking_assigned, 'Gán mã vận đơn bưu cục');
    assert.equal(ACTIVITY_LABELS.note_added, 'Ghi chú nội bộ nhân viên');
    assert.equal(ACTIVITY_LABELS.rma_opened, 'Khởi tạo phiếu bảo hành RMA');
  });

  await t.test('2. logOrderActivity enforces valid actor_type and safely records timeline event', async () => {
    // Valid actor_type = 'staff'
    const ev1 = await logOrderActivity(pool, {
      orderId: testOrder.id,
      orderNumber: testOrder.order_number,
      actorType: 'staff',
      actorName: 'Kho Đông Anh',
      action: 'scanned_barcode',
      details: { sku: 'K9-PRO', serial: 'SN-001' }
    });
    assert.ok(ev1.id);
    assert.equal(ev1.actor_type, 'staff');
    assert.equal(ev1.actor_name, 'Kho Đông Anh');
    assert.equal(ev1.action, 'scanned_barcode');
    assert.equal(ev1.details.sku, 'K9-PRO');

    // Invalid actor_type falls back to 'system'
    const ev2 = await logOrderActivity(pool, {
      orderId: testOrder.id,
      orderNumber: testOrder.order_number,
      actorType: 'hacker_bot',
      action: 'status_changed',
      details: { step: 'auto_sync' }
    });
    assert.ok(ev2.id);
    assert.equal(ev2.actor_type, 'system');
  });

  await t.test('3. getOrderActivities retrieves timeline sorted by created_at and works by UUID or Order Number', async () => {
    // Add third event: customer note
    await logOrderActivity(pool, {
      orderId: testOrder.id,
      orderNumber: testOrder.order_number,
      actorType: 'customer',
      actorName: 'Lê Hoàng Nam',
      action: 'created',
      details: { note: 'Giao giờ hành chính' }
    });

    // 1. Query by UUID
    const activitiesById = await getOrderActivities(pool, testOrder.id);
    assert.equal(activitiesById.length, 3);
    assert.ok(activitiesById[0].actionLabel);
    assert.ok(activitiesById[0].formattedTime);

    // 2. Query by order_number String
    const activitiesByNumber = await getOrderActivities(pool, testOrder.order_number);
    assert.equal(activitiesByNumber.length, 3);
    assert.equal(activitiesByNumber[0].id, activitiesById[0].id);
  });

  await t.test('4. Admin Router GET /orders/:id/activities and POST /orders/:id/notes with validation', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.admin = { id: 'admin_1', username: 'cskh_mai', permissions: ['orders.read', 'orders.write'] };
      next();
    });
    app.use(createOrderActivityAdminRouter(pool));

    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;

    try {
      // 1. GET /orders/:id/activities
      const getRes = await fetch(`http://127.0.0.1:${port}/orders/${testOrder.id}/activities`);
      assert.equal(getRes.status, 200);
      const getData = await getRes.json();
      assert.ok(Array.isArray(getData.activities));
      assert.equal(getData.activities.length, 3);

      // 2. POST /orders/:id/notes (Valid note)
      const postRes = await fetch(`http://127.0.0.1:${port}/orders/${testOrder.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Khách yêu cầu bọc chống sốc 3 lớp dày.' })
      });
      assert.equal(postRes.status, 200);
      const postJson = await postRes.json();
      assert.equal(postJson.success, true);
      assert.equal(postJson.activity.actor_name, 'cskh_mai');
      assert.equal(postJson.activity.action, 'note_added');
      assert.equal(postJson.activity.details.note, 'Khách yêu cầu bọc chống sốc 3 lớp dày.');

      // 3. POST /orders/:id/notes with empty note rejects with 400
      const emptyRes = await fetch(`http://127.0.0.1:${port}/orders/${testOrder.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: '   ' })
      });
      assert.equal(emptyRes.status, 400);
      const emptyJson = await emptyRes.json();
      assert.equal(emptyJson.error, 'Nội dung ghi chú không được để trống.');
    } finally {
      server.close();
    }
  });

  await t.test('5. Fail-Safe: logOrderActivity catches database errors gracefully and returns null', async () => {
    // Pass invalid UUID that violates foreign key
    const invalidId = '00000000-0000-0000-0000-000000000000';
    const failed = await logOrderActivity(pool, {
      orderId: invalidId,
      action: 'created'
    });
    assert.equal(failed, null);
  });
});
