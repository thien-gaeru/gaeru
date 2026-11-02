-- omnichannel-and-loyalty.sql: He thong dong bo da kenh San TMDT va GAERU Xu / Loyalty
CREATE TABLE IF NOT EXISTS marketplace_sku_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('shopee', 'tiktok', 'lazada')),
  shop_id text NOT NULL,
  external_sku text NOT NULL,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_sku_mappings_channel_shop_sku_unique UNIQUE (channel, shop_id, external_sku)
);

CREATE INDEX IF NOT EXISTS marketplace_sku_mappings_channel_idx ON marketplace_sku_mappings(channel, shop_id);
CREATE INDEX IF NOT EXISTS marketplace_sku_mappings_variant_id_idx ON marketplace_sku_mappings(variant_id);

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('shopee', 'tiktok', 'lazada')),
  shop_id text NOT NULL,
  external_order_id text NOT NULL,
  order_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled', 'returned')),
  customer_name text NOT NULL DEFAULT '',
  customer_phone text NOT NULL DEFAULT '',
  shipping_address text NOT NULL DEFAULT '',
  total_amount_vnd bigint NOT NULL DEFAULT 0 CHECK (total_amount_vnd >= 0),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  stock_deducted boolean NOT NULL DEFAULT false,
  stock_reversed boolean NOT NULL DEFAULT false,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketplace_orders_channel_shop_order_unique UNIQUE (channel, shop_id, external_order_id)
);

CREATE INDEX IF NOT EXISTS marketplace_orders_channel_status_idx ON marketplace_orders(channel, status, created_at DESC);
CREATE INDEX IF NOT EXISTS marketplace_orders_order_date_idx ON marketplace_orders(order_date, channel);

CREATE TABLE IF NOT EXISTS marketplace_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('shopee', 'tiktok', 'lazada')),
  event_type text NOT NULL,
  external_order_id text,
  event_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed boolean NOT NULL DEFAULT false,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_sync_events_channel_idx ON marketplace_sync_events(channel, created_at DESC);

-- GAERU Xu / Loyalty Program
CREATE TABLE IF NOT EXISTS customer_loyalty (
  customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  points_balance integer NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  lifetime_earned integer NOT NULL DEFAULT 0 CHECK (lifetime_earned >= 0),
  lifetime_spent integer NOT NULL DEFAULT 0 CHECK (lifetime_spent >= 0),
  tier text NOT NULL DEFAULT 'bronze' CHECK (tier IN ('bronze', 'silver', 'gold', 'platinum')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Reconcile legacy customer_loyalty schema if table pre-existed from platform-upgrades.sql
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS points_balance integer NOT NULL DEFAULT 0;
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS lifetime_earned integer NOT NULL DEFAULT 0;
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS lifetime_spent integer NOT NULL DEFAULT 0;
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'bronze';
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE customer_loyalty ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
DECLARE
  v_con record;
  has_legacy_points boolean;
  has_legacy_lifetime boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'customer_loyalty' AND column_name = 'points'
  ) INTO has_legacy_points;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'customer_loyalty' AND column_name = 'lifetime_points'
  ) INTO has_legacy_lifetime;

  IF has_legacy_points AND has_legacy_lifetime THEN
    EXECUTE '
      UPDATE customer_loyalty
      SET points_balance = GREATEST(points_balance, LEAST(GREATEST(COALESCE(points, 0), 0), 2147483647)::integer),
          lifetime_earned = GREATEST(lifetime_earned, LEAST(GREATEST(COALESCE(lifetime_points, 0), 0), 2147483647)::integer)
      WHERE points_balance = 0 AND (COALESCE(points, 0) > 0 OR COALESCE(lifetime_points, 0) > 0)
    ';
  ELSIF has_legacy_points THEN
    EXECUTE '
      UPDATE customer_loyalty
      SET points_balance = GREATEST(points_balance, LEAST(GREATEST(COALESCE(points, 0), 0), 2147483647)::integer),
          lifetime_earned = GREATEST(lifetime_earned, LEAST(GREATEST(COALESCE(points, 0), 0), 2147483647)::integer)
      WHERE points_balance = 0 AND COALESCE(points, 0) > 0
    ';
  END IF;

  IF has_legacy_points THEN
    EXECUTE 'ALTER TABLE customer_loyalty ALTER COLUMN points SET DEFAULT 0, ALTER COLUMN points DROP NOT NULL';
  END IF;
  IF has_legacy_lifetime THEN
    EXECUTE 'ALTER TABLE customer_loyalty ALTER COLUMN lifetime_points SET DEFAULT 0, ALTER COLUMN lifetime_points DROP NOT NULL';
  END IF;

  FOR v_con IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'customer_loyalty'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%tier%'
  LOOP
    EXECUTE format('ALTER TABLE customer_loyalty DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;

  UPDATE customer_loyalty
  SET tier = CASE
    WHEN tier = 'diamond' THEN 'platinum'
    WHEN tier IN ('bronze', 'silver', 'gold', 'platinum') THEN tier
    ELSE 'bronze'
  END
  WHERE tier IS NULL OR tier NOT IN ('bronze', 'silver', 'gold', 'platinum');

  ALTER TABLE customer_loyalty ALTER COLUMN tier SET DEFAULT 'bronze';
  ALTER TABLE customer_loyalty ADD CONSTRAINT customer_loyalty_tier_check
    CHECK (tier IN ('bronze', 'silver', 'gold', 'platinum'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'customer_loyalty'::regclass AND conname = 'customer_loyalty_points_balance_check'
  ) THEN
    ALTER TABLE customer_loyalty ADD CONSTRAINT customer_loyalty_points_balance_check CHECK (points_balance >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'customer_loyalty'::regclass AND conname = 'customer_loyalty_lifetime_earned_check'
  ) THEN
    ALTER TABLE customer_loyalty ADD CONSTRAINT customer_loyalty_lifetime_earned_check CHECK (lifetime_earned >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'customer_loyalty'::regclass AND conname = 'customer_loyalty_lifetime_spent_check'
  ) THEN
    ALTER TABLE customer_loyalty ADD CONSTRAINT customer_loyalty_lifetime_spent_check CHECK (lifetime_spent >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS customer_loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('earn', 'redeem', 'refund', 'adjustment', 'expire')),
  points integer NOT NULL CHECK (points != 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reason text NOT NULL,
  event_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_loyalty_ledger_customer_id_idx ON customer_loyalty_ledger(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_loyalty_ledger_order_id_idx ON customer_loyalty_ledger(order_id);
CREATE INDEX IF NOT EXISTS customer_loyalty_ledger_event_key_idx ON customer_loyalty_ledger(event_key);
