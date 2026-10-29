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

async function runBackup({
  databaseUrl = process.env.DATABASE_URL,
  outputDir = path.join(__dirname, '..', '.local-data', 'backups'),
  encryptionKey = process.env.BACKUP_ENCRYPTION_KEY,
  retentionDays = 30
} = {}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL chưa được thiết lập.');
  }

  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rawFileName = `gaeru_db_backup_${timestamp}.sql`;
  const rawFilePath = path.join(outputDir, rawFileName);

  console.log(`[Backup] Bắt đầu sao lưu cơ sở dữ liệu GAERU tại ${timestamp}...`);

  // Run pg_dump
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
  } catch (err) {
    // If pg_dump command is not installed on system, fallback to SQL export notice
    throw new Error(`pg_dump không khả dụng hoặc kết nối thất bại: ${err.message}`);
  }

  // Compress with Gzip
  const rawData = await fs.readFile(rawFilePath);
  const compressedData = zlib.gzipSync(rawData);
  await fs.unlink(rawFilePath);

  let finalFileName = `${rawFileName}.gz`;
  let finalData = compressedData;

  // Optional AES-256-GCM encryption
  if (encryptionKey && encryptionKey.length >= 16) {
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(encryptionKey).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(compressedData), cipher.final()]);
    const tag = cipher.getAuthTag();
    finalData = Buffer.concat([iv, tag, encrypted]);
    finalFileName += '.enc';
    console.log('[Backup] Bản sao lưu đã được mã hóa bảo mật AES-256-GCM.');
  }

  const finalPath = path.join(outputDir, finalFileName);
  await fs.writeFile(finalPath, finalData);
  console.log(`[Backup] Thành công: ${finalPath} (${(finalData.length / 1024 / 1024).toFixed(2)} MB)`);

  // Rotate backups older than retentionDays
  try {
    const files = await fs.readdir(outputDir);
    const cutoff = Date.now() - retentionDays * 86400000;
    for (const f of files) {
      if (f.startsWith('gaeru_db_backup_')) {
        const filePath = path.join(outputDir, f);
        const stat = await fs.stat(filePath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath);
          console.log(`[Backup] Đã dọn dẹp bản sao lưu cũ: ${f}`);
        }
      }
    }
  } catch {
    // Ignore cleanup error
  }

  return { success: true, filePath: finalPath, sizeBytes: finalData.length };
}

if (require.main === module) {
  runBackup()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Backup Error]', err.message);
      process.exit(1);
    });
}

module.exports = { runBackup };
