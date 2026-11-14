'use strict';

/**
 * GAERU ENTERPRISE CLUSTER REALTIME SYNCHRONIZER
 * 
 * Đồng bộ hai chiều theo hàng đợi giữa 2 máy chủ GAERU:
 * - Server 1 (PC Windows): localhost:5433 | E:\GAERU_Media
 * - Server 2 (Xiaomi Mi 6): 192.168.31.59:5432 | /storage/apps/gaeru/media
 * 
 * Tính năng:
 * 1. PostgreSQL Trigger & LISTEN/NOTIFY đánh thức hàng đợi đồng bộ.
 * 2. Hai chiều (Active-Active Bi-directional): Đơn hàng, khách hàng, sản phẩm, phiên đăng nhập,
 *    kho hàng, thanh toán được chuyển tiếp khi hai máy kết nối được.
 * 3. Chống vòng lặp vô hạn (Loop Suppression) với `session_replication_role = 'replica'`
 *    và `gaeru_sync.suppress = 'on'`.
 * 4. Tự bù đắp dữ liệu (Self-Healing & Outbox Queue): Khi rớt mạng hoặc khởi động lại,
 *    tự động bù đắp mọi bản ghi chưa đồng bộ.
 * 5. Kiểm kê hash và bù tệp thiếu hai chiều; giữ lại mọi phiên bản xung đột.
 * Không bảo đảm giao dịch nhiều bảng nguyên tử giữa hai DB hay giải quyết
 * việc hai máy đồng thời sửa cùng bản ghi khi mạng bị chia cắt.
 */

const { Pool, Client, types } = require('pg');
const fs = require('fs');
const path = require('path');
const { createMediaSynchronizer } = require('./cluster-media-sync');
const { getNodeIdentity, claimEvent, QUEUE_SELECT } = require('./cluster-sync-receipts');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.cluster-sync'), quiet: true });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const PC_DB_URL = process.env.PC_DB_URL || process.env.DATABASE_URL;
const MI6_DB_URL = process.env.MI6_DB_URL;
const PC_MEDIA_DIR = process.env.PC_MEDIA_DIR || process.env.MEDIA_ROOT || 'E:\\GAERU_Media';
const MI6_SSH_HOST = process.env.MI6_SSH_HOST || 'root@192.168.31.59';

const LOG_FILE = path.resolve(__dirname, '..', 'logs', 'cluster-sync.log');
const ERR_LOG_FILE = path.resolve(__dirname, '..', 'logs', 'cluster-sync-errors.log');
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60000;
const MAX_BATCHES_PER_DRAIN = 5;
const AUDIT_INTERVAL_MS = 60000;

function safeLogText(value) {
  return String(value).replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[database connection redacted]');
}

