'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

test('Checkout lifecycle precheck can be rerun without duplicating quarantine records', async (t) => {
  const db = await PGlite.create();
  t.after(() => db.close());

  await db.exec(`
    CREATE TABLE warehouse_stock (warehouse_id uuid, variant_id uuid, quantity integer, updated_at timestamptz);
    CREATE TABLE orders (checkout_payload_hash text);
    CREATE TABLE payment_attempts (
      id uuid PRIMARY KEY,
      order_id uuid NOT NULL,
      provider text NOT NULL,
      provider_request_id text,
      transaction_ref text,
      amount_vnd bigint,
      status text
    );
    INSERT INTO payment_attempts (id, order_id, provider, provider_request_id, transaction_ref, amount_vnd, status)
    VALUES
      ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'vnpay', 'duplicate-request', 'txn-1', 10000, 'pending'),
      ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012', 'vnpay', 'duplicate-request', 'txn-2', 10000, 'pending');
  `);

  const precheckSql = await fs.readFile(
    path.join(__dirname, '..', 'db', 'precheck-checkout-lifecycle.sql'),
    'utf8'
  );
  await db.exec(precheckSql);
  const first = await db.query('SELECT attempt_id FROM payment_attempts_quarantine_duplicates ORDER BY attempt_id');
  await db.exec(precheckSql);
  const second = await db.query('SELECT attempt_id FROM payment_attempts_quarantine_duplicates ORDER BY attempt_id');

  assert.equal(first.rows.length, 2);
  assert.deepEqual(second.rows, first.rows);
});
