'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const { runBackup, decryptBackup, verifyBackup } = require('../scripts/backup-database');
const { writeBackupDumpFixture } = require('../test/helpers/backup-dump-fixture');

async function runLiveVerification() {
  const testOutputDir = path.join(__dirname, '..', '.local-data', 'test-backups-' + Date.now());
  const encryptionKey = 'GaeruStore_UltraSecretBackupKey_2026_AES256!';
  const { pool } = await createTestDb({ migrate: false });

  try {
    console.log('Kiểm tra pipeline backup mã hóa, giải mã và phục hồi bằng PGlite.');
    console.log('Dump fixture mô phỏng đầu ra SQL đầy đủ; môi trường production sử dụng pg_dump.');

    const startedAt = performance.now();
    const backupResult = await runBackup({
      databaseUrl: 'postgres://backup-fixture.invalid/gaeru',
      dumpDatabase: writeBackupDumpFixture,
      outputDir: testOutputDir,
      encryptionKey,
      retentionDays: 30
    });
    const durationMs = performance.now() - startedAt;

    assert.equal(backupResult.success, true);
    assert.equal(backupResult.isEncrypted, true);
    assert.ok(backupResult.sizeBytes > 0);

    const verifyResult = await verifyBackup(backupResult.filePath, encryptionKey);
    assert.equal(verifyResult.valid, true);
    assert.equal(verifyResult.isEncrypted, true);
    assert.equal(verifyResult.tableCount, 2);
    assert.equal(verifyResult.rowCount, 3);

    const encryptedData = await fs.readFile(backupResult.filePath);
    const rawSql = zlib.gunzipSync(decryptBackup(encryptedData, encryptionKey)).toString('utf8');
    await pool.query(rawSql);
    const products = await pool.query('SELECT count(*)::int AS count FROM test_products');
    const orders = await pool.query('SELECT count(*)::int AS count FROM test_orders');
    assert.equal(products.rows[0].count, 2);
    assert.equal(orders.rows[0].count, 1);
    console.log(`Phục hồi đạt: ${products.rows[0].count} sản phẩm và ${orders.rows[0].count} đơn hàng.`);

    const tampered = Buffer.from(encryptedData);
    tampered[40] ^= 0xff;
    const tamperedPath = path.join(testOutputDir, `tampered_${backupResult.fileName}`);
    await fs.writeFile(tamperedPath, tampered);
    await assert.rejects(verifyBackup(tamperedPath, encryptionKey));

    const oldFileName = 'gaeru_db_backup_2026-09-01T00-00-00.sql.gz.enc';
    const oldFilePath = path.join(testOutputDir, oldFileName);
    await fs.writeFile(oldFilePath, 'old backup');
    const oldTime = (Date.now() - 45 * 86400000) / 1000;
    await fs.utimes(oldFilePath, oldTime, oldTime);
    const rotated = await runBackup({
      databaseUrl: 'postgres://backup-fixture.invalid/gaeru',
      dumpDatabase: writeBackupDumpFixture,
      outputDir: testOutputDir,
      encryptionKey,
      retentionDays: 30
    });
    assert.equal(rotated.cleanedCount, 1);

    console.log(`Backup pipeline, integrity check, restore, and retention verified in ${durationMs.toFixed(1)} ms.`);
  } finally {
    await fs.rm(testOutputDir, { recursive: true, force: true });
    await pool.end();
  }
}

if (require.main === module) {
  runLiveVerification()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Verification Failed]', err);
      process.exit(1);
    });
}

module.exports = { runLiveVerification };
