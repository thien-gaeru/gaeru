const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { migrateDatabase, MIGRATION_FILES, verifySchemaHealth, precheckAndQuarantineDuplicates } = require('../src/migrate');

async function createTestDb() {
  const db = await PGlite.create();
  let queue = Promise.resolve();
  async function lock() {
    const previous = queue;
    let release;
    queue = new Promise((r) => { release = r; });
    await previous;
    return release;
  }
  async function query(sql, values) {
    const r = !values && sql.includes(';') ? (await db.exec(sql)).at(-1) : await db.query(sql, values);
    return { ...r, rows: r?.rows || [], rowCount: r?.affectedRows ?? r?.rows?.length ?? 0 };
  }
  return {
    async query(sql, values) {
      const release = await lock();
      try { return await query(sql, values); }
      finally { release(); }
    },
    async connect() {
      const release = await lock();
      return {
        query,
        release
      };
    },
    async close() {
      await db.close();
    }
  };
}

test('Task 1: Precheck độc lập phát hiện và cách ly giao dịch trùng, lưu vĩnh viễn dù migration bị chặn, không xóa giao dịch', async (t) => {
  const pool = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => pool.close());

  // 1. Chạy migration ban đầu để dựng schema chuẩn
  await migrateDatabase(pool);

  // 2. Giả lập tình huống cơ sở dữ liệu production lịch sử trước khi áp dụng v3:
  // - v3 chưa được áp dụng (xóa v3 khỏi schema_migrations)
  // - index đang là index thường không unique chứa bản ghi trùng
  await pool.query("DELETE FROM schema_migrations WHERE name = 'checkout-lifecycle-hardening-v3.sql'");
  await pool.query('DROP INDEX IF EXISTS idx_payment_attempts_provider_request_id');
  await pool.query('CREATE INDEX idx_payment_attempts_provider_request_id ON payment_attempts (provider, provider_request_id)');

  // 3. Tạo một đơn hàng mẫu
  const orderRes = await pool.query(`
    INSERT INTO orders (id, order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method)
    VALUES ('00000000-0000-0000-0000-000000000001', 'GR-DUP-TEST-01', 'Nguyen Van A', 'buyer@gaeru.com', '0912345678', '123 Pho Hue', 'Ha Noi', 150000, 0, 150000, 'pending', 'momo')
    RETURNING id
  `);
  const orderId = orderRes.rows[0].id;

  // 4. Chèn 2 giao dịch trùng lặp provider_request_id trên cùng cổng momo
  await pool.query(`
    INSERT INTO payment_attempts (order_id, provider, provider_request_id, transaction_ref, amount_vnd, status, expires_at)
    VALUES 
      ($1, 'momo', 'MOMO-DUP-999', 'TX-REF-1', 150000, 'pending', now() + interval '15 minutes'),
      ($1, 'momo', 'MOMO-DUP-999', 'TX-REF-2', 150000, 'pending', now() + interval '15 minutes')
  `, [orderId]);

  // 5. Chạy migrateDatabase -> Precheck độc lập PHẢI phát hiện trùng lặp và chặn lại với MIGRATION_BLOCKED
  await assert.rejects(
    async () => { await migrateDatabase(pool); },
    /MIGRATION_BLOCKED.*payment_attempts_quarantine_duplicates/
  );

  // 6. Nghiệm thu: Các bản ghi cách ly trong payment_attempts_quarantine_duplicates VẪN TỒN TẠI (do đã commit transaction độc lập)
  const quarantined = await pool.query('SELECT * FROM payment_attempts_quarantine_duplicates');
  assert.equal(quarantined.rows.length, 2, 'Cả 2 bản ghi trùng phải được lưu vĩnh viễn vào bảng quarantine');
  assert.equal(quarantined.rows[0].provider_request_id, 'MOMO-DUP-999');
  assert.equal(quarantined.rows[1].provider_request_id, 'MOMO-DUP-999');

  // 7. Nghiệm thu: Tuyệt đối KHÔNG tự xóa giao dịch hoặc lịch sử thanh toán trong payment_attempts
  const original = await pool.query('SELECT * FROM payment_attempts WHERE order_id = $1', [orderId]);
  assert.equal(original.rows.length, 2, 'Toàn bộ dữ liệu gốc trong payment_attempts phải được bảo toàn nguyên vẹn');

  // 8. Sau khi dữ liệu được xử lý đối soát (sửa mã 1 bản ghi), migration được phép chạy lại
  await pool.query("UPDATE payment_attempts SET provider_request_id = 'MOMO-RESOLVED-999' WHERE transaction_ref = 'TX-REF-2'");
  await migrateDatabase(pool);

  // 9. Xác nhận sau migration, v3 nâng cấp thành công index lên TRUE UNIQUE INDEX và bảng quarantine vẫn còn dữ liệu phục vụ đối soát
  const finalQuarantine = await pool.query('SELECT * FROM payment_attempts_quarantine_duplicates');
  assert.equal(finalQuarantine.rows.length, 2);

  const finalHealth = await verifySchemaHealth(pool);
  assert.equal(finalHealth.ok, true, 'Hậu kiểm catalog phải pass 100%');
});

