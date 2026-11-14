'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseEnvText(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map.set(k, v);
  }
  return map;
}

(async () => {
  const rootDir = path.resolve(__dirname, '..');
  const apply = process.argv.includes('--apply');
  const syncEnvPath = path.join(rootDir, '.env.cluster-sync');
  const dotEnvPath = path.join(rootDir, '.env');

  if (!fs.existsSync(syncEnvPath)) {
    console.log('No .env.cluster-sync found; skipping PC -> Mi6 reconcile.');
    return;
  }

  const clusterEnv = parseEnvText(fs.readFileSync(syncEnvPath, 'utf8'));
  const pcEnv = fs.existsSync(dotEnvPath) ? parseEnvText(fs.readFileSync(dotEnvPath, 'utf8')) : new Map();
  const pcUrl = clusterEnv.get('PC_DB_URL') || pcEnv.get('DATABASE_URL');
  const mi6Url = clusterEnv.get('MI6_DB_URL');
  const mi6CaPath = clusterEnv.get('MI6_DB_SSL_CA');

  if (!pcUrl || !mi6Url) {
    throw new Error('Missing PC_DB_URL or MI6_DB_URL in .env.cluster-sync');
  }

  const sslMode = String(process.env.MI6_DB_SSL_MODE || '').trim().toLowerCase();
  const mi6TargetRaw = String(process.env.MI6_DB_URL || process.env.MI6_DATABASE_URL || process.env.MI6_PG_URL || process.env.MI6_HOST || '').trim();
  let mi6Host = '';
  if (mi6TargetRaw) {
    try { mi6Host = new URL(mi6TargetRaw).hostname.toLowerCase(); } catch (_) { mi6Host = mi6TargetRaw.split(':')[0].toLowerCase(); }
  }
  const isLoopback = mi6Host === '127.0.0.1' || mi6Host === 'localhost' || mi6Host === '::1';
  if (mi6CaPath && !fs.existsSync(mi6CaPath)) {
    throw new Error(`MI6_DB_SSL_CA certificate file not found: ${mi6CaPath}`);
  }
  if (!mi6CaPath && !(isLoopback && sslMode === 'disable') && sslMode !== 'require') {
    throw new Error('Missing MI6_DB_SSL_CA for verified TLS connection to Mi6 PostgreSQL.');
  }
  const mi6Ssl = isLoopback && sslMode === 'disable'
    ? false
    : (mi6CaPath
      ? { ca: fs.readFileSync(mi6CaPath, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: true });

  const pc = new Client({ connectionString: pcUrl, ssl: false });
  const mi6 = new Client({ connectionString: mi6Url, ssl: mi6Ssl });
  await Promise.all([pc.connect(), mi6.connect()]);
  await Promise.all([pc.query("SET TIME ZONE 'UTC'"), mi6.query("SET TIME ZONE 'UTC'")]);

  try {
    const pcQueue = await pc.query("SELECT count(*)::int AS c FROM _gaeru_sync_queue").catch(() => null);
    const mi6Queue = await mi6.query("SELECT count(*)::int AS c FROM _gaeru_sync_queue").catch(() => null);
    console.log('Sync queue counts -> PC:', pcQueue ? pcQueue.rows[0].c : 'N/A', '| Mi6:', mi6Queue ? mi6Queue.rows[0].c : 'N/A');

    const colsRes = await mi6.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='site_traffic' ORDER BY ordinal_position"
    );
    const pkRes = await mi6.query(
      "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid='public.site_traffic'::regclass AND i.indisprimary"
    );
    const pkCol = pkRes.rows[0]?.attname;
    const [pcRows, mi6Rows] = await Promise.all([
      pc.query('SELECT * FROM site_traffic ORDER BY 1 DESC LIMIT 7'),
      mi6.query('SELECT * FROM site_traffic ORDER BY 1 DESC LIMIT 7')
    ]);

    if (pkCol) {
      let updated = 0;
      for (const pcRow of pcRows.rows) {
        const pkVal = pcRow[pkCol];
        const mi6Row = mi6Rows.rows.find((r) => String(r[pkCol]) === String(pkVal));
        if (!mi6Row) continue;

        const sets = [];
        const params = [pkVal];
        for (const col of colsRes.rows) {
          if (col.column_name === pkCol) continue;
          if ((col.data_type === 'integer' || col.data_type === 'bigint') && Number(pcRow[col.column_name] || 0) > Number(mi6Row[col.column_name] || 0)) {
            params.push(Number(pcRow[col.column_name]));
            sets.push(`"${col.column_name}" = GREATEST(COALESCE("${col.column_name}", 0), $${params.length})`);
          }
        }
        if (sets.length > 0) {
          console.log(`Drift on site_traffic (${pkVal}): PC > Mi6 on ${sets.length} counter field(s)`);
          if (apply) {
            await mi6.query(`UPDATE site_traffic SET ${sets.join(', ')} WHERE "${pkCol}" = $1`, params);
            updated += 1;
          }
        }
      }
      console.log(apply ? `Reconciled ${updated} site_traffic row(s) on Mi6.` : 'Dry run complete.');
    }
  } finally {
    await Promise.all([pc.end(), mi6.end()]);
  }
})().catch((err) => {
  console.error('reconcile-pc-traffic-to-mi6 failed:', err.message);
  process.exit(1);
});
