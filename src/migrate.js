require("dotenv").config();
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { loadConfig } = require("./config");
const { createPool } = require("./db");

const MIGRATION_FILES = Object.freeze([
  "schema.sql",
  "access.sql",
  "operations.sql",
  "finance.sql",
  "customer-experience.sql",
  "care.sql",
  "warranty.sql",
  "business.sql",
  "warranty-channels.sql",
  "care-channels.sql",
  "contact-changes.sql",
  "news.sql",
  "account-security.sql",
  "product-workspace.sql",
  "care-messages.sql",
  "admin-experience.sql",
  "account-retention.sql",
  "account-contact-only.sql",
  "bot-warranty-deletion.sql",
  "warranty-purchase-date.sql",
  "marketing.sql",
  "product-promotions.sql",
  "email-marketing.sql",
  "admin-login-aliases.sql",
  "warranty-resubmission.sql",
  "marketing-banners.sql",
  "security-hardening.sql",
  "product-card-copy.sql",
  "shopping-chat.sql",
  "shopping-chat-media.sql",
  "shopping-chat-email.sql",
  "shopping-chat-ai-first.sql",
  "product-deletion.sql",
  "shopping-chat-handoff.sql",
  "product-trash.sql",
  "primary-media-storage.sql",
  "checkout-account-email.sql",
  "order-review.sql",
  "order-after-sales.sql",
  "shipping-choice.sql",
  "site-pages.sql",
  "hostinger-media-migration.sql",
  "file-library.sql",
  "site-asset-snapshots.sql",
  "payment-channels.sql",
  "domain-gaeru-com.sql",
  "shopping-chat-unlimited-compression.sql",
  "source-audit-upload.sql",
  "payment-provider-verification.sql",
  "shopping-chat-file-retention.sql",
  "order-restoration.sql",
  "channel-reports-ads.sql",
  "channel-report-snapshot-safety.sql",
  "misa-einvoice.sql",
  "shopee-express-shipping.sql",
  "oauth-social-login.sql",
  "visitor-traffic.sql",
  "customer-lifecycle-filter.sql",
  "customer-reg-email-lifecycle.sql",
  "order-permanent-deletion.sql",
  "platform-upgrades.sql",
  "platform-upgrades-phase2.sql",
  "platform-upgrades-phase3.sql",
  "omnichannel-idempotency.sql",
  "payment-reconciliation-states.sql",
  "audit-hardening.sql",
  "checkout-lifecycle-hardening.sql",
  "checkout-lifecycle-hardening-v2.sql",
  "checkout-lifecycle-hardening-v3.sql"
]);

const APPROVED_MIGRATION_CHECKSUMS = Object.freeze({
  'audit-hardening.sql': [
    '0fdf9bd5f3f2d63c27cba3cc9015a93508649880138b46ef137329cef98bd09a',
    '9111449e1b42ab4d5b00d2034f70700cf44766e1d8ad727e0e39da32dd9fc928',
    'a61b815483aaf1eacf3ae7ce8c57a3cb0dd81df928f992c02d1a1a370df87544',
    'f2a423a4cba175f81223f703558fc0f5204f3d84603a17bdd4efd266b5ae51e5',
    '122b4241264b09e7fde0b85adbf26d409b29662d9b8b63bd43a844049fc6a692'
  ],
  'checkout-lifecycle-hardening.sql': [
    '3004da13a82767ebedf3835c4580b85a24ac07be833becbeb13606d5dfc6f788',
    '1776b8b2fa4700c178d240378abf06d2daba60f5bdcec1d78a25c69ac254b8b2'
  ],
  'omnichannel-idempotency.sql': [
    '32848f42bdd99d128138a11b48f0d4cf7b8f72c7acf2fa4cb771df97b4ca7ed3',
    '86e1f5e30b1f61c70bc89a3eefffa70e6c20afd017ad67a52bd464d5fb4d3036'
  ],
  'payment-channels.sql': [
    'e9b7866939d3b60fb11b340e53c8b0e5c3b0c701e954e456e0fff5c21dee2912',
    '9b8d0feb4aeb015e331cebca026623219ef07a4936568657723f2d7ddbf46a9a'
  ],
  'payment-reconciliation-states.sql': [
    'ba416ccc490e81e61df3a6ca07924c9d20a30299c5b633f5e111fc924cc12420',
    'dfb7c4144387de486dd6a75d5369e77217fcc418e808570238d1d39e2a8f6bbc'
  ],
  'precheck-checkout-lifecycle.sql': [
    '6ebe6460abfe1c1e3569efbf97f5f43dfd21ef250c5da56db0f09a7611ff0612',
    '819003af7e03fa0d2c958beb2b22e7fa6b8ff5236e4885a4ff1620e6887eba86'
  ],
  'schema.sql': [
    'f8036909d1c1bea6e39c9b4f50d55b892b0d99ea4047b05b0ad911fb2ea3962b',
    'bbfdd27a05580dbf424596db1921e7b62069b1ae02ae50b6e9cca72c1eafb2f2',
    '01477d8bf01122d075ee3b1cf49263688f6730874c7cb31e9c1aa64697208d78',
    '67896ab21f30ec26b0ccd462e6009d5487ec945a1756ca0a8d7f7cc3e7a9d01f'
  ],
  'shipping-choice.sql': [
    '124c25336836f0c9c66ec8a13d3a2e1b49a5aba9d3a9f6938ca9cbc6e08a7bcf',
    'e629945efaf22f1d6d2ac984d3db80adfe2426b12450098647abd2fb1749ecfd'
  ]
});

