'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createTestDb } = require('./helpers/pglite-db');
const { runBackup, decryptBackup, verifyBackup } = require('../scripts/backup-database');
const { backupDumpFixture, writeBackupDumpFixture } = require('./helpers/backup-dump-fixture');

test('Database Backup: Live SQL dump, Gzip compression, AES-256-GCM encryption, integrity verification, and retention rotation', async (t) => {
  const testOutputDir = path.join(__dirname, '..', '.local-data', 'test-suite-backup-' + Date.now());
  const encryptionKey = 'GaeruTestBackupKey_2026_TopSecret!';
  const { pool } = await createTestDb({ migrate: false });

  // Tạo bảng mẫu
  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_products (
      id serial PRIMARY KEY,
      sku text NOT NULL UNIQUE,
      name text NOT NULL,
      price numeric NOT NULL,
      active boolean NOT NULL DEFAULT true,
      meta jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS test_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      total integer NOT NULL
    );
  `);

  await pool.query(`
    INSERT INTO test_products (sku, name, price, active, meta) VALUES
    ('SP-01', 'Sản phẩm 1', 100000, true, '{"tag": "new"}'::jsonb),
    ('SP-02', 'Sản phẩm 2', 200000, false, '{"tag": "sale"}'::jsonb);

    INSERT INTO test_orders (code, total) VALUES
    ('ORD-001', 300000);
  `);

  t.after(async () => {
    await fs.rm(testOutputDir, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
  });

  await t.test('1. Complete pg_dump-format fixture includes schema and row data', async () => {
    assert.match(backupDumpFixture, /CREATE TABLE public\.test_products/);
    assert.match(backupDumpFixture, /CREATE TABLE public\.test_orders/);
    assert.match(backupDumpFixture, /INSERT INTO public\.test_products/);
    assert.match(backupDumpFixture, /INSERT INTO public\.test_orders/);
    assert.match(backupDumpFixture, /SP-01/);
    assert.match(backupDumpFixture, /ORD-001/);
  });

  await t.test('2. runBackup compresses and encrypts the complete pg_dump output', async () => {
    const res = await runBackup({
      databaseUrl: 'postgres://backup-fixture.invalid/gaeru',
      dumpDatabase: writeBackupDumpFixture,
      outputDir: testOutputDir,
      encryptionKey,
      retentionDays: 30
    });

    assert.equal(res.success, true);
    assert.equal(res.isEncrypted, true);
    assert.ok(res.sizeBytes > 0);
    assert.ok(res.sizeBytes < res.uncompressedSizeBytes);
    assert.ok(res.filePath.endsWith('.sql.gz.enc'));

    const fileExists = await fs.stat(res.filePath).then(() => true).catch(() => false);
    assert.equal(fileExists, true);
  });

  await t.test('3. verifyBackup successfully decrypts, gunzips and verifies data integrity', async () => {
    const files = await fs.readdir(testOutputDir);
    const backupFile = files.find(f => f.endsWith('.sql.gz.enc'));
    assert.ok(backupFile);

    const verified = await verifyBackup(path.join(testOutputDir, backupFile), encryptionKey);
    assert.equal(verified.valid, true);
    assert.equal(verified.isEncrypted, true);
    assert.equal(verified.tableCount, 2);
    assert.equal(verified.rowCount, 3);

    const encrypted = await fs.readFile(path.join(testOutputDir, backupFile));
    const rawSql = zlib.gunzipSync(decryptBackup(encrypted, encryptionKey)).toString('utf8');
    await pool.query(rawSql);
    const restoredProducts = await pool.query('SELECT count(*)::int AS count FROM test_products');
    const restoredOrders = await pool.query('SELECT count(*)::int AS count FROM test_orders');
    assert.equal(restoredProducts.rows[0].count, 2);
    assert.equal(restoredOrders.rows[0].count, 1);
  });

  await t.test('4. Tampered encrypted backup is rejected by AES-256-GCM authentication tag', async () => {
    const files = await fs.readdir(testOutputDir);
    const backupFile = files.find(f => f.endsWith('.sql.gz.enc'));
    const filePath = path.join(testOutputDir, backupFile);

    const originalData = await fs.readFile(filePath);
    const corrupted = Buffer.from(originalData);
    corrupted[35] = corrupted[35] ^ 0x01; // flip 1 bit

    const corruptPath = path.join(testOutputDir, 'corrupt_' + backupFile);
    await fs.writeFile(corruptPath, corrupted);

    await assert.rejects(
      async () => verifyBackup(corruptPath, encryptionKey),
      /unable to authenticate data|Unsupported state/i
    );
  });

  await t.test('5. Retention rotation deletes backups older than retentionDays', async () => {
    // Tạo 1 file cũ 60 ngày
    const oldFileName = 'gaeru_db_backup_2026-08-01T00-00-00.sql.gz.enc';
    const oldFilePath = path.join(testOutputDir, oldFileName);
    await fs.writeFile(oldFilePath, Buffer.from('dummy-old-backup'));
    const oldTime = (Date.now() - 60 * 86400000) / 1000;
    await fs.utimes(oldFilePath, oldTime, oldTime);

    const res = await runBackup({
      databaseUrl: 'postgres://backup-fixture.invalid/gaeru',
      dumpDatabase: writeBackupDumpFixture,
      outputDir: testOutputDir,
      encryptionKey,
      retentionDays: 30
    });

    assert.ok(res.cleanedCount >= 1);
    const remaining = await fs.readdir(testOutputDir);
    assert.equal(remaining.includes(oldFileName), false);
  });

  await t.test('6. Invalid SQL-only dumps are rejected and temporary files are removed', async () => {
    await assert.rejects(
      runBackup({
        databaseUrl: 'postgres://backup-fixture.invalid/gaeru',
        dumpDatabase: async () => '-- Table: "test_products"\nINSERT INTO test_products (sku) VALUES (\'SP-01\');',
        outputDir: testOutputDir,
        encryptionKey
      }),
      /không tạo được bản sao lưu có schema bảng/
    );
    const remaining = await fs.readdir(testOutputDir);
    assert.equal(remaining.some((file) => file.startsWith('.gaeru-backup-')), false);
  });

  await t.test('7. verifyBackup rejects a compressed file without database schema', async () => {
    const invalidPath = path.join(testOutputDir, 'select-only.sql.gz');
    await fs.writeFile(invalidPath, zlib.gzipSync('-- Table: "test_products"\nINSERT INTO test_products (sku) VALUES (\'SP-01\');'));
    await assert.rejects(
      verifyBackup(invalidPath),
      /không có định nghĩa bảng PostgreSQL/
    );
  });

  await t.test('8. Failed dump removes partial plaintext and does not create a backup', async () => {
    await assert.rejects(
      runBackup({
        databaseUrl: 'postgres://backup-fixture.invalid/gaeru',
        dumpDatabase: async ({ outputPath }) => {
          await fs.writeFile(outputPath, 'partial SQL');
          throw new Error('simulated pg_dump failure');
        },
        outputDir: testOutputDir,
        encryptionKey
      }),
      /simulated pg_dump failure/
    );
    const remaining = await fs.readdir(testOutputDir);
    assert.equal(remaining.some((file) => file.startsWith('.gaeru-backup-')), false);
  });
});
