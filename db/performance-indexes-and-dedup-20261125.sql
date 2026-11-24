-- Wave 2 (2026-11-25): Eliminate redundant B-tree indexes & cover background worker outbox/job status scans

-- 1. Drop 10 verified 100%-duplicate non-constraint B-tree indexes (preserving primary/unique constraints and canonical indexes)
DROP INDEX IF EXISTS idx_audit_events_created_id_desc;
DROP INDEX IF EXISTS idx_orders_customer_created_desc;
DROP INDEX IF EXISTS abandoned_carts_token_hash_idx;
DROP INDEX IF EXISTS abandoned_carts_token_idx;
DROP INDEX IF EXISTS customers_google_id_idx;
DROP INDEX IF EXISTS customer_loyalty_ledger_event_key_idx;
DROP INDEX IF EXISTS carrier_shipments_tracking_number_idx;
DROP INDEX IF EXISTS ix_after_sales_rma_number;
DROP INDEX IF EXISTS ix_after_sales_rma_token;
DROP INDEX IF EXISTS order_pack_verifications_order_idx;

-- 2. Expand partial indexes for AI job queue & SMTP outbox background workers (eliminates >133,000 sequential table scans)
DROP INDEX IF EXISTS shopping_chat_ai_pending;
DROP INDEX IF EXISTS idx_shopping_chat_ai_jobs_active;
CREATE INDEX IF NOT EXISTS idx_shopping_chat_ai_jobs_active
  ON shopping_chat_ai_jobs (status, created_at, id, started_at)
  WHERE status IN ('pending', 'running');

DROP INDEX IF EXISTS order_email_pending;
CREATE INDEX IF NOT EXISTS idx_order_email_outbox_active
  ON order_email_outbox (status, next_attempt_at, created_at, id, attempted_at)
  WHERE status IN ('pending', 'sending', 'failed', 'unknown');

DROP INDEX IF EXISTS shopping_chat_email_pending;
CREATE INDEX IF NOT EXISTS idx_shopping_chat_email_outbox_active
  ON shopping_chat_email_outbox (status, next_attempt_at, created_at, id, attempted_at)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS idx_warranty_email_outbox_active
  ON warranty_email_outbox (status, next_attempt_at, created_at, id, attempted_at)
  WHERE status IN ('pending', 'sending');

DROP INDEX IF EXISTS care_email_outbox_pending;
CREATE INDEX IF NOT EXISTS idx_care_email_outbox_active
  ON care_email_outbox (status, next_attempt_at, created_at, id, attempted_at)
  WHERE status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS idx_order_admin_email_outbox_active
  ON order_admin_email_outbox (status, next_attempt_at, id, attempted_at)
  WHERE status IN ('pending', 'sending');

DROP INDEX IF EXISTS admin_domain_email_outbox_pending_idx;
CREATE INDEX IF NOT EXISTS idx_admin_domain_email_outbox_active
  ON admin_domain_email_outbox (status, next_attempt_at, created_at, id, attempted_at)
  WHERE status IN ('pending', 'sending');
