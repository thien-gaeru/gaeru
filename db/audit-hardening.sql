-- Hardening migration for P1 & P2 deep audit remediation:
-- 1. Inventory ledger payload_hash & warehouse_stock non-negative constraints (P1-1)
-- 2. PostgreSQL-level Job Queue idempotency unique index & worker lease fencing columns (P1-2, P2-6)
-- 3. Order pricing snapshot/quote_hash & exact combo order_item_allocations child table (P2-3, P2-4)

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS payload_hash text;

DO $$
BEGIN
  IF to_regclass('warehouse_stock') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'warehouse_stock'::regclass
        AND (conname = 'warehouse_stock_quantity_nonnegative_chk' OR (contype = 'c' AND pg_get_constraintdef(oid) LIKE '%quantity >= 0%'))
    ) THEN
      ALTER TABLE warehouse_stock
        ADD CONSTRAINT warehouse_stock_quantity_nonnegative_chk CHECK (quantity >= 0);
    END IF;
  END IF;
END $$;

ALTER TABLE system_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE system_jobs
SET idempotency_key = payload->>'_idempotencyKey'
WHERE idempotency_key IS NULL
  AND payload IS NOT NULL
  AND jsonb_typeof(payload) = 'object'
  AND payload ? '_idempotencyKey';

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY name, idempotency_key
           ORDER BY CASE status WHEN 'completed' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,
                    created_at ASC,
                    id ASC
         ) AS rn
  FROM system_jobs
  WHERE idempotency_key IS NOT NULL
    AND status IN ('pending', 'processing', 'completed')
)
UPDATE system_jobs
SET status = 'failed',
    last_error = COALESCE(last_error, 'Deduplicated prior to system_jobs_name_idempotency_uidx creation')
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS system_jobs_name_idempotency_uidx
  ON system_jobs (name, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND status IN ('pending', 'processing', 'completed');

CREATE INDEX IF NOT EXISTS idx_system_jobs_lease_expiry
  ON system_jobs (status, lease_expires_at)
  WHERE status = 'processing';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS quote_hash text,
  ADD COLUMN IF NOT EXISTS checkout_payload_hash text;

CREATE INDEX IF NOT EXISTS idx_orders_checkout_payload_hash
  ON orders (checkout_payload_hash)
  WHERE checkout_payload_hash IS NOT NULL;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS effective_unit_price_vnd integer;

CREATE TABLE IF NOT EXISTS order_item_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  tier_kind text NOT NULL CHECK (tier_kind IN ('regular', 'promotion', 'flash', 'bundle_discounted', 'remainder_adjusted')),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_vnd integer NOT NULL CHECK (unit_price_vnd >= 0),
  line_total_vnd integer NOT NULL CHECK (line_total_vnd >= 0),
  discount_percent integer NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (quantity * unit_price_vnd = line_total_vnd)
);

CREATE INDEX IF NOT EXISTS idx_order_item_allocations_item
  ON order_item_allocations (order_item_id);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order_provider_status
  ON payment_attempts (order_id, provider, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_request_id
  ON payment_attempts (provider_request_id)
  WHERE provider_request_id IS NOT NULL;

ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN (
    'pending',
    'payment_initiation_unknown',
    'awaiting_reconciliation',
    'expiry_awaiting_verification',
    'paid',
    'failed',
    'cancelled'
  ));

