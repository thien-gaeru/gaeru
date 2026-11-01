#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function dumpDatabaseToSql(client) {
  const sqlLines = [];
  const unsupportedRelations = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type <> 'BASE TABLE'
    LIMIT 1
  `);
  if (unsupportedRelations.rows.length) {
    throw new Error(`Native SQL backup does not support public view ${unsupportedRelations.rows[0].table_name}; install pg_dump to create a complete backup.`);
  }
  const triggerCheck = await client.query(`
    SELECT trigger_name
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    LIMIT 1
  `);
  if (triggerCheck.rows.length) {
    throw new Error(`Native SQL backup does not support public trigger ${triggerCheck.rows[0].trigger_name}; install pg_dump to create a complete backup.`);
  }

  sqlLines.push('-- ============================================================');
  sqlLines.push('-- GAERU Store Database Backup (SQL Export)');
  sqlLines.push(`-- Generated At: ${new Date().toISOString()}`);
  sqlLines.push('-- Engine: PostgreSQL / Node.js Engine');
  sqlLines.push('-- ============================================================');
  sqlLines.push('');
  sqlLines.push('BEGIN;');
  sqlLines.push('SET statement_timeout = 0;');
  sqlLines.push('SET client_encoding = \'UTF8\';');
  sqlLines.push('SET standard_conforming_strings = on;');
  sqlLines.push('');

  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);
  const tables = (tablesRes?.rows || []).map(r => r.table_name);
  if (!tables.length) {
    throw new Error('Native SQL backup found no public tables; refusing to create an empty backup.');
  }

  const unsupportedColumns = await client.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type IN ('ARRAY', 'USER-DEFINED')
    LIMIT 1
  `);
  if (unsupportedColumns.rows.length) {
    const column = unsupportedColumns.rows[0];
    throw new Error(`Native SQL backup does not support ${column.data_type} column ${column.table_name}.${column.column_name}; install pg_dump to create a complete backup.`);
  }

  const sequenceRes = await client.query(`
    SELECT sequence_name
    FROM information_schema.sequences
    WHERE sequence_schema = 'public'
    ORDER BY sequence_name
  `);
  for (const { sequence_name: sequenceName } of sequenceRes.rows) {
    sqlLines.push(`CREATE SEQUENCE IF NOT EXISTS ${quoteIdentifier('public')}.${quoteIdentifier(sequenceName)};`);
  }

  const deferredConstraintsAndIndexes = [];
  for (const table of tables) {
    const colsRes = await client.query(`
      SELECT c.column_name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS formatted_type,
             c.is_nullable,
             c.column_default,
             c.is_identity,
             c.identity_generation,
             c.is_generated,
             c.generation_expression
      FROM information_schema.columns c
      JOIN pg_catalog.pg_class t ON t.relname = c.table_name
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace AND n.nspname = c.table_schema
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attname = c.column_name
                                   AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.table_schema = 'public' AND c.table_name = $1
      ORDER BY c.ordinal_position
    `, [table]);
    if (!colsRes?.rows?.length) {
      throw new Error(`Native SQL backup could not inspect columns for public table ${table}.`);
    }

    sqlLines.push(`-- ------------------------------------------------------------`);
    sqlLines.push(`-- Table: "${table}" (${colsRes.rows.length} columns)`);
    sqlLines.push(`-- ------------------------------------------------------------`);
    const tableName = `${quoteIdentifier('public')}.${quoteIdentifier(table)}`;
    const columnDefinitions = colsRes.rows.map((column) => {
      const name = quoteIdentifier(column.column_name);
      if (column.is_generated === 'ALWAYS') {
        return `${name} ${column.formatted_type} GENERATED ALWAYS AS (${column.generation_expression}) STORED`;
      }
      if (column.is_identity === 'YES') {
        const generation = column.identity_generation === 'ALWAYS' ? 'ALWAYS' : 'BY DEFAULT';
        return `${name} ${column.formatted_type} GENERATED ${generation} AS IDENTITY`;
      }
      return `${name} ${column.formatted_type}${column.column_default ? ` DEFAULT ${column.column_default}` : ''}${column.is_nullable === 'NO' ? ' NOT NULL' : ''}`;
    });
    sqlLines.push(`CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefinitions.join(', ')});`);

    const rowsRes = await client.query(`SELECT * FROM ${tableName}`);
    const rows = rowsRes?.rows || [];
    sqlLines.push(`-- Data for "${table}": ${rows.length} rows`);

    if (rows.length > 0) {
      const insertColumns = colsRes.rows.filter(c => c.is_generated !== 'ALWAYS');
      const colNames = insertColumns.map(c => quoteIdentifier(c.column_name)).join(', ');
      for (const row of rows) {
        const values = insertColumns.map(c => {
          const val = row[c.column_name];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
          if (typeof val === 'number') {
            if (!Number.isFinite(val)) throw new Error(`Native SQL backup encountered a non-finite number in ${table}.${c.column_name}.`);
            return String(val);
          }
          if (typeof val === 'bigint') return String(val);
          if (val instanceof Date) return quoteLiteral(val.toISOString());
          if (Buffer.isBuffer(val)) return `decode(${quoteLiteral(val.toString('hex'))}, 'hex')`;
          if (typeof val === 'object') {
            if (c.formatted_type === 'json' || c.formatted_type === 'jsonb') {
              return `${quoteLiteral(JSON.stringify(val))}::${c.formatted_type}`;
            }
            throw new Error(`Native SQL backup encountered an unsupported value in ${table}.${c.column_name}.`);
          }
          return quoteLiteral(val);
        }).join(', ');
        sqlLines.push(`INSERT INTO ${tableName} (${colNames}) VALUES (${values});`);
      }
    }

    const constraints = await client.query(`
      SELECT conname, pg_catalog.pg_get_constraintdef(oid) AS definition
      FROM pg_catalog.pg_constraint
      WHERE conrelid = pg_catalog.to_regclass($1)
      ORDER BY conname
    `, [`public.${table}`]);
    for (const constraint of constraints.rows) {
      deferredConstraintsAndIndexes.push(`ALTER TABLE ${tableName} ADD CONSTRAINT ${quoteIdentifier(constraint.conname)} ${constraint.definition};`);
    }

    const indexes = await client.query(`
      SELECT indexdef
      FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
        AND indexname NOT IN (
          SELECT conname FROM pg_catalog.pg_constraint
          WHERE conrelid = pg_catalog.to_regclass($2) AND conindid <> 0
        )
      ORDER BY indexname
    `, [table, `public.${table}`]);
    for (const { indexdef } of indexes.rows) {
      deferredConstraintsAndIndexes.push(`${indexdef};`);
    }
    sqlLines.push('');
  }

  sqlLines.push(...deferredConstraintsAndIndexes, '');
  for (const { sequence_name: sequenceName } of sequenceRes.rows) {
    const sequencePath = `${quoteIdentifier('public')}.${quoteIdentifier(sequenceName)}`;
    const sequenceState = await client.query(`SELECT last_value, is_called FROM ${sequencePath}`);
    const state = sequenceState.rows[0];
    if (!state) throw new Error(`Native SQL backup could not read state for sequence ${sequenceName}.`);
    sqlLines.push(`SELECT pg_catalog.setval(${quoteLiteral(`${quoteIdentifier('public')}.${quoteIdentifier(sequenceName)}`)}::regclass, ${state.last_value}, ${state.is_called ? 'true' : 'false'});`);
  }

  sqlLines.push('COMMIT;');
  sqlLines.push('');
  return sqlLines.join('\n');
}

