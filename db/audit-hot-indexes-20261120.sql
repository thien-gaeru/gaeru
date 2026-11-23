-- Hot query composite/partial indexes from 2026-11-20 full-stack audit
CREATE INDEX IF NOT EXISTS idx_product_promotions_active_ends
  ON product_promotions (active, ends_at)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_shopping_chat_threads_awaiting_open
  ON shopping_chat_threads (awaiting_admin, status, updated_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_care_requests_status_updated
  ON care_requests (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_warranty_activations_pending_manual
  ON warranty_activations (status, created_at DESC)
  WHERE automatic = false AND withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_order_after_sales_order_id_created
  ON order_after_sales (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_lower_email
  ON orders (lower(email));

CREATE INDEX IF NOT EXISTS idx_orders_customer_created_desc
  ON orders (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopping_chat_ai_jobs_active
  ON shopping_chat_ai_jobs (status, created_at, id)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_shopping_chat_threads_human_timeout
  ON shopping_chat_threads (handoff_started_at)
  WHERE status = 'open' AND handling_mode = 'human' AND handoff_started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_created_id_desc
  ON audit_events (created_at DESC, id DESC);
