'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { createTestDb } = require('./helpers/pglite-db');
const { runBackup, dumpDatabaseToSql, dumpWithPgDump, decryptBackup, verifyBackup } = require('../scripts/backup-database');

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

  await t.test('1. Native SQL Dump exports schema and row INSERT statements', async () => {
    const rawSql = await dumpDatabaseToSql(pool);
    assert.match(rawSql, /-- Table: "test_products"/);
    assert.match(rawSql, /-- Table: "test_orders"/);
    assert.match(rawSql, /INSERT INTO "public"\."test_products"/);
    assert.match(rawSql, /INSERT INTO "public"\."test_orders"/);
    assert.match(rawSql, /CREATE TABLE IF NOT EXISTS "public"\."test_products"/);
    assert.match(rawSql, /ADD CONSTRAINT .*PRIMARY KEY/);
    assert.match(rawSql, /ADD CONSTRAINT .*UNIQUE/);
    assert.match(rawSql, /SP-01/);
    assert.match(rawSql, /ORD-001/);
  });

  await t.test('2. runBackup executes Gzip compression and AES-256-GCM encryption', async () => {
    const res = await runBackup({
      pool,
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
  });

  await t.test('3a. verifyBackup rejects empty, non-SQL, and incomplete dumps', async () => {
    const invalidPath = path.join(testOutputDir, 'invalid.sql.gz');
    await fs.mkdir(testOutputDir, { recursive: true });
    await fs.writeFile(invalidPath, zlib.gzipSync(Buffer.from('this is not a SQL backup')));
    await assert.rejects(verifyBackup(invalidPath), /CREATE TABLE schema/);

    await fs.writeFile(invalidPath, zlib.gzipSync(Buffer.from(
      'BEGIN;\nCREATE TABLE public.partial (id integer);\n-- Data for "partial": 0 rows\n'
    )));
    await assert.rejects(verifyBackup(invalidPath), /incomplete|completion marker/);
  });

  await t.test('3b. pg_dump temporary file and private directory are removed when the command fails', async () => {
    const tempDir = path.join(__dirname, '..', '.local-data', 'test-pg-dump-' + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
    t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
    await assert.rejects(
      dumpWithPgDump('postgres://fixture.invalid/database', {
        tempDir,
        commandRunner: async (_command, args) => {
          const outputPath = args[args.indexOf('-f') + 1];
          await fs.writeFile(outputPath, 'partial dump');
          throw Object.assign(new Error('simulated pg_dump failure'), { code: 'EFAIL' });
        }
      }),
      /simulated pg_dump failure/
    );
    assert.deepEqual(await fs.readdir(tempDir), []);
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
      pool,
      outputDir: testOutputDir,
      encryptionKey,
      retentionDays: 30
    });

    assert.ok(res.cleanedCount >= 1);
    const remaining = await fs.readdir(testOutputDir);
    assert.equal(remaining.includes(oldFileName), false);
  });
});
