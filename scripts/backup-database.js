#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

async function dumpDatabaseToSql(client) {
  const sqlLines = [];
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

  // 1. Get all public tables
  const tablesRes = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);
  const tables = (tablesRes?.rows || []).map(r => r.table_name);

  for (const table of tables) {
    // 2. Fetch columns
    const colsRes = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position;
    `, [table]);

    if (!colsRes?.rows || colsRes.rows.length === 0) continue;

    sqlLines.push(`-- ------------------------------------------------------------`);
    sqlLines.push(`-- Table: "${table}" (${colsRes.rows.length} columns)`);
    sqlLines.push(`-- ------------------------------------------------------------`);

    // Fetch rows
    const rowsRes = await client.query(`SELECT * FROM "${table}"`);
    const rows = rowsRes?.rows || [];
    sqlLines.push(`-- Data for "${table}": ${rows.length} rows`);

    if (rows.length > 0) {
      const colNames = colsRes.rows.map(c => `"${c.column_name}"`).join(', ');
      for (const row of rows) {
        const values = colsRes.rows.map(c => {
          const val = row[c.column_name];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
          if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
          if (val instanceof Date) return `'${val.toISOString()}'::timestamptz`;
          if (Buffer.isBuffer(val)) return `E'\\\\x${val.toString('hex')}'::bytea`;
          if (typeof val === 'object') {
            return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
          }
          return `'${String(val).replace(/'/g, "''")}'`;
        }).join(', ');
        sqlLines.push(`INSERT INTO "${table}" (${colNames}) VALUES (${values});`);
      }
    }
    sqlLines.push('');
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

async function verifyBackup(filePath, encryptionKey) {
  const fileData = await fs.readFile(filePath);
  let gzippedData = fileData;
  const isEncrypted = filePath.endsWith('.enc');
  if (isEncrypted) {
    gzippedData = decryptBackup(fileData, encryptionKey);
  }
  const rawSql = zlib.gunzipSync(gzippedData).toString('utf8');
  const tableMatches = rawSql.match(/-- Table: "([^"]+)"/g) || [];
  const rowMatches = rawSql.match(/INSERT INTO /g) || [];
  return {
    valid: true,
    isEncrypted,
    filePath,
    compressedSizeBytes: fileData.length,
    uncompressedSizeBytes: Buffer.byteLength(rawSql),
    tableCount: tableMatches.length,
    rowCount: rowMatches.length,
    sqlPreview: rawSql.slice(0, 300)
  };
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
  const rawFilePath = path.join(outputDir, rawFileName);

  console.log(`[Backup] Bắt đầu sao lưu cơ sở dữ liệu GAERU tại ${timestamp}...`);

  let rawData = null;
  let backupMethod = 'pg_dump';

  if (pool) {
    backupMethod = 'native_sql_dump';
    const sqlText = await dumpDatabaseToSql(pool);
    rawData = Buffer.from(sqlText, 'utf8');
  } else {
    // Run pg_dump CLI
    try {
      await execFileAsync('pg_dump', [
        databaseUrl,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        '-F', 'p',
        '-f', rawFilePath
      ]);
      rawData = await fs.readFile(rawFilePath);
      await fs.unlink(rawFilePath);
    } catch (dumpErr) {
      // If pg_dump command is not installed on system, fallback to SQL export notice
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
  decryptBackup,
  verifyBackup
};
