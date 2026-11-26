-- Audit Remediation Wave v2 (2026-11-26):
-- 1. Explicit user_sessions schema for multi-worker & SSE validation
-- 2. 3-phase checkout voucher & GAERU Xu hold columns on checkout_payment_intents
-- 3. Missing foreign-key B-tree indexes & hot-query partial/functional indexes

CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire"
  ON user_sessions (expire);

ALTER TABLE checkout_payment_intents
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS held_voucher_id uuid REFERENCES marketing_vouchers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS held_loyalty_points integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS held_loyalty_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_checkout_intents_held_voucher
  ON checkout_payment_intents (held_voucher_id)
  WHERE status = 'pending_provider' AND held_voucher_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_checkout_intents_held_customer
  ON checkout_payment_intents (customer_id, held_voucher_id)
  WHERE status = 'pending_provider' AND customer_id IS NOT NULL;

-- Foreign-key & hot lookup indexes
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer_sort
  ON customer_addresses (customer_id, is_default DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_momo_refunds_payment_attempt_id
  ON momo_refunds (payment_attempt_id);

CREATE INDEX IF NOT EXISTS idx_carrier_shipment_attempts_order_id
  ON carrier_shipment_attempts (order_id);

CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_voucher_id
  ON voucher_redemptions (voucher_id);

CREATE INDEX IF NOT EXISTS idx_warranty_activations_order_item_id
  ON warranty_activations (order_item_id);

CREATE INDEX IF NOT EXISTS idx_shopping_chat_threads_awaiting_active
  ON shopping_chat_threads (awaiting_admin DESC, updated_at DESC)
  WHERE status <> 'closed';

CREATE INDEX IF NOT EXISTS idx_abandoned_carts_active_reminder
  ON abandoned_carts (next_reminder_at ASC, id)
  WHERE status IN ('abandoned', 'recovering') AND recovery_consent = true AND next_reminder_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_reviews_unresolved_created
  ON order_reviews (created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_warranty_activations_guest_owner
  ON warranty_activations (guest_owner_hash, created_at DESC)
  WHERE customer_id IS NULL AND withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_care_requests_updated_id_desc
  ON care_requests (updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_orders_norm_order_number
  ON orders (replace(upper(order_number), '-', ''));

CREATE INDEX IF NOT EXISTS idx_payment_attempts_norm_txn_ref
  ON payment_attempts (replace(upper(transaction_ref), '-', ''));
