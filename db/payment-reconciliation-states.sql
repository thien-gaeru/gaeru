-- Expand payment_attempts states to prevent destructive deletion on ambiguous gateway outcomes
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN (
    'pending',
    'payment_initiation_unknown',
    'awaiting_reconciliation',
    'paid',
    'failed',
    'cancelled'
  ));

ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS payment_url text;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS last_error_code text;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS reconciliation_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS payment_attempts_reconcile_idx
  ON payment_attempts (status, updated_at)
  WHERE status IN ('payment_initiation_unknown', 'awaiting_reconciliation');

ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_reference text;
CREATE UNIQUE INDEX IF NOT EXISTS orders_client_reference_uidx
  ON orders (client_reference)
  WHERE client_reference IS NOT NULL;

-- Restore strict append-only immutability on financial sales_receipts
CREATE OR REPLACE FUNCTION protect_sales_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sales receipts are append-only';
END $$;

DROP TABLE IF EXISTS order_deletion_sessions;