function decryptBackup(encryptedBuffer, encryptionKey) {
  if (!encryptionKey || encryptionKey.length < 16) {
    throw new Error('Khóa giải mã không hợp lệ (yêu cầu tối thiểu 16 ký tự).');
  }
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length < 32) {
    throw new Error('Dữ liệu sao lưu mã hóa không hợp lệ (độ dài quá ngắn).');
  }
  const iv = encryptedBuffer.subarray(0, 16);
  const tag = encryptedBuffer.subarray(16, 32);
  const ciphertext = encryptedBuffer.subarray(32);
  const key = crypto.createHash('sha256').update(encryptionKey).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decompressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decompressed; // gzipped buffer
}

function validateSqlBackup(rawSql) {
  const tableMatches = rawSql.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"public"|public)\.)?(?:"(?:""|[^"])+?"|[A-Za-z_][\w$]*)\s*\(/gi) || [];
  const rowMatches = rawSql.match(/\bINSERT\s+INTO\b/gi) || [];
  const copyMatches = rawSql.match(/\bCOPY\b[\s\S]*?\bFROM\s+stdin\s*;/gi) || [];
  const dataSections = rawSql.match(/-- Data for\b/gi) || [];
  const isNativeDump = /-- Engine: PostgreSQL \/ Node\.js Engine/.test(rawSql);
  const hasCompleteEnding = isNativeDump
    ? /\bCOMMIT\s*;\s*(?:--[^\r\n]*\s*)*$/.test(rawSql)
    : /-- PostgreSQL database dump complete\s*$/i.test(rawSql.trimEnd());
  if (!rawSql.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(rawSql)) {
    throw new Error('Backup SQL is empty or contains invalid text data.');
  }
  if (tableMatches.length === 0) {
    throw new Error('Backup verification failed: no CREATE TABLE schema was found.');
  }
  if (rowMatches.length === 0 && copyMatches.length === 0 && dataSections.length === 0) {
    throw new Error('Backup verification failed: no table data section was found.');
  }
  if (!hasCompleteEnding) {
    throw new Error('Backup verification failed: SQL dump is incomplete or has no recognized completion marker.');
  }
  return {
    tableCount: tableMatches.length,
    rowCount: rowMatches.length,
    dataSectionCount: Math.max(dataSections.length, copyMatches.length)
  };
}

