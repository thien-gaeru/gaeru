'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');

const {
  processOrderCompletionLoyalty,
  getLoyaltyProfile,
  addLoyaltyPoints,
  calculateTier,
  TIERS
} = require('../src/loyalty-api');
const { attachAdminOrderAndSettingsRoutes } = require('../src/store/admin-orders-settings-routes');

async function createTestDatabase() {
  const db = new PGlite();
  db.connect = async () => ({
    query: (q, p) => db.query(q, p),
    release: () => {}
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS store_settings (
      setting_key text PRIMARY KEY,
      setting_value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name text NOT NULL,
      email text UNIQUE NOT NULL,
      phone text NOT NULL DEFAULT '',
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number text NOT NULL UNIQUE,
      customer_id uuid REFERENCES customers(id),
      customer_name text NOT NULL,
      email text NOT NULL,
      phone text NOT NULL DEFAULT '',
      address text NOT NULL DEFAULT '',
      city text NOT NULL DEFAULT '',
      payment_method text NOT NULL DEFAULT 'cod',
      payment_status text NOT NULL DEFAULT 'pending',
      status text NOT NULL DEFAULT 'pending',
      subtotal_vnd integer NOT NULL DEFAULT 0,
      shipping_fee_vnd integer DEFAULT 0,
      total_vnd integer DEFAULT 0,
      management_version integer NOT NULL DEFAULT 1,
      return_completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS customer_loyalty (
      customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      points bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
      lifetime_points bigint NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
      tier text NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'silver', 'gold', 'diamond')),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
      points_change bigint NOT NULL,
      balance_after bigint NOT NULL DEFAULT 0,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor jsonb,
      action text NOT NULL,
      entity_type text,
      entity_id text,
      before jsonb,
      after jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  return db;
}

test('Loyalty Auto-Credit on Order Completion: awards points, enforces idempotency and resolves email fallback', async () => {
  const db = await createTestDatabase();

  try {
    // 1. Registered customer placing completed order of 1,000,000 VND (1% = 10,000 points)
    const custRes = await db.query(
      `INSERT INTO customers (full_name, email) VALUES ('Nguyen Van A', 'nguyenvana@example.com') RETURNING id`
    );
    const custId = custRes.rows[0].id;

    const ordRes = await db.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, status, payment_status, total_vnd)
       VALUES ('ORD-LOYALTY-001', $1, 'Nguyen Van A', 'nguyenvana@example.com', 'completed', 'paid', 1000000)
       RETURNING id`,
      [custId]
    );
    const ordId = ordRes.rows[0].id;

    const res1 = await processOrderCompletionLoyalty(db, ordId);
    assert.equal(res1.pointsAdded, 10000);
    assert.equal(res1.balance, 10000);
    assert.equal(res1.tier, 'diamond'); // 10,000 reaches diamond tier

    // Profile check
    const profile = await getLoyaltyProfile(db, custId);
    assert.equal(profile.points, 10000);
    assert.equal(profile.lifetimePoints, 10000);
    assert.equal(profile.tier, 'diamond');
    assert.equal(profile.history.length, 1);
    assert.equal(profile.history[0].orderId, ordId);
    assert.equal(profile.history[0].pointsChange, 10000);
    assert.match(profile.history[0].reason, /ORD-LOYALTY-001/);

    // 2. Idempotency: re-running does NOT double credit points
    const res2 = await processOrderCompletionLoyalty(db, ordId);
    assert.equal(res2.alreadyAwarded, true);
    assert.equal(res2.pointsAdded, 0);

    const profileAfterDup = await getLoyaltyProfile(db, custId);
    assert.equal(profileAfterDup.points, 10000);

    // 3. Email fallback: order created with customer_id = null but email matches registered customer
    const ordGuestRes = await db.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, status, payment_status, total_vnd)
       VALUES ('ORD-LOYALTY-002', null, 'Nguyen Van A', 'nguyenvana@example.com', 'completed', 'paid', 500000)
       RETURNING id`
    );
    const ordGuestId = ordGuestRes.rows[0].id;

    // Diamond tier (1.15x multiplier): 500k spend -> 5,000 base * 1.15 = 5,750 points
    const resGuest = await processOrderCompletionLoyalty(db, ordGuestId);
    assert.equal(resGuest.pointsAdded, 5750);
    assert.equal(resGuest.balance, 15750);

    // Verify order was linked with customer_id
    const linkedOrder = await db.query(`SELECT customer_id FROM orders WHERE id = $1`, [ordGuestId]);
    assert.equal(linkedOrder.rows[0].customer_id, custId);

    // 4. Incomplete order (pending/processing) must be skipped
    const ordPendingRes = await db.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, status, payment_status, total_vnd)
       VALUES ('ORD-LOYALTY-003', $1, 'Nguyen Van A', 'nguyenvana@example.com', 'pending', 'pending', 200000)
       RETURNING id`,
      [custId]
    );
    const skipPending = await processOrderCompletionLoyalty(db, ordPendingRes.rows[0].id);
    assert.equal(skipPending.skipped, true);
    assert.equal(skipPending.reason, 'order_not_completed');

    // 5. Unregistered guest: email not registered in customers table
    const ordUnknownGuest = await db.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, status, payment_status, total_vnd)
       VALUES ('ORD-LOYALTY-004', null, 'Guest User', 'unregistered-guest@example.com', 'completed', 'paid', 200000)
       RETURNING id`
    );
    const skipUnknown = await processOrderCompletionLoyalty(db, ordUnknownGuest.rows[0].id);
    assert.equal(skipUnknown.skipped, true);
    assert.equal(skipUnknown.reason, 'no_customer');
  } finally {
    await db.close();
  }
});