const SAFE_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EACCES', 'EPERM',
  'ENOENT', 'EBADF', 'ENOSPC', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
  'SYNC_METADATA_MISSING', 'SYNC_EVENT_INVALID', 'SYNC_IDENTITY_INVALID',
  'SYNC_IDENTITY_DUPLICATE', 'SYNC_RECEIPT_INVALID', 'SYNC_RECEIPT_MISMATCH'
]);
function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  // SQLSTATE or an explicitly recognized runtime code. Never print an error's
  // message, detail, query, parameters or stack: PostgreSQL may put row values there.
  return SAFE_ERROR_CODES.has(code) || /^(?:[0-9][0-9A-Z]|F0|HV|P0|XX)[0-9A-Z]{3}$/.test(code) ? code : 'UNAVAILABLE';
}
function safeNodeName(value) { return value === 'PC' || value === 'Mi6' ? value : 'unknown'; }
function eventLogContext(event) {
  const id = /^[0-9]{1,20}$/.test(String(event?.id ?? '')) ? String(event.id) : 'unknown';
  const table = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(String(event?.table_name ?? '')) ? event.table_name : 'unknown';
  const op = ['INSERT', 'UPDATE', 'DELETE'].includes(event?.op) ? event.op : 'unknown';
  return `event=${id} table=${table} op=${op}`;
}

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${safeLogText(msg)}\n`;
  try {
    process.stdout.write(line);
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

function logError(msg, err, level = 'ERROR') {
  const ts = new Date().toISOString();
  const severity = level === 'FATAL' ? 'FATAL' : 'ERROR';
  const line = `[${ts}] [${severity}] ${safeLogText(msg)} code=${safeErrorCode(err)}\n`;
  try {
    process.stderr.write(line);
    fs.appendFileSync(ERR_LOG_FILE, line);
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

// ---------------------------------------------------------
// 1. Database Pools & Metadata Cache
// ---------------------------------------------------------
// JavaScript Date truncates PostgreSQL microseconds. Keep timestamp values as text
// for parameterized writes, including primary keys, in either replication direction.
const replicationTypes = {
  getTypeParser(oid, format) {
    if (format !== 'binary' && (oid === 1114 || oid === 1184)) return value => value;
    return types.getTypeParser(oid, format);
  }
};
const poolOptions = { max: 10, keepAlive: true, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 14000, lock_timeout: 10000, idle_in_transaction_session_timeout: 15000, types: replicationTypes, options: '-c timezone=UTC' };
function connectionOptions(connectionString) {
  const { URL } = require('node:url');
  if (connectionString === PC_DB_URL) {
    return { ...require('../src/db').poolOptions({ ...process.env, DATABASE_URL: connectionString }), ...poolOptions };
  }
  // The LAN connection uses a pinned CA and verifies the certificate name.
  // Strip URI SSL overrides so a URL cannot silently disable verification.
  const parsed = URL.canParse(connectionString) ? new URL(connectionString) : null;
  if (parsed) {
    for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) parsed.searchParams.delete(key);
  }
  return {
    ...poolOptions,
    connectionString: parsed ? parsed.toString() : connectionString,
    ssl: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ...(process.env.MI6_DB_SSL_CA ? { ca: fs.readFileSync(process.env.MI6_DB_SSL_CA, 'utf8') } : {}),
      ...(process.env.MI6_DB_SSL_SERVERNAME ? { servername: process.env.MI6_DB_SSL_SERVERNAME } : {})
    }
  };
}
const poolPC = new Pool(connectionOptions(PC_DB_URL));
const poolMi6 = new Pool(connectionOptions(MI6_DB_URL));
poolPC.on('error', (err) => logError('Idle client error on poolPC (auto-recovering)', err));
poolMi6.on('error', (err) => logError('Idle client error on poolMi6 (auto-recovering)', err));
process.on('uncaughtException', (err) => logError('Uncaught exception in sync daemon (staying alive)', err));
process.on('unhandledRejection', (err) => logError('Unhandled rejection in sync daemon (staying alive)', err));

let tableMetadata = {}; // { tableName: { pks: ['id'], cols: ['id', ...], colTypes: { id: 'uuid', ... } } }
let isRunning = true;
let isSyncingPCtoMi6 = false;
let isSyncingMi6toPC = false;
let isAuditing = false;
const directionRetries = new Map();

async function loadMetadata() {
  log('Đang nạp cấu trúc bảng, khóa chính và kiểu dữ liệu...');
  const pksRes = await poolPC.query(`
    SELECT 
      tc.table_name,
      array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) as pks
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name 
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'public' 
      AND tc.constraint_type = 'PRIMARY KEY'
    GROUP BY tc.table_name;
  `);

  const colsRes = await poolPC.query(`
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `);

  const meta = Object.create(null);
  for (const r of pksRes.rows) {
    meta[r.table_name] = { pks: r.pks, cols: [], colTypes: {} };
  }
  for (const r of colsRes.rows) {
    if (meta[r.table_name]) {
      meta[r.table_name].cols.push(r.column_name);
      meta[r.table_name].colTypes[r.column_name] = r.udt_name;
    }
  }

  tableMetadata = meta;
  log(`✓ Đã nạp cấu hình metadata cho ${Object.keys(meta).length} bảng.`);
}

function sanitizeColumnValue(val, colType) {
  if (val === null || val === undefined) return null;
  if (colType === 'json' || colType === 'jsonb') {
    if (typeof val === 'object') {
      return JSON.stringify(val);
    }
    if (typeof val === 'string') {
      if (val.trim() === '') return null;
      try {
        JSON.parse(val);
        return val;
      } catch (_) {
        return JSON.stringify(val);
      }
    }
  }
  return val;
}

// ---------------------------------------------------------
// 2. Replication Core Logic
// ---------------------------------------------------------

/**
 * Đồng bộ một sự kiện từ Source DB sang Target DB
 */
async function replicateEvent(sourcePool, targetPool, event, sourceName, targetName) {
  const { id, table_name, op, pk_vals } = event;
  const meta = Object.hasOwn(tableMetadata, table_name) ? tableMetadata[table_name] : null;

  if (!meta || !meta.pks || meta.pks.length === 0) {
    throw Object.assign(new Error('Replication metadata is unavailable.'), { code: 'SYNC_METADATA_MISSING' });
  }

  if (!['INSERT', 'UPDATE', 'DELETE'].includes(op) || !pk_vals || typeof pk_vals !== 'object' ||
      !meta.pks.every(key => Object.hasOwn(pk_vals, key) && pk_vals[key] !== null && pk_vals[key] !== undefined)) {
    throw Object.assign(new Error('Replication event is invalid.'), { code: 'SYNC_EVENT_INVALID' });
  }

  const pks = meta.pks;
  const cols = meta.cols;
  const colTypes = meta.colTypes || {};

  const [sourceInstance, targetInstance] = await Promise.all([
    getNodeIdentity(sourcePool), getNodeIdentity(targetPool)
  ]);
  if (sourceInstance === targetInstance) {
    throw Object.assign(new Error('Node identities must differ'), { code: 'SYNC_IDENTITY_DUPLICATE' });
  }

  const targetClient = await targetPool.connect();
  let committed = false;
  try {
    await targetClient.query('BEGIN');
    await targetClient.query("SET LOCAL session_replication_role = 'replica'");
    await targetClient.query("SET LOCAL gaeru_sync.suppress = 'on'");
    await targetClient.query("SET LOCAL gaeru.allow_owner_order_purge = 'on'");

    const shouldApply = await claimEvent(targetClient, sourceInstance, event);
    if (shouldApply && op === 'DELETE') {
      const whereClauses = pks.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ');
      const params = pks.map(k => pk_vals[k]);
      await targetClient.query(`DELETE FROM "${table_name}" WHERE ${whereClauses}`, params);
    } else if (shouldApply) {
      // INSERT hoặc UPDATE: Lấy dòng dữ liệu hiện tại từ Source DB
      const whereClauses = pks.map((k, i) => `"${k}" = $${i + 1}`).join(' AND ');
      const params = pks.map(k => pk_vals[k]);
      const srcRowRes = await sourcePool.query(`SELECT * FROM "${table_name}" WHERE ${whereClauses}`, params);

      if (srcRowRes.rows.length === 0) {
        // Dòng dữ liệu đã bị xóa ở nguồn, xóa ở đích
        await targetClient.query(`DELETE FROM "${table_name}" WHERE ${whereClauses}`, params);
      } else {
        const row = srcRowRes.rows[0];
        const rowCols = cols.filter(c => c in row);
        const colNamesStr = rowCols.map(c => `"${c}"`).join(', ');
        const placeholders = rowCols.map((_, i) => `$${i + 1}`).join(', ');
        const values = rowCols.map(c => sanitizeColumnValue(row[c], colTypes[c]));

        const conflictTarget = pks.map(c => `"${c}"`).join(', ');
        const nonPkCols = rowCols.filter(c => !pks.includes(c));

        let upsertSql;
        if (nonPkCols.length > 0) {
          const updateSets = nonPkCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
          upsertSql = `
            INSERT INTO "${table_name}" (${colNamesStr})
            VALUES (${placeholders})
            ON CONFLICT (${conflictTarget})
            DO UPDATE SET ${updateSets}
          `;
        } else {
          upsertSql = `
            INSERT INTO "${table_name}" (${colNamesStr})
            VALUES (${placeholders})
            ON CONFLICT (${conflictTarget})
            DO NOTHING
          `;
        }

        await targetClient.query(upsertSql, values);
      }
    }

    await targetClient.query('COMMIT');
    committed = true;
    log(`[${safeNodeName(sourceName)} -> ${safeNodeName(targetName)}] ${shouldApply ? 'APPLIED' : 'ALREADY_APPLIED'} ${eventLogContext(event)}`);

    // Xóa sự kiện khỏi hàng đợi Source DB
    await sourcePool.query('DELETE FROM _gaeru_sync_queue WHERE id = $1', [id]);
  } catch (err) {
    if (!committed) await targetClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    targetClient.release();
  }
}

/**
 * Xử lý toàn bộ hàng đợi từ Source DB sang Target DB
 */
async function drainQueue(sourcePool, targetPool, sourceName, targetName) {
  const direction = `${sourceName} -> ${targetName}`;
  let retry = directionRetries.get(direction);
  if (!retry) {
    retry = { failures: 0, nextAttemptAt: 0 };
    directionRetries.set(direction, retry);
  }
  if (Date.now() < retry.nextAttemptAt) return 0;
  let totalProcessed = 0;
  let pendingEvent = null;
  try {
    // Preserve order on failure; later events must not overtake an unacknowledged one.
    // Bound each turn so a continuously growing queue cannot monopolize the worker.
    for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN && isRunning; batch++) {
      const res = await sourcePool.query(QUEUE_SELECT);
      for (const event of res.rows) {
        if (!isRunning) return totalProcessed;
        pendingEvent = event;
        await replicateEvent(sourcePool, targetPool, event, sourceName, targetName);
        pendingEvent = null;
        totalProcessed++;
        retry.failures = 0;
        retry.nextAttemptAt = 0;
      }
      if (res.rows.length < 50) break;
    }
  } catch (err) {
    retry.failures = Math.min(retry.failures + 1, 16);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** (retry.failures - 1)));
    retry.nextAttemptAt = Date.now() + delay;
    logError(`[${safeNodeName(sourceName)} -> ${safeNodeName(targetName)}] Giữ nguyên sự kiện chưa xác nhận; thử lại sau ${delay}ms; ${eventLogContext(pendingEvent)}`, err);
  }
  return totalProcessed;
}

// ---------------------------------------------------------
// 3. PostgreSQL LISTEN / NOTIFY Client
// ---------------------------------------------------------
function startListener(dbUrl, sourceName, onNotification) {
  let client = null;
  let reconnectTimeout = null;
  let closed = false;
  let failures = 0;

  function reconnect(err) {
    if (closed || reconnectTimeout) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(failures++, 6)));
    log(`Listener ${safeNodeName(sourceName)} ngắt kết nối; thử lại sau ${delay}ms; code=${safeErrorCode(err)}`, 'WARN');
    const previous = client;
    client = null;
    reconnectTimeout = setTimeout(() => { reconnectTimeout = null; connect(); }, delay);
    if (previous) previous.end().catch(() => {});
  }

  async function connect() {
    if (closed) return;
    const current = new Client(connectionOptions(dbUrl));
    client = current;
    current.on('error', err => { if (client === current) reconnect(err); });
    current.on('end', () => { if (client === current) reconnect(); });
    current.on('notification', msg => {
      if (!closed && client === current) {
        Promise.resolve().then(() => onNotification(msg.payload)).catch(err => logError('Listener notification failed', err));
      }
    });
    try {
      await current.connect();
      if (closed || client !== current) return;
      await current.query('LISTEN gaeru_sync_signal');
      if (closed || client !== current) return;
      failures = 0;
      log(`✓ Listener đã kết nối tới ${sourceName}.`);
    } catch (err) {
      if (client === current) reconnect(err);
    }
  }

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(reconnectTimeout);
      const previous = client;
      client = null;
      if (previous) previous.end().catch(() => {});
    }
  };
}

// ---------------------------------------------------------
// 4. Real-time File Sync (Media)
// ---------------------------------------------------------
let mediaSynchronizer = null;

function startMediaWatcher() {
  // A fresh hash inventory discovers missed changes after outages or process restarts.
  // Files are copied only when absent; differing versions remain on both machines.
  mediaSynchronizer = createMediaSynchronizer({ localRoot: PC_MEDIA_DIR, remoteHost: MI6_SSH_HOST, log });
  mediaSynchronizer.scan().catch(err => logError('Media inventory failed', err));
}

// ---------------------------------------------------------
// 5. Periodic Drift Reconciliation & Audit Heartbeat
// ---------------------------------------------------------

async function drainPendingQueues() {
  const tasks = [];
  if (!isSyncingPCtoMi6) {
    isSyncingPCtoMi6 = true;
    tasks.push(drainQueue(poolPC, poolMi6, 'PC', 'Mi6').finally(() => { isSyncingPCtoMi6 = false; }));
  }
  if (!isSyncingMi6toPC) {
    isSyncingMi6toPC = true;
    tasks.push(drainQueue(poolMi6, poolPC, 'Mi6', 'PC').finally(() => { isSyncingMi6toPC = false; }));
  }
  await Promise.all(tasks);
}

async function reconcileDrift() {
  if (isAuditing) return;
  isAuditing = true;
  try {
    const audit = { checkedAt: new Date().toISOString(), comparedTables: 0, differences: [] };
    // Hash full rows in UTC: equal counts alone cannot establish equal data.
    // These are moving snapshots; a difference must be investigated, never overwritten.
    for (const table of Object.keys(tableMetadata)) {
      const quotedTable = '"' + table.replaceAll('"', '""') + '"';
      const sql = `SELECT count(*)::text AS count, md5(coalesce(string_agg(row_hash, '' ORDER BY row_hash), '')) AS fingerprint
        FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM ${quotedTable} t) hashes`;
      const [pc, mi6] = await Promise.all([
        poolPC.query(sql),
        poolMi6.query(sql)
      ]);
      audit.comparedTables++;
      if (String(pc.rows[0].count) !== String(mi6.rows[0].count) || pc.rows[0].fingerprint !== mi6.rows[0].fingerprint) {
        audit.differences.push({ table, pc: pc.rows[0], mi6: mi6.rows[0] });
        log(`[ĐỐI SOÁT CHỈ ĐỌC] "${table}": PC=${pc.rows[0].count}, Mi6=${mi6.rows[0].count}. Cần kiểm tra; không tự ghi hoặc xóa dữ liệu.`, 'WARN');
      }
    }
    if (typeof fs.writeFileSync === 'function') {
      const statusPath = path.join(path.dirname(LOG_FILE), 'cluster-data-status.json');
      fs.writeFileSync(statusPath + '.tmp', JSON.stringify(audit, null, 2));
      fs.renameSync(statusPath + '.tmp', statusPath);
    }
    return audit;
  } catch (err) {
    logError('Không hoàn tất đối soát chỉ đọc', err);
  } finally {
    isAuditing = false;
  }
}

// ---------------------------------------------------------
// 6. Main Orchestrator
// ---------------------------------------------------------
async function main() {
  if (!PC_DB_URL || !MI6_DB_URL) {
    throw new Error('Cần PC_DB_URL (hoặc DATABASE_URL) và MI6_DB_URL trong môi trường hoặc .env.cluster-sync.');
  }
  log('===========================================================');
  log('   GAERU ENTERPRISE CLUSTER REALTIME SYNCHRONIZER 24/7     ');
  log('===========================================================');

  const logsDir = path.dirname(LOG_FILE);
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Keep the worker alive through an outage; pending events stay in their source DB.
  let auditCycleRunning = false;
  let lastAuditAt = 0;
  async function auditCycle() {
    if (auditCycleRunning || Date.now() - lastAuditAt < AUDIT_INTERVAL_MS) return;
    auditCycleRunning = true;
    lastAuditAt = Date.now();
    try {
      await loadMetadata();
      await reconcileDrift();
    } catch (err) {
      logError('Chưa nạp được metadata; giữ hàng đợi và thử lại ở chu kỳ sau', err);
    } finally {
      auditCycleRunning = false;
    }
  }
  await auditCycle();
  startMediaWatcher();

  log('Xử lý các sự kiện chưa được xác nhận ở cả hai máy...');
  await drainPendingQueues();

  const listenerPC = startListener(PC_DB_URL, 'PC', drainPendingQueues);
  const listenerMi6 = startListener(MI6_DB_URL, 'Mi6', drainPendingQueues);

  const heartbeatTimer = setInterval(async () => {
    await Promise.all([drainPendingQueues(), auditCycle(), mediaSynchronizer?.scan()]);
  }, 5000);

  log('===========================================================');
  log('✓ CLUSTER SYNCHRONIZER ĐANG CHẠY HAI CHIỀU; sự kiện lỗi được giữ lại để thử lại.');
  log('===========================================================');

  function shutdown() {
    log('Đang dừng cluster synchronizer...');
    isRunning = false;
    clearInterval(heartbeatTimer);
    if (mediaSynchronizer) mediaSynchronizer.close();
    listenerPC.close();
    listenerMi6.close();
    poolPC.end().catch(() => {});
    poolMi6.end().catch(() => {});
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { loadMetadata, replicateEvent, drainQueue, reconcileDrift, startListener, connectionOptions };
if (require.main === module) {
  main().catch(err => {
    logError('Lỗi nghiêm trọng khi khởi động Cluster Synchronizer', err, 'FATAL');
    process.exit(1);
  });
}