async function precheckAndQuarantineDuplicates(pool) {
  const client = typeof pool?.connect === 'function' ? await pool.connect() : pool;
  try {
    const paTable = await client.query("SELECT to_regclass('payment_attempts') AS tbl");
    if (!paTable?.rows?.[0]?.tbl) return { hasDuplicates: false, count: 0 };

    // Tạo bảng cách ly trong transaction riêng biệt độc lập
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_attempts_quarantine_duplicates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        attempt_id uuid NOT NULL,
        order_id uuid NOT NULL,
        provider text NOT NULL,
        provider_request_id text NOT NULL,
        transaction_ref text,
        amount_vnd bigint,
        status text,
        quarantined_at timestamptz NOT NULL DEFAULT now(),
        reason text NOT NULL DEFAULT 'duplicate_provider_request_id'
      )
    `);

    // Dọn dẹp các bản ghi trùng cũ (nếu có) trước khi tạo UNIQUE INDEX để không chặn migration
    await client.query(`
      DELETE FROM payment_attempts_quarantine_duplicates a
      USING payment_attempts_quarantine_duplicates b
      WHERE a.ctid < b.ctid AND a.attempt_id = b.attempt_id
    `).catch(() => {});

    // Tạo UNIQUE INDEX trên attempt_id để chống ghi cách ly trùng tuyệt đối
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_quarantine_attempt_id
      ON payment_attempts_quarantine_duplicates (attempt_id)
    `);

    // Kiểm tra trùng lặp trên cặp (provider, provider_request_id)
    const dupGroups = await client.query(`
      SELECT provider, provider_request_id, count(*) AS cnt
      FROM payment_attempts
      WHERE provider_request_id IS NOT NULL
      GROUP BY provider, provider_request_id
      HAVING count(*) > 1
    `);

    if (dupGroups.rows.length === 0) {
      await client.query("COMMIT");
      return { hasDuplicates: false, count: 0 };
    }

    // Ghi dữ liệu cách ly để đối soát, tuyệt đối không xóa dữ liệu gốc
    await client.query(`
      INSERT INTO payment_attempts_quarantine_duplicates (
        attempt_id, order_id, provider, provider_request_id, transaction_ref, amount_vnd, status, reason
      )
      SELECT 
        pa.id, pa.order_id, pa.provider, pa.provider_request_id, pa.transaction_ref, pa.amount_vnd, pa.status,
        'Trùng lặp khóa (provider, provider_request_id) phát hiện trong bước tiền kiểm precheck độc lập'
      FROM payment_attempts pa
      WHERE (pa.provider, pa.provider_request_id) IN (
        SELECT provider, provider_request_id
        FROM payment_attempts
        WHERE provider_request_id IS NOT NULL
        GROUP BY provider, provider_request_id
        HAVING count(*) > 1
      )
      ON CONFLICT (attempt_id) DO NOTHING
    `);

    // COMMIT transaction riêng để dữ liệu cách ly được lưu vĩnh viễn dù migration sau đó bị chặn
    await client.query("COMMIT");

    return {
      hasDuplicates: true,
      count: dupGroups.rows.length,
      groups: dupGroups.rows
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (typeof client?.release === 'function') client.release();
  }
}

