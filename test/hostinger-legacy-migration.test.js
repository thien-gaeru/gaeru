'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { MIGRATION_FILES, migrateDatabase } = require('../src/migrate');

function createPglitePool(pg) {
  return {
    query: (text, params) => pg.query(text, params),
    connect: async () => ({
      query: async (text, params) => {
        if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
        return !params ? pg.exec(text) : pg.query(text, params);
      },
      release: () => {}
    })
  };
}

test('Hostinger legacy production schema reconciles cleanly without 42703 undefined_column errors', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text
      );
    `);

    // 1. Apply the 60 baseline migrations that were already recorded on Hostinger
    const baselineEnd = MIGRATION_FILES.indexOf('order-permanent-deletion.sql');
    assert.ok(baselineEnd >= 0, 'order-permanent-deletion.sql must exist in MIGRATION_FILES');
    for (const file of MIGRATION_FILES.slice(0, baselineEnd + 1)) {
      const sql = await fs.readFile(path.join(__dirname, '..', 'db', file), 'utf8');
      await pg.exec(sql);
      await pg.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }

    // 2. Simulate the exact pre-existing legacy tables/constraints from Hostinger production
    await pg.exec(`
      CREATE TABLE abandoned_carts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text,
        phone text,
        customer_name text,
        items jsonb NOT NULL DEFAULT '[]'::jsonb,
        subtotal_vnd bigint NOT NULL DEFAULT 0,
        recovery_token text UNIQUE NOT NULL,
        status text NOT NULL DEFAULT 'abandoned' CHECK (status IN ('abandoned', 'reminded_1', 'reminded_2', 'recovered', 'expired')),
        reminder_count integer NOT NULL DEFAULT 0,
        reminder_sent_at timestamptz,
        recovered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        email_recovery_token_hash text,
        email_recovery_expires_at timestamptz
      );

      CREATE TABLE customer_loyalty (
        customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        points bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
        lifetime_points bigint NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
        tier text NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'silver', 'gold', 'diamond')),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE product_bundles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        main_product_slug text NOT NULL,
        bundle_product_slug text NOT NULL,
        bundle_title text NOT NULL,
        discount_percent integer NOT NULL DEFAULT 20 CHECK (discount_percent >= 1 AND discount_percent <= 90),
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE product_reviews (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        product_slug text NOT NULL,
        customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
        order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
        author_name text NOT NULL,
        rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
        title text NOT NULL,
        comment text NOT NULL,
        media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
        is_verified_buyer boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      DROP TABLE IF EXISTS order_deletion_sessions;
      CREATE OR REPLACE FUNCTION protect_sales_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Sales receipts are append-only';
      END $$;
    `);

    // 3. Seed legacy rows to verify zero data loss and full constraint compatibility
    const customerId = (await pg.query(
      `INSERT INTO customers (full_name, email, google_id)
       VALUES ('Khach Cu', 'legacy@example.com', 'google-legacy-sub-99')
       RETURNING id`
    )).rows[0].id;

    const product = (await pg.query(
      `INSERT INTO products (slug, name, category)
       VALUES ('legacy-mic', 'GAERU Legacy Mic', 'audio')
       RETURNING id, slug`
    )).rows[0];

    await pg.query(
      `INSERT INTO customer_loyalty (customer_id, points, lifetime_points, tier)
       VALUES ($1, 1800, 3200, 'diamond')`,
      [customerId]
    );

    await pg.query(
      `INSERT INTO abandoned_carts (email, phone, customer_name, subtotal_vnd, recovery_token, status, reminder_sent_at)
       VALUES (NULL, '0901112233', 'Guest Phone', 3500000, 'legacy-phone-tok', 'reminded_1', now()),
              ('recover@example.com', '0902223344', 'Guest Email', 1500000, 'legacy-email-tok', 'reminded_2', now())`
    );

    await pg.query(
      `INSERT INTO product_bundles (main_product_slug, bundle_product_slug, bundle_title, discount_percent, sort_order)
       VALUES ('legacy-mic', 'legacy-arm', 'Combo Legacy', 15, 1)`
    );

    await pg.query(
      `INSERT INTO product_reviews (product_slug, customer_id, author_name, rating, title, comment, media_urls, status)
       VALUES ($1, $2, 'Khach Cu', 5, 'Tot', 'Hay', '["https://gaeru.com/r1.jpg"]'::jsonb, 'approved')`,
      [product.slug, customerId]
    );

    // 4. Run full migrateDatabase (twice to assert idempotency)
    const pool = createPglitePool(pg);
    await migrateDatabase(pool);
    await migrateDatabase(pool);

    // 5. Verify migrated data & new inserts succeed without 42703 / 23502 / 23514
    const loyalty = (await pg.query(
      `SELECT points_balance, lifetime_earned, tier FROM customer_loyalty WHERE customer_id = $1`,
      [customerId]
    )).rows[0];
    assert.equal(loyalty.points_balance, 1800);
    assert.equal(loyalty.lifetime_earned, 3200);
    assert.equal(loyalty.tier, 'platinum');

    const carts = (await pg.query(
      `SELECT email, subtotal_vnd, status, recovery_consent, recovery_token_hash
       FROM abandoned_carts ORDER BY subtotal_vnd ASC`
    )).rows;
    assert.equal(carts.length, 2);
    assert.equal(carts[0].email, 'recover@example.com');
    assert.equal(carts[0].subtotal_vnd, 1500000);
    assert.equal(carts[0].status, 'abandoned');
    assert.equal(carts[0].recovery_token_hash.length, 64);
    assert.equal(carts[1].email, '');
    assert.equal(carts[1].status, 'expired');
    assert.equal(carts[1].recovery_consent, false);

    // Insert new bundle without legacy main_product_slug / bundle_product_slug / bundle_title
    await pg.query(
      `INSERT INTO product_bundles (title, description, discount_type, discount_value, active, starts_at, ends_at)
       VALUES ('Combo Moi', 'Mo ta', 'percent', 10, true, now(), now() + interval '30 days')`
    );

    // Insert new review with NULL title and 'hidden' status
    await pg.query(
      `INSERT INTO product_reviews (product_id, customer_name, customer_email, rating, title, comment, status)
       VALUES ($1, 'User Moi', 'new@example.com', 5, NULL, 'San pham rat tuyet voi', 'hidden')`,
      [product.id]
    );

    // Verify Google identity backfilled
    const identity = (await pg.query(
      `SELECT provider_subject FROM auth_identities WHERE customer_id = $1 AND provider = 'google'`,
      [customerId]
    )).rows[0];
    assert.equal(identity.provider_subject, 'google-legacy-sub-99');

    // Verify order_deletion_sessions restored
    const orderId = (await pg.query(
      `INSERT INTO orders (order_number, customer_name, email, phone, address, city, payment_method, subtotal_vnd, total_vnd)
       VALUES ('GR-LEG-1', 'Khach Cu', 'legacy@example.com', '0901112233', '123 Duong A', 'HCM', 'cod', 100000, 100000)
       RETURNING id`
    )).rows[0].id;
    await pg.query(`INSERT INTO order_deletion_sessions (order_id) VALUES ($1)`, [orderId]);
  } finally {
    await pg.close();
  }
});

test('auth-identities migration scopes information_schema lookup to current_schema()', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE SCHEMA other_tenant;
      CREATE TABLE other_tenant.customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        google_id text,
        email text
      );
    `);
    const pool = createPglitePool(pg);
    await migrateDatabase(pool);
  } finally {
    await pg.close();
  }
});

test('migrateDatabase tags failing migration filename without leaking SQL content', async () => {
  const fakePool = {
    connect: async () => ({
      query: async (sql, params) => {
        if (/SELECT name FROM schema_migrations/i.test(sql)) {
          if (params?.[0]) return { rows: params[0] === 'abandoned-cart.sql' ? [] : [{ name: params[0] }] };
          return { rows: MIGRATION_FILES.filter(f => f !== 'abandoned-cart.sql').map(name => ({ name })) };
        }
        if (/CREATE TABLE IF NOT EXISTS abandoned_carts/i.test(sql)) {
          const err = new Error('column "next_reminder_at" does not exist');
          err.code = '42703';
          throw err;
        }
        return { rows: [] };
      },
      release: () => {}
    })
  };

  await assert.rejects(
    () => migrateDatabase(fakePool),
    (err) => {
      assert.equal(err.code, '42703');
      assert.equal(err.migrationFile, 'abandoned-cart.sql');
      return true;
    }
  );
});
