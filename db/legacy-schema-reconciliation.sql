-- legacy-schema-reconciliation.sql
-- Self-healing schema reconciliation for production databases upgraded across historical releases.
-- Strictly idempotent and non-destructive.

-- 1. Restore order_deletion_sessions & protect_sales_receipt() if dropped by legacy payment-reconciliation-states.sql
CREATE TABLE IF NOT EXISTS order_deletion_sessions (
  order_id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION protect_sales_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM order_deletion_sessions WHERE order_id = OLD.order_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Sales receipts are append-only';
END $$;

-- 2. Ensure core columns on orders, customers, product_variants, and site_asset_snapshots
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
CREATE INDEX IF NOT EXISTS orders_customer_status_idx ON orders(customer_id, status, created_at DESC);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar_url text;
CREATE INDEX IF NOT EXISTS customers_google_id_idx ON customers(google_id);

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode text;
CREATE INDEX IF NOT EXISTS product_variants_barcode_idx ON product_variants(barcode);

ALTER TABLE site_asset_snapshots ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE site_asset_snapshots ADD COLUMN IF NOT EXISTS mime_type text;
ALTER TABLE site_asset_snapshots ADD COLUMN IF NOT EXISTS byte_size integer;
ALTER TABLE site_asset_snapshots ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE site_asset_snapshots ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 3. Reconcile orders_payment_method_check safely even if historical rows exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND conname = 'orders_payment_method_check'
      AND pg_get_constraintdef(oid) ILIKE '%vnpay%'
      AND pg_get_constraintdef(oid) ILIKE '%momo%'
      AND pg_get_constraintdef(oid) ILIKE '%zalopay%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%bnpl%'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
    IF EXISTS (
      SELECT 1 FROM orders
      WHERE payment_method NOT IN ('cod', 'bank_transfer', '9pay', 'vnpay', 'momo', 'zalopay')
    ) THEN
      ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
        CHECK (payment_method IN ('cod', 'bank_transfer', '9pay', 'vnpay', 'momo', 'zalopay')) NOT VALID;
    ELSE
      ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
        CHECK (payment_method IN ('cod', 'bank_transfer', '9pay', 'vnpay', 'momo', 'zalopay'));
    END IF;
  END IF;
END $$;

-- 4. Re-verify customer_loyalty, product_bundles, abandoned_carts, and product_reviews in case earlier migrations were pre-recorded
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS points_balance integer NOT NULL DEFAULT 0;
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS lifetime_earned integer NOT NULL DEFAULT 0;
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS lifetime_spent integer NOT NULL DEFAULT 0;
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'bronze';
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS discount_type text;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS discount_value integer;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS ends_at timestamptz;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovery_token_hash text;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovery_consent boolean NOT NULL DEFAULT true;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS max_reminders integer NOT NULL DEFAULT 3;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS next_reminder_at timestamptz;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
