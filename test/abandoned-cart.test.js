const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase } = require('../src/migrate');
const {
  captureSchema,
  captureAbandonedCart,
  recoverCartByToken,
  markCartRecovered,
  optOutAbandonedCart,
  sendRecoveryEmail,
  processAbandonedCartReminders,
  listAbandonedCarts,
  createAbandonedCartApi
} = require('../src/abandoned-cart');

test('Abandoned Cart Recovery Comprehensive Test Suite', async t => {
  const db = await PGlite.create();
  const pool = {
    async query(sql, values) {
      return !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : db.query(sql, values);
    },
    async connect() {
      return { query: pool.query, release() {} };
    }
  };
  t.after(() => db.close());
  await migrateDatabase(pool);

  // Setup test product and variant
  const pResult = await pool.query(
    `INSERT INTO products (name, slug, category, description, active)
     VALUES ('Tai nghe GAERU Pro', 'tai-nghe-gaeru-pro', 'audio', 'Tai nghe cao cấp', true)
     RETURNING id`
  );
  const productId = pResult.rows[0].id;

  const vResult = await pool.query(
    `INSERT INTO product_variants (product_id, name, sku, price_vnd, stock_quantity, active)
     VALUES ($1, 'Bản Đen', 'GAERU-PRO-BLK', 250000, 10, true)
     RETURNING id`,
    [productId]
  );
  const variantId = vResult.rows[0].id;

  // 1. Schema Validation
  await t.test('captureSchema validates valid inputs and rejects invalid ones', () => {
    const valid = captureSchema.safeParse({
      email: 'KhachHang@Gaeru.vn',
      customerName: 'Nguyễn Văn A',
      phone: '0912345678',
      items: [{ variantId, quantity: 2 }],
      recoveryConsent: true
    });
    assert.equal(valid.success, true);
    assert.equal(valid.data.email, 'khachhang@gaeru.vn');

    // Rejects invalid email
    const invalidEmail = captureSchema.safeParse({
      email: 'not-an-email',
      items: [{ variantId, quantity: 1 }]
    });
    assert.equal(invalidEmail.success, false);

    // Rejects empty items
    const emptyItems = captureSchema.safeParse({
      email: 'user@example.com',
      items: []
    });
    assert.equal(emptyItems.success, false);
  });

  // 2. captureAbandonedCart
  await t.test('captureAbandonedCart creates cart with subtotal and schedules stage 1 reminder', async () => {
    const res = await captureAbandonedCart(pool, {
      email: 'buyer1@example.com',
      customerName: 'Trần Thị B',
      phone: '0987654321',
      items: [{ variantId, quantity: 2 }],
      recoveryConsent: true
    });

    assert.ok(res);
    assert.equal(res.cart.email, 'buyer1@example.com');
    assert.equal(res.cart.subtotal_vnd, 500000); // 250,000 * 2
    assert.equal(res.cart.status, 'abandoned');
    assert.equal(res.cart.reminder_count, 0);
    assert.ok(res.recoveryToken);
    assert.ok(res.cart.next_reminder_at);

    // Updating existing abandoned cart with same email
    const updated = await captureAbandonedCart(pool, {
      email: 'buyer1@example.com',
      customerName: 'Trần Thị B Updated',
      phone: '0987654321',
      items: [{ variantId, quantity: 3 }],
      recoveryConsent: true
    });
    assert.equal(updated.cart.id, res.cart.id);
    assert.equal(updated.cart.subtotal_vnd, 750000); // 250,000 * 3
    assert.equal(updated.cart.customer_name, 'Trần Thị B Updated');
  });

  // 3. Consent check with Decree 13/2023 ND-CP & marketing_email_suppressions
  await t.test('captureAbandonedCart respects suppressions list', async () => {
    await pool.query(
      `INSERT INTO marketing_email_suppressions (email) VALUES ('suppressed@example.com')`
    );

    const res = await captureAbandonedCart(pool, {
      email: 'suppressed@example.com',
      items: [{ variantId, quantity: 1 }],
      recoveryConsent: true
    });

    assert.ok(res);
    assert.equal(res.cart.recovery_consent, false);
    assert.equal(res.cart.next_reminder_at, null);
  });

  await t.test('captureAbandonedCart defaults recoveryConsent to false without explicit consent', async () => {
    const res = await captureAbandonedCart(pool, {
      email: 'no-consent@example.com',
      customerName: 'Không Đồng Ý',
      phone: '0987000111',
      items: [{ variantId, quantity: 1 }]
    });
    assert.ok(res);
    assert.equal(res.cart.recovery_consent, false);
    assert.equal(res.cart.next_reminder_at, null);
  });

  // 4. recoverCartByToken
  await t.test('recoverCartByToken transitions cart to recovering and returns details', async () => {
    const captured = await captureAbandonedCart(pool, {
      email: 'buyer2@example.com',
      customerName: 'Lê Văn C',
      items: [{ variantId, quantity: 1 }],
      recoveryConsent: true
    });

    const recovered = await recoverCartByToken(pool, captured.recoveryToken);
    assert.ok(recovered);
    assert.equal(recovered.email, 'buyer2@example.com');
    assert.equal(recovered.status, 'recovering');

    // Unknown token returns null
    const notFound = await recoverCartByToken(pool, 'invalid-token-12345678901234567890');
    assert.equal(notFound, null);
  });

  // 5. markCartRecovered
  await t.test('markCartRecovered marks status to recovered and stops cadence', async () => {
    const captured = await captureAbandonedCart(pool, {
      email: 'buyer3@example.com',
      items: [{ variantId, quantity: 1 }],
      recoveryConsent: true
    });

    // Create a dummy order
    const oRes = await pool.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd, status)
       VALUES ('GA-AC-001', 'Test Customer', 'buyer3@example.com', '0912345678', '123 Main St', 'Hà Nội', 'cod', 250000, 250000, 'pending')
       RETURNING id`
    );
    const orderId = oRes.rows[0].id;

    await markCartRecovered(pool, {
      orderId,
      email: 'buyer3@example.com'
    });

    const check = await pool.query(`SELECT status, order_id, next_reminder_at, recovered_at FROM abandoned_carts WHERE id = $1`, [captured.cart.id]);
    assert.equal(check.rows[0].status, 'recovered');
    assert.equal(check.rows[0].order_id, orderId);
    assert.equal(check.rows[0].next_reminder_at, null);
    assert.ok(check.rows[0].recovered_at);
  });

  // 6. optOutAbandonedCart
  await t.test('optOutAbandonedCart cancels reminders and adds to suppressions', async () => {
    const captured = await captureAbandonedCart(pool, {
      email: 'optout@example.com',
      items: [{ variantId, quantity: 1 }],
      recoveryConsent: true
    });

    const ok = await optOutAbandonedCart(pool, captured.recoveryToken);
    assert.equal(ok, true);

    const check = await pool.query(`SELECT status, recovery_consent, next_reminder_at FROM abandoned_carts WHERE id = $1`, [captured.cart.id]);
    assert.equal(check.rows[0].status, 'opted_out');
    assert.equal(check.rows[0].recovery_consent, false);
    assert.equal(check.rows[0].next_reminder_at, null);

    const supp = await pool.query(`SELECT 1 FROM marketing_email_suppressions WHERE email = 'optout@example.com'`);
    assert.equal(supp.rows.length, 1);
  });

  await t.test('rejected recipient is recorded as failed without increasing successful reminder count', async () => {
    const captured = await captureAbandonedCart(pool, {email:'rejected@example.com',items:[{variantId,quantity:1}],recoveryConsent:true});
    const result = await sendRecoveryEmail(pool,{PUBLIC_BASE_URL:'https://gaeru.com',smtp:{from:'test@example.com'}},captured.cart,{sendMail:async()=>({accepted:[],rejected:['rejected@example.com']})});
    assert.equal(result.success,false);
    const row=(await pool.query('SELECT reminder_count,last_reminded_at,next_reminder_at FROM abandoned_carts WHERE id=$1',[captured.cart.id])).rows[0];
    assert.equal(row.reminder_count,0);assert.equal(row.last_reminded_at,null);assert.ok(row.next_reminder_at);
    const reminder=(await pool.query('SELECT status FROM abandoned_cart_reminders WHERE cart_id=$1',[captured.cart.id])).rows[0];assert.equal(reminder.status,'failed');
  });

  // 7. Email cadence and worker processing
  await t.test('sendRecoveryEmail and processAbandonedCartReminders advance stages', async () => {
    const sentEmails = [];
    const mockTransport = {
      async sendMail(opts) {
        sentEmails.push(opts);
        return { messageId: 'test-msg-id-123' };
      }
    };

    const config = {
      baseUrl: 'https://gaeru.vn',
      smtp: { from: 'GAERU <hotro@gaeru.vn>' }
    };

    // Create a cart ready for reminder
    const captured = await captureAbandonedCart(pool, {
      email: 'cadence@example.com',
      customerName: 'Hoàng D',
      items: [{ variantId, quantity: 1 }],
      recoveryConsent: true
    });

    // Artificially move next_reminder_at to past
    await pool.query(
      `UPDATE abandoned_carts SET next_reminder_at = now() - interval '10 minutes' WHERE id = $1`,
      [captured.cart.id]
    );

    // Stage 1 send
    const processed1 = await processAbandonedCartReminders(pool, config, mockTransport);

    assert.equal(processed1, true);
    assert.equal(sentEmails.length, 1);
    assert.ok(sentEmails[0].subject.includes('giỏ hàng'));
    assert.equal(sentEmails[0].to, 'cadence@example.com');

    // Verify reminder table
    const reminders1 = (await pool.query(`SELECT stage, status FROM abandoned_cart_reminders WHERE cart_id = $1`, [captured.cart.id])).rows;
    assert.equal(reminders1.length, 1);
    assert.equal(reminders1[0].stage, 1);
    assert.equal(reminders1[0].status, 'sent');

    // Verify cart next reminder is scheduled for Stage 2
    const cartState1 = (await pool.query(`SELECT reminder_count, next_reminder_at FROM abandoned_carts WHERE id = $1`, [captured.cart.id])).rows[0];
    assert.equal(cartState1.reminder_count, 1);
    assert.ok(cartState1.next_reminder_at);

    // Fast-forward to Stage 2
    await pool.query(
      `UPDATE abandoned_carts SET next_reminder_at = now() - interval '10 minutes' WHERE id = $1`,
      [captured.cart.id]
    );

    const processed2 = await processAbandonedCartReminders(pool, config, mockTransport);

    assert.equal(processed2, true);
    assert.equal(sentEmails.length, 2);
    assert.ok(sentEmails[1].subject.includes('vẫn đang được giữ'));

    const cartState2 = (await pool.query(`SELECT reminder_count, next_reminder_at FROM abandoned_carts WHERE id = $1`, [captured.cart.id])).rows[0];
    assert.equal(cartState2.reminder_count, 2);

    // Fast-forward to Stage 3
    await pool.query(
      `UPDATE abandoned_carts SET next_reminder_at = now() - interval '10 minutes' WHERE id = $1`,
      [captured.cart.id]
    );

    const processed3 = await processAbandonedCartReminders(pool, config, mockTransport);

    assert.equal(processed3, true);
    assert.equal(sentEmails.length, 3);
    assert.ok(sentEmails[2].subject.includes('Cơ hội cuối'));

    // Cart reminder count reaches max (3) -> next_reminder_at becomes NULL
    const cartState3 = (await pool.query(`SELECT reminder_count, next_reminder_at FROM abandoned_carts WHERE id = $1`, [captured.cart.id])).rows[0];
    assert.equal(cartState3.reminder_count, 3);
    assert.equal(cartState3.next_reminder_at, null);
  });

  // 8. listAbandonedCarts & Metrics
  await t.test('listAbandonedCarts calculates metrics and returns paginated carts', async () => {
    const result = await listAbandonedCarts(pool, { page: 1, pageSize: 10 });
    assert.ok(result.carts.length > 0);
    assert.ok(result.summary.total_count > 0);
    assert.ok(typeof result.summary.recoveryRate === 'number');
    assert.ok(typeof result.summary.recovered_revenue_vnd === 'number');
  });

  // 9. API Endpoints (Admin & Public)
  await t.test('Abandoned Cart API integration endpoints', async () => {
    const sentAdminEmails = [];
    const mockTransport = {
      async sendMail(opts) {
        sentAdminEmails.push(opts);
        return { messageId: 'admin-msg-id-456' };
      }
    };

    const app = express();
    app.use(express.json());
    // Mock admin session with csrf token
    app.use((req, res, next) => {
      req.session = { csrfToken: 'test-csrf-token-12345' };
      req.admin = {
        id: '00000000-0000-4000-8000-000000000001',
        username: 'ceo_admin',
        name: 'CEO Admin',
        role: 'admin',
        permissions: ['marketing.read', 'marketing.write']
      };
      next();
    });

    const config = {
      baseUrl: 'https://gaeru.vn',
      smtp: { from: 'GAERU <hotro@gaeru.vn>' }
    };

    const { admin, publicApi } = createAbandonedCartApi(pool, config, { mailer: mockTransport });
    app.use('/api/admin', admin);
    app.use('/api/abandoned-cart', publicApi);

    const server = app.listen(0);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    t.after(() => server.close());

    // 9.1 Public: Capture cart
    const capRes = await fetch(`${base}/api/abandoned-cart/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'api-capture@example.com',
        customerName: 'API User',
        phone: '0901112222',
        items: [{ variantId, quantity: 1 }],
        recoveryConsent: true
      })
    });
    assert.equal(capRes.status, 201);
    const capData = await capRes.json();
    assert.ok(capData.success);
    assert.ok(capData.cartId);

    // Retrieve token for this cart
    const tokenRow = (await pool.query(`SELECT recovery_token FROM abandoned_carts WHERE id = $1`, [capData.cartId])).rows[0];

    // 9.2 Public: Recover cart
    const recRes = await fetch(`${base}/api/abandoned-cart/recover/${tokenRow.recovery_token}`);
    assert.equal(recRes.status, 200);
    const recData = await recRes.json();
    assert.equal(recData.cart.email, 'api-capture@example.com');
    assert.equal(recData.cart.status, 'recovering');

    // 9.3 Admin: List abandoned carts
    const listRes = await fetch(`${base}/api/admin/marketing/abandoned-carts`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(Array.isArray(listData.carts));
    assert.ok(listData.summary);

    // 9.4 Admin: Manual remind
    const remindRes = await fetch(`${base}/api/admin/marketing/abandoned-carts/${capData.cartId}/remind`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'test-csrf-token-12345'
      }
    });
    assert.equal(remindRes.status, 200);
    assert.equal(sentAdminEmails.length, 1);

    // 9.5 Admin: Cancel reminders
    const cancelRes = await fetch(`${base}/api/admin/marketing/abandoned-carts/${capData.cartId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'test-csrf-token-12345'
      }
    });
    assert.equal(cancelRes.status, 200);
    const cancelCheck = (await pool.query(`SELECT status, next_reminder_at FROM abandoned_carts WHERE id = $1`, [capData.cartId])).rows[0];
    assert.equal(cancelCheck.status, 'expired');
    assert.equal(cancelCheck.next_reminder_at, null);
  });
});