async function verifyBackup(filePath, encryptionKey) {
  const fileData = await fs.readFile(filePath);
  let gzippedData = fileData;
  const isEncrypted = filePath.endsWith('.enc');
  if (isEncrypted) {
    gzippedData = decryptBackup(fileData, encryptionKey);
  }
  const rawBuffer = zlib.gunzipSync(gzippedData);
  const rawSql = new TextDecoder('utf-8', { fatal: true }).decode(rawBuffer);
  const { tableCount, rowCount, dataSectionCount } = validateSqlBackup(rawSql);
  return {
    valid: true,
    isEncrypted,
    filePath,
    compressedSizeBytes: fileData.length,
    uncompressedSizeBytes: Buffer.byteLength(rawSql),
    tableCount,
    rowCount,
    dataSectionCount,
    sqlPreview: rawSql.slice(0, 300)
  };
}

async function dumpWithPgDump(databaseUrl, { commandRunner = execFileAsync, tempDir = os.tmpdir() } = {}) {
  const privateDir = await fs.mkdtemp(path.join(tempDir, 'gaeru-pg-dump-'));
  const rawFilePath = path.join(privateDir, 'backup.sql');
  try {
    const handle = await fs.open(rawFilePath, 'wx', 0o600);
    await handle.close();
    await commandRunner('pg_dump', [
      databaseUrl,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '-F', 'p',
      '-f', rawFilePath
    ]);
    return await fs.readFile(rawFilePath);
  } finally {
    await fs.rm(privateDir, { recursive: true, force: true });
  }
}

async function runBackup({
  databaseUrl = process.env.DATABASE_URL,
  pool = null,
  outputDir = path.join(__dirname, '..', '.local-data', 'backups'),
  encryptionKey = process.env.BACKUP_ENCRYPTION_KEY,
  retentionDays = 30
} = {}) {
  if (!databaseUrl && !pool) {
    throw new Error('DATABASE_URL chưa được thiết lập.');
  }

  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawFileName = `gaeru_db_backup_${timestamp}.sql`;

  console.log(`[Backup] Bắt đầu sao lưu cơ sở dữ liệu GAERU tại ${timestamp}...`);

  let rawData = null;
  let backupMethod = 'pg_dump';

  if (pool) {
    backupMethod = 'native_sql_dump';
    const sqlText = await dumpDatabaseToSql(pool);
    rawData = Buffer.from(sqlText, 'utf8');
  } else {
    try {
      rawData = await dumpWithPgDump(databaseUrl);
    } catch (dumpErr) {
      if (dumpErr.code !== 'ENOENT') throw dumpErr;
      console.log(`[Backup] pg_dump không khả dụng (${dumpErr.message}), chuyển sang cơ chế xuất SQL thuần...`);
      backupMethod = 'native_sql_fallback';
      const { Pool } = require('pg');
      const directPool = new Pool({ connectionString: databaseUrl });
      try {
        const sqlText = await dumpDatabaseToSql(directPool);
        rawData = Buffer.from(sqlText, 'utf8');
      } catch (connErr) {
        throw new Error(`pg_dump không khả dụng và không thể kết nối tới DATABASE_URL: ${connErr.message}`);
      } finally {
        await directPool.end().catch(() => {});
      }
    }
  }

  const uncompressedSizeBytes = rawData.length;

  // Compress with Gzip
  const compressedData = zlib.gzipSync(rawData);

  let finalFileName = `${rawFileName}.gz`;
  let finalData = compressedData;

  // Optional AES-256-GCM encryption
  let isEncrypted = false;
  if (encryptionKey && encryptionKey.length >= 16) {
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(compressedData), cipher.final()]);
    const tag = cipher.getAuthTag();
    finalData = Buffer.concat([iv, tag, encrypted]);
    finalFileName += '.enc';
    isEncrypted = true;
    console.log('[Backup] Bản sao lưu đã được mã hóa bảo mật AES-256-GCM.');
  }

  const finalPath = path.join(outputDir, finalFileName);
  await fs.writeFile(finalPath, finalData);
  console.log(`[Backup] Thành công: ${finalPath} (${(finalData.length / 1024 / 1024).toFixed(2)} MB)`);

  // Rotate backups older than retentionDays
  let cleanedCount = 0;
  try {
    const files = await fs.readdir(outputDir);
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const f of files) {
      if (f.startsWith('gaeru_db_backup_')) {
        const filePath = path.join(outputDir, f);
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          cleanedCount++;
          console.log(`[Backup] Đã dọn dẹp bản sao lưu cũ: ${f}`);
        }
      }
    }
  } catch {
    // Ignore cleanup error
  }

  return {
    success: true,
    filePath: finalPath,
    fileName: finalFileName,
    sizeBytes: finalData.length,
    uncompressedSizeBytes,
    isEncrypted,
    backupMethod,
    cleanedCount
  };
}

if (require.main === module) {
  runBackup()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Backup Error]', err.message);
      process.exit(1);
    });
}

module.exports = {
  runBackup,
  dumpDatabaseToSql,
  dumpWithPgDump,
  decryptBackup,
  verifyBackup
};
