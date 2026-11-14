const { Pool } = require('pg');
const { connectionOptions } = require('./realtime-cluster-sync');

async function installOnPool(pool, name) {
  console.log(`Installing cluster sync triggers on ${name}...`);

  // 1. Create sync queue table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _gaeru_sync_queue (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      op TEXT NOT NULL,
      pk_vals JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS idx_gaeru_sync_queue_created ON _gaeru_sync_queue(id ASC);
  `);

  // 2. Create generic trigger function
  await pool.query(`
    CREATE OR REPLACE FUNCTION fn_gaeru_sync_capture()
    RETURNS TRIGGER AS $$
    DECLARE
      v_suppress TEXT;
      v_role TEXT;
      v_pk JSONB;
    BEGIN
      -- Check suppression flag
      v_suppress := COALESCE(current_setting('gaeru_sync.suppress', true), 'off');
      IF v_suppress = 'on' THEN
        RETURN COALESCE(NEW, OLD);
      END IF;

      -- Check session replication role
      v_role := COALESCE(current_setting('session_replication_role', true), 'origin');
      IF v_role = 'replica' THEN
        RETURN COALESCE(NEW, OLD);
      END IF;

      -- If DELETE, use OLD, otherwise use NEW
      IF TG_OP = 'DELETE' THEN
        v_pk := to_jsonb(OLD);
      ELSE
        v_pk := to_jsonb(NEW);
      END IF;

      INSERT INTO _gaeru_sync_queue (table_name, op, pk_vals)
      VALUES (TG_TABLE_NAME, TG_OP, v_pk);

      PERFORM pg_notify('gaeru_sync_signal', TG_TABLE_NAME);

      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
  `);

  // 3. Get all base tables except internal ones
  const res = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('_gaeru_sync_queue', 'schema_migrations')
    ORDER BY table_name;
  `);

  const tables = res.rows.map(r => r.table_name);
  console.log(`Attaching trigger to ${tables.length} tables on ${name}...`);

  for (const t of tables) {
    // Drop existing trigger if any
    await pool.query(`DROP TRIGGER IF EXISTS trg_gaeru_sync_capture ON "${t}";`);
    // Create after insert/update/delete trigger
    await pool.query(`
      CREATE TRIGGER trg_gaeru_sync_capture
      AFTER INSERT OR UPDATE OR DELETE ON "${t}"
      FOR EACH ROW EXECUTE FUNCTION fn_gaeru_sync_capture();
    `);
  }

  console.log(`Successfully installed cluster sync triggers on ${name} (${tables.length} tables)!`);
}

async function main() {
  const pcUrl = process.env.PC_DB_URL || process.env.DATABASE_URL;
  if (!pcUrl || !process.env.MI6_DB_URL) throw new Error('Configure both database connections before installing triggers.');
  const p1 = new Pool(connectionOptions(pcUrl));
  const p2 = new Pool(connectionOptions(process.env.MI6_DB_URL));

  await installOnPool(p1, 'PC (localhost:5433)');
  await installOnPool(p2, 'Mi 6 (192.168.31.59:5432)');

  await p1.end();
  await p2.end();
}

main().catch(err => {
  console.error('Trigger installation error:', err);
  process.exit(1);
});
