'use strict';

// These node-local records deliberately live outside public: the bidirectional
// capture triggers and row-content audit only inspect the public schema.
// Receipts must be backed up with the database and must not be pruned while an
// originating queue/backup can replay the same event. After cloning a database,
// give the clone a new identity before enabling writes or replication.
const identities = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hash in PostgreSQL before JSON/numeric values pass through JavaScript. Include
// creation time so a restored/reset sequence cannot silently reuse a receipt.
const QUEUE_SELECT = `SELECT *, encode(sha256(convert_to(
  jsonb_build_array(id::text, table_name, op, pk_vals, created_at AT TIME ZONE 'UTC')::text,
  'UTF8')), 'hex') AS payload_hash
  FROM public._gaeru_sync_queue ORDER BY id ASC LIMIT 50`;

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

async function initializeNode(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(741104, 1)');
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS gaeru_sync;
      REVOKE ALL ON SCHEMA gaeru_sync FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS gaeru_sync.node_identity (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS gaeru_sync.applied_events (
        source_instance uuid NOT NULL,
        event_id bigint NOT NULL,
        payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (source_instance, event_id)
      );
      INSERT INTO gaeru_sync.node_identity (singleton) VALUES (true)
        ON CONFLICT (singleton) DO NOTHING;
    `);
    const result = await client.query('SELECT instance_id::text FROM gaeru_sync.node_identity WHERE singleton');
    const id = result.rows[0]?.instance_id;
    if (!UUID.test(id || '')) throw codedError('SYNC_IDENTITY_INVALID');
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function getNodeIdentity(pool) {
  if (!identities.has(pool)) {
    const pending = initializeNode(pool).catch(err => {
      identities.delete(pool);
      throw err;
    });
    identities.set(pool, pending);
  }
  return identities.get(pool);
}

// Caller MUST invoke inside the same transaction as the business write and
// COMMIT before acknowledging the source. false means already committed: do
// not read/reapply the source row, which might overwrite a newer target edit.
async function claimEvent(client, sourceInstance, event) {
  if (!UUID.test(sourceInstance || '') || !/^[1-9][0-9]*$/.test(String(event.id)) ||
      !/^[0-9a-f]{64}$/.test(event.payload_hash || '')) {
    throw codedError('SYNC_RECEIPT_INVALID');
  }
  const params = [sourceInstance, String(event.id), event.payload_hash];
  const inserted = await client.query(`INSERT INTO gaeru_sync.applied_events
    (source_instance, event_id, payload_hash) VALUES ($1, $2, $3)
    ON CONFLICT (source_instance, event_id) DO NOTHING RETURNING payload_hash`, params);
  if (inserted.rows.length) return true;
  // A separate statement sees a concurrent inserter's COMMIT under READ COMMITTED.
  const existing = await client.query(`SELECT payload_hash FROM gaeru_sync.applied_events
    WHERE source_instance = $1 AND event_id = $2`, params.slice(0, 2));
  if (existing.rows[0]?.payload_hash !== event.payload_hash) {
    throw codedError('SYNC_RECEIPT_MISMATCH');
  }
  return false;
}

module.exports = { getNodeIdentity, claimEvent, QUEUE_SELECT };