async function verifySchemaHealth(client) {
  // P1-01, P1-02 & Task 2: Hậu kiểm chính xác UNIQUE INDEX bằng PostgreSQL catalog
  if (typeof client?.query !== 'function') return { ok: true };
  const paTable = await client.query("SELECT to_regclass('payment_attempts') AS tbl");
  if (paTable?.rows?.[0]?.tbl) {
    const idxCheck = await client.query(`
      SELECT 
        tbl.relname AS table_name,
        idx.relname AS index_name,
        i.indisunique AS is_unique,
        ARRAY(
          SELECT a.attname::text 
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
    if (!idxCheck?.rows?.length) {
      throw new Error('SCHEMA_HEALTH_FAILED: Không tìm thấy chỉ mục idx_payment_attempts_provider_request_id trên bảng payment_attempts.');
    }
    const row = idxCheck.rows[0];
    const rawCols = Array.isArray(row.columns)
      ? row.columns
      : String(row.columns || '').replace(/^\{|\}$/g, '').split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const hasExactCols = Array.isArray(rawCols) && rawCols.length === 2 && rawCols[0] === 'provider' && rawCols[1] === 'provider_request_id';
    const hasPredicate = typeof row.predicate === 'string' && row.predicate.includes('provider_request_id IS NOT NULL');
    if (!row.is_unique || !hasExactCols || !hasPredicate) {
      throw new Error(
        `SCHEMA_HEALTH_FAILED: idx_payment_attempts_provider_request_id không thỏa mãn catalog chuẩn: ` +
        `table=${row.table_name}, unique=${row.is_unique}, columns=${JSON.stringify(rawCols)}, predicate=${row.predicate}. ` +
        `Yêu cầu: TRUE UNIQUE INDEX trên bảng payment_attempts với cặp cột (provider, provider_request_id) và điều kiện provider_request_id IS NOT NULL.`
      );
    }
  }
  return { ok: true };
}

async function migrateDatabase(pool) {
  // 1. Tiền kiểm độc lập phát hiện và cách ly trùng lặp trước khi chạy migration
  const precheck = await precheckAndQuarantineDuplicates(pool);
  if (precheck.hasDuplicates) {
    throw new Error(
      `MIGRATION_BLOCKED: Phát hiện ${precheck.count} nhóm bản ghi trùng lặp (provider, provider_request_id) trong payment_attempts. ` +
      `Dữ liệu đã được cách ly độc lập và lưu vĩnh viễn vào payment_attempts_quarantine_duplicates để phục vụ đối soát. ` +
      `Quá trình migration bị chặn cho đến khi dữ liệu được xử lý dứt điểm.`
    );
  }

  const client = typeof pool?.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:database-migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), checksum text)");
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");

    for (const file of MIGRATION_FILES) {
      const schema = await fs.readFile(path.join(__dirname, "..", "db", file), "utf8");
      const fileChecksum = createHash("sha256").update(schema, "utf8").digest("hex");

      const applied = await client.query("SELECT name, checksum FROM schema_migrations WHERE name=$1", [file]);
      if (applied.rows.length) {
        const storedChecksum = applied.rows[0].checksum;
        if (storedChecksum && storedChecksum !== fileChecksum) {
          const approved = APPROVED_MIGRATION_CHECKSUMS[file] || [];
          if (approved.includes(storedChecksum)) {
            console.log(`[MIGRATION] Tệp migration "${file}" khớp phiên bản lịch sử chính thức đã phê duyệt (${storedChecksum.slice(0, 8)}).`);
            continue;
          }
          // Task 3: Chặn triển khai các trường hợp sai lệch checksum; không sửa trực tiếp migration đã phát hành
          throw new Error(
            `MIGRATION_CHECKSUM_MISMATCH: Tệp migration "${file}" đã bị sửa đổi sau khi áp dụng vào cơ sở dữ liệu. ` +
            `(DB: ${storedChecksum}, Tệp: ${fileChecksum}). ` +
            `Không được sửa trực tiếp migration đã phát hành; hãy tạo migration bổ sung mới để thay đổi schema.`
          );
        } else if (!storedChecksum) {
          await client.query("UPDATE schema_migrations SET checksum=$2 WHERE name=$1 AND checksum IS NULL", [file, fileChecksum]);
        }
        continue;
      }

      await client.query(schema);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, fileChecksum]);
    }

    await verifySchemaHealth(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (typeof client?.release === 'function') client.release();
  }
}

async function main() {
  const pool = createPool(loadConfig());
  try { await migrateDatabase(pool); console.log("Database schema is up to date."); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => {
  console.error("Database migration failed:", error.message); process.exitCode = 1;
});
module.exports = { migrateDatabase, MIGRATION_FILES, verifySchemaHealth, precheckAndQuarantineDuplicates, APPROVED_MIGRATION_CHECKSUMS };