test('Task 2: Hậu kiểm UNIQUE INDEX thanh toán theo catalog PostgreSQL, cho phép trùng giữa 2 cổng và chặn trùng trong cùng 1 cổng', async (t) => {
  const pool = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => pool.close());

  // 1. Chạy migration đầy đủ
  await migrateDatabase(pool);

  // 2. Nghiệm thu bằng PostgreSQL catalog:
  // - Đúng bảng payment_attempts
  // - Thuộc tính is_unique = true
  // - Cặp cột chính xác: ['provider', 'provider_request_id']
  // - Điều kiện lọc: provider_request_id IS NOT NULL
  const catalogCheck = await pool.query(`
    SELECT 
      tbl.relname AS table_name,
      idx.relname AS index_name,
      i.indisunique AS is_unique,
      ARRAY(
        SELECT a.attname 
        FROM pg_attribute a 
        WHERE a.attrelid = tbl.oid AND a.attnum = ANY(i.indkey)
        ORDER BY array_position(i.indkey, a.attnum)
      ) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    WHERE idx.relname = 'idx_payment_attempts_provider_request_id'
  `);

  assert.equal(catalogCheck.rows.length, 1, 'Index idx_payment_attempts_provider_request_id phải tồn tại');
  const row = catalogCheck.rows[0];
  assert.equal(row.table_name, 'payment_attempts');
  assert.equal(row.is_unique, true, 'Phải là TRUE UNIQUE INDEX');
  assert.deepEqual(row.columns, ['provider', 'provider_request_id'], 'Chỉ mục phải bao gồm chính xác cặp cột (provider, provider_request_id)');
  assert.match(row.predicate, /provider_request_id IS NOT NULL/, 'Chỉ mục phải có điều kiện lọc provider_request_id IS NOT NULL');

  // 3. Tạo 2 đơn hàng mẫu
  const o1 = (await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method)
    VALUES ('GR-INDEX-01', 'Khach A', 'b1@gaeru.com', '0912345678', '123 Pho Hue', 'Ha Noi', 100000, 0, 100000, 'pending', 'momo') RETURNING id
  `)).rows[0].id;
  const o2 = (await pool.query(`
    INSERT INTO orders (order_number, customer_name, email, phone, address, city, subtotal_vnd, shipping_fee_vnd, total_vnd, status, payment_method)
    VALUES ('GR-INDEX-02', 'Khach B', 'b2@gaeru.com', '0912345678', '123 Pho Hue', 'Ha Noi', 100000, 0, 100000, 'pending', 'zalopay') RETURNING id
  `)).rows[0].id;

  // 4. Nghiệm thu hành vi dữ liệu:
  // - Hai mã giống nhau ở hai cổng khác nhau (momo vs zalopay) được xử lý thành công theo chính sách định danh
  await pool.query(`
    INSERT INTO payment_attempts (order_id, provider, provider_request_id, transaction_ref, amount_vnd, expires_at)
    VALUES ($1, 'momo', 'CROSS-PROVIDER-01', 'REF-MOMO-1', 100000, now() + interval '15 minutes');
  `, [o1]);

  await pool.query(`
    INSERT INTO payment_attempts (order_id, provider, provider_request_id, transaction_ref, amount_vnd, expires_at)
    VALUES ($1, 'zalopay', 'CROSS-PROVIDER-01', 'REF-ZALO-1', 100000, now() + interval '15 minutes');
  `, [o2]);

  // - Hai yêu cầu trùng mã trong cùng một cổng (momo vs momo) bị CHẶN bởi UNIQUE constraint
  await assert.rejects(
    async () => {
      await pool.query(`
        INSERT INTO payment_attempts (order_id, provider, provider_request_id, transaction_ref, amount_vnd, expires_at)
        VALUES ($1, 'momo', 'CROSS-PROVIDER-01', 'REF-MOMO-2', 100000, now() + interval '15 minutes');
      `, [o1]);
    },
    /duplicate key value violates unique constraint/
  );

  // - verifySchemaHealth xác nhận pass
  const health = await verifySchemaHealth(pool);
  assert.equal(health.ok, true);
});

test('Task 3: Kiểm soát thay đổi migration đã triển khai, phát hiện và chặn sai lệch checksum', async (t) => {
  const pool = await createTestDb();
  if (t && typeof t.after === 'function') t.after(() => pool.close());

  // 1. Chạy migration ban đầu
  await migrateDatabase(pool);

  // 2. Giả lập cơ sở dữ liệu có lịch sử migration bị sai lệch checksum (ví dụ tệp schema.sql bị sửa đổi sau khi triển khai)
  await pool.query(`
    UPDATE schema_migrations 
    SET checksum = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    WHERE name = 'schema.sql'
  `);

  // 3. Nghiệm thu: Database có lịch sử migration khác mã nguồn KHÔNG được tự động coi là hợp lệ -> Phải bị chặn với MIGRATION_CHECKSUM_MISMATCH
  await assert.rejects(
    async () => { await migrateDatabase(pool); },
    /MIGRATION_CHECKSUM_MISMATCH.*schema\.sql/
  );
});