test('Admin Order Transition: PATCH /gaeru_ceo/orders/:id to completed automatically triggers loyalty point accumulation', async () => {
  const db = await createTestDatabase();

  const custRes = await db.query(
    `INSERT INTO customers (full_name, email) VALUES ('Tran Van B', 'tranvanb@example.com') RETURNING id`
  );
  const custId = custRes.rows[0].id;

  const ordRes = await db.query(
    `INSERT INTO orders (order_number, customer_id, customer_name, email, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
     VALUES ('ORD-STATUS-TEST', $1, 'Tran Van B', 'tranvanb@example.com', 'shipped', 'paid', 500000, 20000, 520000)
     RETURNING id`,
    [custId]
  );
  const ordId = ordRes.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.admin = { id: 'admin-1', role: 'owner', name: 'Owner Admin', permissions: ['orders.write', 'payments.write'] };
    req.session = { csrfToken: 'test-token', admin: req.admin };
    next();
  });

  const router = express.Router();
  attachAdminOrderAndSettingsRoutes(router, db, {
    audit: async () => {},
    config: {}
  });
  app.use('/api', router);

  const server = app.listen(0);
  const port = server.address().port;

  try {
    const patchRes = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/orders/${ordId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'test-token'
      },
      body: JSON.stringify({ status: 'completed' })
    });

    assert.equal(patchRes.status, 200);
    const data = await patchRes.json();
    assert.equal(data.order.status, 'completed');

    // Verify loyalty points were credited automatically!
    const loyaltyRes = await db.query(
      `SELECT points, lifetime_points AS "lifetimePoints", tier FROM customer_loyalty WHERE customer_id = $1`,
      [custId]
    );
    assert.equal(loyaltyRes.rows.length, 1);
    // 520,000 VND * 1% = 5,200 points -> Gold tier
    assert.equal(Number(loyaltyRes.rows[0].points), 5200);
    assert.equal(loyaltyRes.rows[0].tier, 'gold');

    // Verify transaction recorded
    const txRes = await db.query(`SELECT * FROM loyalty_transactions WHERE order_id = $1`, [ordId]);
    assert.equal(txRes.rows.length, 1);
    assert.equal(Number(txRes.rows[0].points_change), 5200);
    assert.match(txRes.rows[0].reason, /ORD-STATUS-TEST/);

    // Re-saving order or updating other fields must NOT double-credit points
    const patchRes2 = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/orders/${ordId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'test-token'
      },
      body: JSON.stringify({ status: 'completed' })
    });
    assert.equal(patchRes2.status, 200);

    const loyaltyResAfter = await db.query(
      `SELECT points FROM customer_loyalty WHERE customer_id = $1`,
      [custId]
    );
    assert.equal(Number(loyaltyResAfter.rows[0].points), 5200);

    // =========================================================================
    // 3. Test Bulk Status Update (POST /gaeru_ceo/orders/bulk action: 'complete')
    // =========================================================================
    const ordBulk1 = await db.query(
      `INSERT INTO orders (order_number, customer_id, customer_name, email, status, payment_status, subtotal_vnd, shipping_fee_vnd, total_vnd)
       VALUES ('ORD-BULK-001', $1, 'Tran Van B', 'tranvanb@example.com', 'shipped', 'paid', 300000, 20000, 320000)
       RETURNING id`,
      [custId]
    );
    const ordBulkId = ordBulk1.rows[0].id;

    const bulkRes = await fetch(`http://127.0.0.1:${port}/api/gaeru_ceo/orders/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'test-token'
      },
      body: JSON.stringify({
        action: 'complete',
        confirmReceived: true,
        orders: [
          {
            id: ordBulkId,
            expectedStatus: 'shipped',
            expectedPaymentStatus: 'paid',
            expectedTotalVnd: 320000
          }
        ]
      })
    });

    assert.equal(bulkRes.status, 200);
    const bulkData = await bulkRes.json();
    assert.equal(bulkData.targetStatus, 'completed');

    // Customer tier was Gold (1.10x multiplier):
    // 320,000 * 1% = 3,200 base * 1.10 = 3,520 points added
    // 5,200 previous points + 3,520 = 8,720 points
    const loyaltyResBulk = await db.query(
      `SELECT points, lifetime_points AS "lifetimePoints", tier FROM customer_loyalty WHERE customer_id = $1`,
      [custId]
    );
    assert.equal(Number(loyaltyResBulk.rows[0].points), 8720);

    // Verify transaction recorded for bulk order
    const txBulk = await db.query(`SELECT * FROM loyalty_transactions WHERE order_id = $1`, [ordBulkId]);
    assert.equal(txBulk.rows.length, 1);
    assert.equal(Number(txBulk.rows[0].points_change), 3520);
    assert.match(txBulk.rows[0].reason, /ORD-BULK-001/);
  } finally {
    server.close();
    await db.close();
  }
});
