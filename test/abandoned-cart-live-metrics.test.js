'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const {
  recordCartContact,
  markCartRecovered,
  getCartByToken,
  processAbandonedCartReminders
} = require('../src/abandoned-cart');

test('Abandoned Cart Recovery: Live PostgreSQL lifecycle, deduplication, 2-tier reminders and order recovery', async (t) => {
  const db = new PGlite();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS abandoned_carts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      phone text,
      customer_name text,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      subtotal_vnd integer NOT NULL DEFAULT 0,
      recovery_token text UNIQUE,
      status text NOT NULL DEFAULT 'abandoned' CHECK (status IN ('abandoned', 'reminded_1', 'reminded_2', 'recovered')),
      reminder_count integer NOT NULL DEFAULT 0,
      reminder_sent_at timestamptz,
      recovered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS abandoned_carts_status_created_idx ON abandoned_carts (status, created_at);
    CREATE INDEX IF NOT EXISTS abandoned_carts_recovery_token_idx ON abandoned_carts (recovery_token);
  `);

  await t.test('1. Record Contact & Deduplication: Updates cart within 24h without duplicate records', async () => {
    const c1 = await recordCartContact(db, {
      email: 'buyer1@test.com',
      phone: '0901112233',
      customerName: 'Buyer One',
      items: [{ name: 'K9 Mic', quantity: 1, priceVnd: 409000 }],
      subtotalVnd: 409000
    });
    assert.ok(c1.recoveryToken);
    assert.equal(c1.recoveryToken.length, 48);

    // Edit cart (update items and total)
    const c1Updated = await recordCartContact(db, {
      email: 'buyer1@test.com',
      phone: '0901112233',
      customerName: 'Buyer One',
      items: [
        { name: 'K9 Mic', quantity: 1, priceVnd: 409000 },
        { name: 'M1 Earphone', quantity: 1, priceVnd: 389000 }
      ],
      subtotalVnd: 798000
    });
    assert.equal(c1.recoveryToken, c1Updated.recoveryToken, 'Token must remain persistent across edits');

    const rows = (await db.query('SELECT * FROM abandoned_carts WHERE email = $1', ['buyer1@test.com'])).rows;
    assert.equal(rows.length, 1, 'Must not duplicate rows for the same contact');
    assert.equal(rows[0].subtotal_vnd, 798000);
  });

  await t.test('2. Recovery by Token: Retrieves cart payload accurately', async () => {
    const cart = (await db.query('SELECT recovery_token FROM abandoned_carts LIMIT 1')).rows[0];
    const retrieved = await getCartByToken(db, cart.recovery_token);
    assert.ok(retrieved);
    assert.equal(retrieved.customerName, 'Buyer One');
    assert.equal(retrieved.items.length, 2);
    assert.equal(retrieved.subtotalVnd, 798000);

    const nonExistent = await getCartByToken(db, 'invalid-non-existent-token-1234');
    assert.equal(nonExistent, null);
  });

  await t.test('3. Two-Tier Automated Email Reminders: Sends Tier 1 at 60m and Tier 2 at 24h', async () => {
    const sent = [];
    const mailer = { sendMail: async (opts) => sent.push(opts) };

    // Set created_at to 65 minutes ago
    await db.query(`UPDATE abandoned_carts SET created_at = now() - interval '65 minutes'`);
    const count1 = await processAbandonedCartReminders(db, mailer, { PUBLIC_BASE_URL: 'https://gaeru.com' });
    assert.equal(count1, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /GAERU/);
    assert.match(sent[0].html, /GAERUCARE5/);
    assert.match(sent[0].html, /checkout\.html\?recover=/);

    const status1 = (await db.query('SELECT status, reminder_count FROM abandoned_carts')).rows[0];
    assert.equal(status1.status, 'reminded_1');
    assert.equal(status1.reminder_count, 1);

    // Immediate rerun -> 0 sent (spam prevention)
    const countSpam = await processAbandonedCartReminders(db, mailer, { PUBLIC_BASE_URL: 'https://gaeru.com' });
    assert.equal(countSpam, 0);

    // Simulate 25 hours later -> Tier 2 reminder
    await db.query(`UPDATE abandoned_carts SET reminder_sent_at = now() - interval '25 hours'`);
    const count2 = await processAbandonedCartReminders(db, mailer, { PUBLIC_BASE_URL: 'https://gaeru.com' });
    assert.equal(count2, 1);
    assert.equal(sent.length, 2);

    const status2 = (await db.query('SELECT status, reminder_count FROM abandoned_carts')).rows[0];
    assert.equal(status2.status, 'reminded_2');
    assert.equal(status2.reminder_count, 2);
  });

  await t.test('4. Mark Recovered: Updates cart status to recovered when order is placed', async () => {
    const cart = (await db.query('SELECT recovery_token FROM abandoned_carts LIMIT 1')).rows[0];
    await markCartRecovered(db, { recoveryToken: cart.recovery_token });

    const status = (await db.query('SELECT status, recovered_at FROM abandoned_carts LIMIT 1')).rows[0];
    assert.equal(status.status, 'recovered');
    assert.ok(status.recovered_at);
  });

  await db.close();
});
