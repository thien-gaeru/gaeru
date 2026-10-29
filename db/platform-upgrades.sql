CREATE TABLE IF NOT EXISTS system_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue text NOT NULL DEFAULT 'default',
  name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_jobs_queue_status_run_idx ON system_jobs (queue, status, run_at);

CREATE TABLE IF NOT EXISTS abandoned_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  phone text,
  customer_name text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal_vnd bigint NOT NULL DEFAULT 0,
  recovery_token text UNIQUE NOT NULL,
  status text NOT NULL DEFAULT 'abandoned' CHECK (status IN ('abandoned', 'reminded_1', 'reminded_2', 'recovered', 'expired')),
  reminder_count integer NOT NULL DEFAULT 0,
  reminder_sent_at timestamptz,
  recovered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abandoned_carts_status_created_idx ON abandoned_carts (status, created_at);
CREATE INDEX IF NOT EXISTS abandoned_carts_recovery_token_idx ON abandoned_carts (recovery_token);

CREATE TABLE IF NOT EXISTS customer_loyalty (
  customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  points bigint NOT NULL DEFAULT 0 CHECK (points >= 0),
  lifetime_points bigint NOT NULL DEFAULT 0 CHECK (lifetime_points >= 0),
  tier text NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'silver', 'gold', 'diamond')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  points_change bigint NOT NULL,
  balance_after bigint NOT NULL DEFAULT 0,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loyalty_transactions_customer_idx ON loyalty_transactions (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL DEFAULT 'general',
  title text NOT NULL,
  content text NOT NULL,
  product_slug text,
  keywords text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_knowledge_slug_idx ON chat_knowledge_documents (product_slug);
CREATE INDEX IF NOT EXISTS chat_knowledge_category_idx ON chat_knowledge_documents (category);

CREATE TABLE IF NOT EXISTS omnichannel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('shopee', 'tiktok_shop', 'lazada', 'other')),
  event_type text NOT NULL,
  external_sku text NOT NULL,
  quantity_delta integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'processed' CHECK (status IN ('pending', 'processed', 'failed')),
  processed_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS omnichannel_events_channel_status_idx ON omnichannel_events (channel, status);

CREATE TABLE IF NOT EXISTS system_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  source text NOT NULL,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_alerts_severity_idx ON system_alerts (severity, created_at DESC);
