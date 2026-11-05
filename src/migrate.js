require("dotenv").config();
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadConfig } = require("./config");
const { createPool } = require("./db");

const MIGRATION_FILES = Object.freeze(["schema.sql","access.sql","operations.sql","finance.sql","customer-experience.sql","care.sql","warranty.sql","business.sql","warranty-channels.sql","care-channels.sql","contact-changes.sql","news.sql","account-security.sql","product-workspace.sql","care-messages.sql","admin-experience.sql","account-retention.sql","account-contact-only.sql","bot-warranty-deletion.sql","warranty-purchase-date.sql","marketing.sql","product-promotions.sql","email-marketing.sql","admin-login-aliases.sql","warranty-resubmission.sql","marketing-banners.sql","security-hardening.sql","product-card-copy.sql","shopping-chat.sql","shopping-chat-media.sql","shopping-chat-email.sql","shopping-chat-ai-first.sql","product-deletion.sql","shopping-chat-handoff.sql","product-trash.sql","primary-media-storage.sql","checkout-account-email.sql","order-review.sql","order-after-sales.sql","shipping-choice.sql","site-pages.sql","hostinger-media-migration.sql","file-library.sql","site-asset-snapshots.sql","payment-channels.sql","domain-gaeru-com.sql","shopping-chat-unlimited-compression.sql","source-audit-upload.sql","payment-provider-verification.sql","shopping-chat-file-retention.sql","order-restoration.sql","channel-reports-ads.sql","channel-report-snapshot-safety.sql","misa-einvoice.sql","shopee-express-shipping.sql","oauth-social-login.sql","visitor-traffic.sql","customer-lifecycle-filter.sql","customer-reg-email-lifecycle.sql","order-permanent-deletion.sql","shipping-fulfillment.sql","omnichannel-and-loyalty.sql","care-attachments-and-notifications.sql","customer-cart.sql","product-bundles.sql","abandoned-cart.sql","barcode.sql","customer-order-cancellation.sql","auth-identities.sql","inventory-forecast.sql","order-after-sales-customer.sql","legacy-schema-reconciliation.sql","order-checkout-idempotency.sql","audit-loyalty-reversal.sql","audit-return-delivery-clock.sql","archive-product-reviews.sql","marketplace-sync-completion.sql","chat-compression-leases.sql","media-upload-originals.sql","integration-delivery-safety.sql","rma-exchange-stock.sql","checkout-idempotency-claim-token.sql","jt-vietnam-protocol.sql","k9-editorial-guides-20261104.sql","marketing-email-consent.sql"]);

async function migrateDatabase(pool) {
  const client = await pool.connect();
  let currentFile = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:database-migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const appliedRes = await client.query("SELECT name FROM schema_migrations", []);
    const appliedRows = Array.isArray(appliedRes) ? (appliedRes[0]?.rows || []) : (appliedRes?.rows || []);
    const appliedSet = new Set(appliedRows.map(r => r.name));
    for (const file of MIGRATION_FILES) {
      currentFile = file;
      if (appliedSet.has(file)) continue;
      const schema = await fs.readFile(path.join(__dirname, "..", "db", file), "utf8");
      await client.query(schema);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [file]);
      appliedSet.add(file);
    }
    currentFile = null;
    await client.query("COMMIT");
  } catch (error) {
    if (error && typeof error === "object" && currentFile && !error.migrationFile) {
      error.migrationFile = currentFile;
    }
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
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
module.exports = { migrateDatabase, MIGRATION_FILES };
