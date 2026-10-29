const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

const { migrateDatabase } = require('../src/migrate');
const { submitRmaTicket, lookupRmaTicket, updateRmaStatus } = require('../src/rma-workflow');
const { hashSha256, normalizePhoneE164, dispatchServerCapi } = require('../src/server-capi');
const { getInventoryForecast } = require('../src/inventory-forecast');
const { getRfmCustomerSegmentation, scoreRecency, scoreFrequency, scoreMonetary, determineSegment } = require('../src/rfm-analytics');
const { maskCustomerName, formatRelativeTime, getRecentSocialProof } = require('../src/social-proof');
const { canServeAvif } = require('../src/lib/avif-optimizer');
const { logOrderActivity, getOrderActivities } = require('../src/order-activity');

async function setupTestDb() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise(r => (release = r));
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
      try {
        return await query(sql, values);
      } finally {
        release();
      }
    },
    async connect() {
      const release = await lock();
      return { query, release };
    }
  };
  await migrateDatabase(pool);
  return { db, pool };
}

test('4. E-Warranty RMA Workflow: creates ticket, updates lifecycle and appends audit timeline', async () => {
  const { pool } = await setupTestDb();

  const ticket = await submitRmaTicket(pool, {
    customerName: 'Hoàng Văn Nam',
    customerPhone: '0988776655',
    orderNumber: 'GA-99123',
    productName: 'Gimbal Chống Rung GAERU G1 Ultra',
    serialNumber: 'SN-G1-9921',
    issueType: 'gimbal_axis_jitter',
    issueDescription: 'Gimbal bị rung lắc mạnh trục roll khi gắn iPhone 15 Pro Max.'
  });

  assert.match(ticket.ticket_code, /^RMA-\d{4}-\d{4}$/);
  assert.equal(ticket.status, 'pending');

  // Lookup
  const lookup = await lookupRmaTicket(pool, ticket.ticket_code);
  assert.equal(lookup.length, 1);
  assert.equal(lookup[0].events.length, 1);
  assert.match(lookup[0].events[0].description, /Khách hàng gửi yêu cầu/);

  // Technician inspection & approval
  const updated = await updateRmaStatus(pool, ticket.id, {
    status: 'approved_replacement',
    resolutionType: 'replace_1_1',
    technicianNotes: 'Xác nhận lỗi động cơ trục roll. Đã duyệt đổi mới thân máy nguyên seal 1-1.',
    actorName: 'Kỹ thuật viên Tuấn'
  });

  assert.equal(updated.status, 'approved_replacement');
  assert.equal(updated.resolution_type, 'replace_1_1');

  // Re-lookup verifies event appended
  const lookupAfter = await lookupRmaTicket(pool, '0988776655');
  assert.equal(lookupAfter[0].events.length, 2);
  assert.equal(lookupAfter[0].events[1].status, 'approved_replacement');
});

test('5. Server-Side CAPI: hashes PII fields and formats events for Meta & TikTok', async () => {
  const { pool } = await setupTestDb();

  assert.equal(hashSha256('Test@Gaeru.COM'), hashSha256('test@gaeru.com'));
  assert.equal(normalizePhoneE164('0987654321'), '84987654321');

  const res = await dispatchServerCapi(pool, {}, {
    eventName: 'Purchase',
    orderNumber: 'GA-TEST-CAPI-99',
    amountVnd: 1850000,
    email: 'creator@gaeru.com',
    phone: '0987654321'
  });

  assert.ok(res.eventId);
  assert.equal(res.meta.status, 'simulated');
  assert.equal(res.tiktok.status, 'simulated');

  const logQuery = await pool.query(`SELECT * FROM server_capi_logs WHERE event_id = $1`, [res.eventId]);
  assert.equal(logQuery.rows.length, 2); // 1 meta, 1 tiktok
});

test('6. Inventory Forecasting: calculates velocity, reorder point and urgency flags', async () => {
  const { pool } = await setupTestDb();

  const forecast = await getInventoryForecast(pool);
  assert.ok(forecast.summary);
  assert.ok(Array.isArray(forecast.forecastList));
});

