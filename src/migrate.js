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
      ON CONFLICT DO NOTHING
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
    if (!idxCheck?.rows?.length) {
      throw new Error('SCHEMA_HEALTH_FAILED: Không tìm thấy chỉ mục idx_payment_attempts_provider_request_id trên bảng payment_attempts.');
    }
    const row = idxCheck.rows[0];
    const hasExactCols = Array.isArray(row.columns) && row.columns.length === 2 && row.columns[0] === 'provider' && row.columns[1] === 'provider_request_id';
    const hasPredicate = typeof row.predicate === 'string' && row.predicate.includes('provider_request_id IS NOT NULL');
    if (!row.is_unique || !hasExactCols || !hasPredicate) {
      throw new Error(
        `SCHEMA_HEALTH_FAILED: idx_payment_attempts_provider_request_id không thỏa mãn catalog chuẩn: ` +
        `table=${row.table_name}, unique=${row.is_unique}, columns=${JSON.stringify(row.columns)}, predicate=${row.predicate}. ` +
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
module.exports = { migrateDatabase, MIGRATION_FILES, verifySchemaHealth, precheckAndQuarantineDuplicates };
