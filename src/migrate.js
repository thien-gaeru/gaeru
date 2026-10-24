require("dotenv").config();
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadConfig } = require("./config");
const { createPool } = require("./db");

async function migrateDatabase(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gaeru:database-migrations'))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of ["schema.sql", "access.sql", "operations.sql", "finance.sql", "customer-experience.sql", "care.sql", "warranty.sql", "business.sql", "warranty-channels.sql", "care-channels.sql", "contact-changes.sql", "news.sql", "account-security.sql", "product-workspace.sql", "care-messages.sql", "admin-experience.sql", "account-retention.sql", "account-contact-only.sql", "bot-warranty-deletion.sql", "warranty-purchase-date.sql", "marketing.sql", "product-promotions.sql", "email-marketing.sql", "admin-login-aliases.sql", "warranty-resubmission.sql"]) {
      const applied = await client.query("SELECT name FROM schema_migrations WHERE name=$1", [file]);
      if (applied.rows.length) continue;
      const schema = await fs.readFile(path.join(__dirname, "..", "db", file), "utf8");
      await client.query(schema);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
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
module.exports = { migrateDatabase };
