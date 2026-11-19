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