test('7. RFM Analytics: scores Recency, Frequency, Monetary and assigns segments', async () => {
  const { pool } = await setupTestDb();

  assert.equal(scoreRecency(15), 5);
  assert.equal(scoreRecency(45), 4);
  assert.equal(scoreRecency(200), 1);

  assert.equal(scoreFrequency(6), 5);
  assert.equal(scoreFrequency(1), 2);

  assert.equal(scoreMonetary(6000000), 5);
  assert.equal(scoreMonetary(300000), 1);

  assert.equal(determineSegment(5, 5, 5), 'champions');
  assert.equal(determineSegment(4, 2, 3), 'loyal');
  assert.equal(determineSegment(4, 1, 2), 'promising');
  assert.equal(determineSegment(2, 3, 4), 'at_risk');
  assert.equal(determineSegment(1, 1, 1), 'lost');

  const rfm = await getRfmCustomerSegmentation(pool);
  assert.ok(Array.isArray(rfm.summary));
  assert.equal(rfm.summary.length, 5);
});

test('8. Social Proof Toast: masks customer names and formats relative times', async () => {
  const { pool } = await setupTestDb();

  assert.equal(maskCustomerName('Nguyễn Hoàng Nam'), 'Hoàng N.');
  assert.equal(maskCustomerName('Trần Văn Bình'), 'Văn B.');
  assert.equal(maskCustomerName('Thảo'), 'Thảo');

  assert.equal(formatRelativeTime(new Date()), 'Vừa xong');

  const recent = await getRecentSocialProof(pool);
  assert.ok(Array.isArray(recent));
  assert.ok(recent.length > 0);
  assert.ok(recent[0].customerName);
  assert.ok(recent[0].productName);
});

test('9. AVIF Image Optimizer: detects client Accept header for AVIF support', () => {
  assert.equal(canServeAvif('image/avif,image/webp,*/*'), true);
  assert.equal(canServeAvif('image/webp,image/apng,image/*,*/*;q=0.8'), false);
  assert.equal(canServeAvif(null), false);
});

test('10. Order Activity Timeline: logs staff, customer and system actions with audit history', async () => {
  const { pool } = await setupTestDb();

  // Create an order in DB to link activities
  const orderRes = await pool.query(`
    INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status)
    VALUES ('00000000-0000-0000-0000-000000000099', 'GA-ACT-001', 'Nguyễn Văn Minh', 'minh@gaeru.com', '0911223344', '123 Cầu Giấy', 'Hà Nội', 'cod', 450000, 450000, 'pending')
    RETURNING id, order_number
  `);
  const orderId = orderRes.rows[0].id;

  await logOrderActivity(pool, {
    orderId,
    orderNumber: 'GA-ACT-001',
    actorType: 'customer',
    actorName: 'Nguyễn Văn Minh',
    action: 'created',
    details: { paymentMethod: 'cod', totalVnd: 450000 }
  });

  await logOrderActivity(pool, {
    orderId,
    orderNumber: 'GA-ACT-001',
    actorType: 'staff',
    actorName: 'lan_anh_cskh',
    action: 'note_added',
    details: { note: 'Khách dặn bọc thêm lớp chống sốc' }
  });

  await logOrderActivity(pool, {
    orderId,
    orderNumber: 'GA-ACT-001',
    actorType: 'staff',
    actorName: 'kho_ha_noi',
    action: 'scanned_barcode',
    details: { barcode: '8938501234567' }
  });

  const activities = await getOrderActivities(pool, orderId);
  assert.equal(activities.length, 3);
  assert.equal(activities[0].action, 'created');
  assert.equal(activities[1].actor_name, 'lan_anh_cskh');
  assert.equal(activities[2].action, 'scanned_barcode');
  assert.equal(activities[2].actionLabel, 'Đã quét mã vạch xuất kho');
});
