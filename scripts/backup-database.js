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
  const tableMatches = rawSql.match(/^\s*CREATE\s+TABLE\b/gim) || [];
  if (!tableMatches.length) {
    throw new Error('Bản sao lưu không có định nghĩa bảng PostgreSQL; không thể khôi phục cơ sở dữ liệu.');
  }
  const insertCount = (rawSql.match(/^\s*INSERT\s+INTO\b/gim) || []).length;
  const copyBlocks = rawSql.matchAll(/^COPY\s+.+?\s+FROM\s+stdin;\r?\n([\s\S]*?)^\.\s*$/gim);
  let copyRowCount = 0;
  for (const [, block] of copyBlocks) {
    copyRowCount += block.split(/\r?\n/).filter(Boolean).length;
  }
  return {
    valid: true,
    isEncrypted,
    filePath,
    compressedSizeBytes: fileData.length,
    uncompressedSizeBytes: Buffer.byteLength(rawSql),
    tableCount: tableMatches.length,
    rowCount: insertCount + copyRowCount,
    sqlPreview: rawSql.slice(0, 300)
  };
}

async function runBackup({
  databaseUrl = process.env.DATABASE_URL,
  outputDir = path.join(__dirname, '..', '.local-data', 'backups'),
  encryptionKey = process.env.BACKUP_ENCRYPTION_KEY,
  retentionDays = 30,
  dumpDatabase = null
} = {}) {
  if (!databaseUrl && typeof dumpDatabase !== 'function') {
    throw new Error('DATABASE_URL chưa được thiết lập.');
  }
  if (encryptionKey && encryptionKey.length < 16) {
    throw new Error('BACKUP_ENCRYPTION_KEY phải có ít nhất 16 ký tự hoặc không được thiết lập.');
  }

  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileId = crypto.randomUUID();
  const rawFileName = `gaeru_db_backup_${timestamp}-${fileId}.sql`;
  const tempDir = await fs.mkdtemp(path.join(outputDir, '.gaeru-backup-'));
  await fs.chmod(tempDir, 0o700);
  const rawFilePath = path.join(tempDir, rawFileName);

  console.log(`[Backup] Bắt đầu sao lưu cơ sở dữ liệu GAERU tại ${timestamp}...`);

  try {
    if (typeof dumpDatabase === 'function') {
      const dump = await dumpDatabase({ databaseUrl, outputPath: rawFilePath });
      if (dump !== undefined) {
        const data = Buffer.isBuffer(dump) ? dump : Buffer.from(String(dump), 'utf8');
        await fs.writeFile(rawFilePath, data, { mode: 0o600, flag: 'wx' });
      }
    } else {
      await execFileAsync('pg_dump', [
        databaseUrl,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        '--inserts',
        '-F', 'p',
        '-f', rawFilePath
      ], { windowsHide: true });
    }

    await fs.chmod(rawFilePath, 0o600);
    const rawData = await fs.readFile(rawFilePath);
    const rawSql = rawData.toString('utf8');
    const tableCount = (rawSql.match(/^\s*CREATE\s+TABLE\b/gim) || []).length;
    if (!tableCount) {
      throw new Error('pg_dump không tạo được bản sao lưu có schema bảng; không lưu tệp backup.');
    }
    const uncompressedSizeBytes = rawData.length;

    const compressedData = zlib.gzipSync(rawData);

    let finalFileName = `${rawFileName}.gz`;
    let finalData = compressedData;

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
    const pendingPath = path.join(tempDir, finalFileName);
    await fs.writeFile(pendingPath, finalData, { mode: 0o600, flag: 'wx' });
    await fs.rename(pendingPath, finalPath);
    console.log(`[Backup] Thành công: ${finalPath} (${(finalData.length / 1024 / 1024).toFixed(2)} MB)`);

    let cleanedCount = 0;
    try {
      const files = await fs.readdir(outputDir);
      const cutoff = Date.now() - retentionDays * 86400000;
      for (const file of files) {
        if (file.startsWith('gaeru_db_backup_')) {
          const filePath = path.join(outputDir, file);
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(filePath);
            cleanedCount++;
            console.log(`[Backup] Đã dọn dẹp bản sao lưu cũ: ${file}`);
          }
        }
      }
    } catch (error) {
      console.warn('[Backup] Không thể hoàn tất dọn dẹp bản sao lưu cũ:', error.message);
    }

    return {
      success: true,
      filePath: finalPath,
      fileName: finalFileName,
      sizeBytes: finalData.length,
      uncompressedSizeBytes,
      isEncrypted,
      backupMethod: typeof dumpDatabase === 'function' ? 'injected-test-dump' : 'pg_dump',
      cleanedCount
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
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
  decryptBackup,
  verifyBackup
};
