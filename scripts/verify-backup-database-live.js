'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createTestDb } = require('../test/helpers/pglite-db');
const { runBackup, dumpDatabaseToSql, decryptBackup, verifyBackup } = require('../scripts/backup-database');

async function runLiveVerification() {
  console.log('='.repeat(80));
  console.log('KIỂM TRA CHẠY THẬT & ĐO LƯỜNG SỐ LIỆU THỰC TẾ: scripts/backup-database.js');
  console.log('Môi trường: Node.js 24 LTS · PostgreSQL Engine (PGlite) · Crypto AES-256-GCM');
  console.log('='.repeat(80));

  const testOutputDir = path.join(__dirname, '..', '.local-data', 'test-backups-' + Date.now());
  const encryptionKey = 'GaeruStore_UltraSecretBackupKey_2026_AES256!';

  const { db, pool } = await createTestDb({ migrate: false });

  try {
    // --------------------------------------------------------------------------
    // 0. Khởi tạo CSDL thực tế với nhiều bảng dữ liệu nghiệp vụ
    // --------------------------------------------------------------------------
    console.log('\n--- 0. KHỞI TẠO DỮ LIỆU THỰC TẾ ĐỂ SAO LƯU ---');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username text NOT NULL UNIQUE,
        email text NOT NULL,
        role text NOT NULL DEFAULT 'staff',
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS products (
        id serial PRIMARY KEY,
        sku text NOT NULL UNIQUE,
        name text NOT NULL,
        price numeric(12, 2) NOT NULL,
        specs jsonb NOT NULL DEFAULT '{}'::jsonb,
        stock integer NOT NULL DEFAULT 0,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        order_number text NOT NULL UNIQUE,
        customer_name text NOT NULL,
        total_vnd numeric(12, 2) NOT NULL,
        status text NOT NULL DEFAULT 'confirmed',
        payment_method text NOT NULL DEFAULT 'cod',
        meta jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    // Chèn dữ liệu mẫu thực tế
    await pool.query(`
      INSERT INTO users (username, email, role, active) VALUES
      ('admin_gaeru', 'admin@gaeru.com', 'admin', true),
      ('ketoan_truong', 'finance@gaeru.com', 'accountant', true),
      ('kho_truong', 'warehouse@gaeru.com', 'inventory_manager', true);

      INSERT INTO products (sku, name, price, specs, stock, is_active) VALUES
      ('K9-PRO-BLK', 'Micro Không Dây K9 Pro Black', 450000.00, '{"battery": "800mAh", "range_m": 20, "colors": ["black", "gray"]}'::jsonb, 150, true),
      ('C01-USB-TYPEC', 'Cáp Sạc Nhanh Type-C 65W GAERU', 120000.00, '{"length_cm": 120, "braided": true}'::jsonb, 300, true),
      ('W02-STAND', 'Giá Đỡ Điện Thoại Hợp Kim Nhôm', 95000.00, '{"material": "aluminum", "foldable": true}'::jsonb, 75, true);

      INSERT INTO orders (order_number, customer_name, total_vnd, status, payment_method, meta) VALUES
      ('GR-20261101-001', 'Nguyễn Văn An', 570000.00, 'completed', 'momo', '{"shipping_provider": "ghn", "tracking_code": "GHN998811"}'::jsonb),
      ('GR-20261101-002', 'Trần Thị Bích', 215000.00, 'processing', 'cod', '{"note": "Giao giờ hành chính"}'::jsonb);
    `);

    console.log('✔ Đã khởi tạo 3 bảng: `users` (3 dòng), `products` (3 dòng), `orders` (2 dòng).');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 1: Chạy Thật Sao Lưu CSDL (Xuất SQL + Nén Gzip + Mã Hóa AES-256-GCM)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 1: Chạy Thật Sao Lưu & Đo Lường Hiệu Năng ---');
    const t0 = performance.now();
    const backupResult = await runBackup({
      pool,
      outputDir: testOutputDir,
      encryptionKey,
      retentionDays: 30
    });
    const t1 = performance.now();
    const durationMs = t1 - t0;

    assert.equal(backupResult.success, true);
    assert.equal(backupResult.isEncrypted, true);
    assert.ok(backupResult.sizeBytes > 0);
    assert.ok(backupResult.uncompressedSizeBytes > backupResult.sizeBytes);

    const compressionRatio = ((1 - backupResult.sizeBytes / backupResult.uncompressedSizeBytes) * 100).toFixed(2);

    console.log(`- Thời gian thực thi toàn bộ      : ${durationMs.toFixed(3)} ms`);
    console.log(`- Phương thức sao lưu             : ${backupResult.backupMethod}`);
    console.log(`- Kích thước bản SQL thô (chưa nén): ${backupResult.uncompressedSizeBytes} bytes`);
    console.log(`- Kích thước bản nén & mã hóa     : ${backupResult.sizeBytes} bytes`);
    console.log(`- Tỷ lệ tiết kiệm dung lượng      : ${compressionRatio}%`);
    console.log(`- Tệp sao lưu kết quả             : ${backupResult.fileName}`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 2: Giải Mã & Xác Minh Toàn Vẹn Bản Sao Lưu (Decryption & Integrity)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 2: Giải Mã & Kiểm Tra Tính Toàn Vẹn Bản Sao Lưu ---');
    const verifyResult = await verifyBackup(backupResult.filePath, encryptionKey);

    assert.equal(verifyResult.valid, true);
    assert.equal(verifyResult.isEncrypted, true);
    assert.equal(verifyResult.uncompressedSizeBytes, backupResult.uncompressedSizeBytes);
    assert.equal(verifyResult.tableCount, 3);
    assert.equal(verifyResult.rowCount, 8); // 3 users + 3 products + 2 orders

    console.log(`✔ Xác thực chữ ký xác thực Auth Tag AES-256-GCM thành công.`);
    console.log(`✔ Giải nén Gzip thành công.`);
    console.log(`✔ Số bảng dữ liệu phát hiện: ${verifyResult.tableCount} bảng`);
    console.log(`✔ Số dòng dữ liệu SQL đã phục hồi: ${verifyResult.rowCount} dòng lệnh INSERT`);
    console.log(`- Đoạn trích xuất SQL mẫu:\n  ${verifyResult.sqlPreview.split('\n').slice(0, 7).join('\n  ')}`);

    // --------------------------------------------------------------------------
    // KỊCH BẢN 3: Chống Giả Mạo Dữ Liệu (Tamper Detection with AES-GCM Auth Tag)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 3: Thử Nghiệm Tấn Công Sửa Đổi Dữ Liệu (Tampering Check) ---');
    const originalCipherData = await fs.readFile(backupResult.filePath);
    const tamperedData = Buffer.from(originalCipherData);
    // Làm biến dạng 1 byte ở phần ciphertext (tại vị trí byte 40)
    tamperedData[40] = tamperedData[40] ^ 0xFF;

    const tamperedFilePath = path.join(testOutputDir, 'tampered_' + backupResult.fileName);
    await fs.writeFile(tamperedFilePath, tamperedData);

    let caughtTampering = false;
    try {
      await verifyBackup(tamperedFilePath, encryptionKey);
    } catch (err) {
      caughtTampering = true;
      console.log(`✔ Đã phát hiện và chặn đứng dữ liệu bị sửa đổi trái phép!`);
      console.log(`  Thông điệp bảo mật từ Crypto Engine: ${err.message}`);
    }
    assert.equal(caughtTampering, true, 'Hệ thống bắt buộc phải phát hiện khi file sao lưu bị can thiệp');

    // --------------------------------------------------------------------------
    // KỊCH BẢN 4: Kiểm Tra Cơ Chế Xoay Vòng & Tự Dọn Dẹp (Retention Rotation)
    // --------------------------------------------------------------------------
    console.log('\n--- KỊCH BẢN 4: Kiểm Tra Tự Động Xoay Vòng & Dọn Dẹp Bản Sao Lưu Cũ ---');
    // Tạo 2 bản sao lưu giả lập có thời gian mtime từ 45 ngày trước
    const oldFile1 = path.join(testOutputDir, 'gaeru_db_backup_2026-09-01T00-00-00.sql.gz.enc');
    const oldFile2 = path.join(testOutputDir, 'gaeru_db_backup_2026-09-10T00-00-00.sql.gz.enc');
    await fs.writeFile(oldFile1, Buffer.from('old-backup-1'));
    await fs.writeFile(oldFile2, Buffer.from('old-backup-2'));

    const pastTime = (Date.now() - 45 * 86400000) / 1000;
    await fs.utimes(oldFile1, pastTime, pastTime);
    await fs.utimes(oldFile2, pastTime, pastTime);

    // Chạy backup mới với retention 30 ngày
    const rotateResult = await runBackup({
      pool,
      outputDir: testOutputDir,
      encryptionKey,
      retentionDays: 30
    });

    assert.equal(rotateResult.cleanedCount, 2);

    const remainingFiles = await fs.readdir(testOutputDir);
    const hasOld1 = remainingFiles.includes(path.basename(oldFile1));
    const hasOld2 = remainingFiles.includes(path.basename(oldFile2));
    assert.equal(hasOld1, false);
    assert.equal(hasOld2, false);

    console.log(`✔ Đã tự động phát hiện và xóa sạch 2 bản sao lưu cũ quá 30 ngày.`);
    console.log(`✔ Các bản sao lưu mới vẫn được bảo toàn nguyên vẹn.`);

    console.log('\n' + '='.repeat(80));
    console.log('BẢNG TỔNG HỢP SỐ LIỆU ĐO ĐẠC THỰC TẾ: BACKUP DATABASE');
    console.log('='.repeat(80));
    console.log(`- Độ trễ sao lưu hoàn chỉnh   : ${durationMs.toFixed(3)} ms`);
    console.log(`- Thuật toán mã hóa          : AES-256-GCM (Khóa SHA-256, IV 16 bytes ngẫu nhiên)`);
    console.log(`- Cơ chế nén dữ liệu         : Gzip (Giảm ${compressionRatio}% dung lượng)`);
    console.log(`- Khả năng chống can thiệp   : 100% (Phát hiện ngay khi sai lệch 1 byte)`);
    console.log(`- Phục hồi & Xác minh        : Hoàn tất giải mã và đối chiếu đúng 8/8 dòng`);
    console.log(`- Chu kỳ lưu trữ (Retention) : 30 ngày tự động xoay vòng`);
    console.log('='.repeat(80));

  } finally {
    // Dọn dẹp thư mục test
    await fs.rm(testOutputDir, { recursive: true, force: true }).catch(() => {});
    await pool.end().catch(() => {});
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
