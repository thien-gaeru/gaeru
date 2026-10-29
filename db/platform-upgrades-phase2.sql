CREATE TABLE IF NOT EXISTS product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_slug text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  author_name text NOT NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title text NOT NULL,
  comment text NOT NULL,
  media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_verified_buyer boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_reviews_slug_status_idx ON product_reviews (product_slug, status, created_at DESC);
CREATE INDEX IF NOT EXISTS product_reviews_customer_idx ON product_reviews (customer_id);

CREATE TABLE IF NOT EXISTS product_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  main_product_slug text NOT NULL,
  bundle_product_slug text NOT NULL,
  bundle_title text NOT NULL,
  discount_percent integer NOT NULL DEFAULT 20 CHECK (discount_percent >= 1 AND discount_percent <= 90),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_bundles_main_slug_idx ON product_bundles (main_product_slug, active);

CREATE TABLE IF NOT EXISTS flash_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  discount_percent integer NOT NULL DEFAULT 15 CHECK (discount_percent >= 1 AND discount_percent <= 90),
  product_slugs text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS affiliate_partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_code text UNIQUE NOT NULL,
  name text NOT NULL,
  email text,
  phone text,
  commission_percent numeric(5,2) NOT NULL DEFAULT 8.00 CHECK (commission_percent >= 0 AND commission_percent <= 50),
  bank_name text,
  bank_account text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'terminated')),
  total_earnings_vnd bigint NOT NULL DEFAULT 0,
  total_orders integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_partners_code_idx ON affiliate_partners (partner_code);

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_code text NOT NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_code text NOT NULL,
  order_total_vnd bigint NOT NULL,
  commission_vnd bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_commissions_partner_status_idx ON affiliate_commissions (partner_code, status);

CREATE TABLE IF NOT EXISTS cod_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code text UNIQUE NOT NULL,
  carrier text NOT NULL DEFAULT 'spx',
  total_orders integer NOT NULL DEFAULT 0,
  total_collected_vnd bigint NOT NULL DEFAULT 0,
  total_fee_vnd bigint NOT NULL DEFAULT 0,
  net_transferred_vnd bigint NOT NULL DEFAULT 0,
  file_name text NOT NULL,
  status text NOT NULL DEFAULT 'reconciled' CHECK (status IN ('reconciled', 'discrepancy')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cod_reconciliation_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES cod_reconciliations(id) ON DELETE CASCADE,
  tracking_code text NOT NULL,
  order_code text,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  system_cod_vnd bigint NOT NULL DEFAULT 0,
  carrier_collected_vnd bigint NOT NULL DEFAULT 0,
  fee_vnd bigint NOT NULL DEFAULT 0,
  discrepancy_vnd bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'matched' CHECK (status IN ('matched', 'mismatch', 'not_found', 'overdue')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cod_items_batch_idx ON cod_reconciliation_items (batch_id);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint text UNIQUE NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  user_agent text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_push_active_idx ON web_push_subscriptions (active);
