CREATE TABLE IF NOT EXISTS abandoned_carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  email text NOT NULL,
  customer_name text,
  phone text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal_vnd integer NOT NULL DEFAULT 0 CHECK (subtotal_vnd >= 0),
  recovery_token text NOT NULL UNIQUE,
  recovery_token_hash text NOT NULL UNIQUE,
  recovery_consent boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'abandoned' CHECK (status IN ('abandoned', 'recovering', 'recovered', 'expired', 'opted_out')),
  reminder_count integer NOT NULL DEFAULT 0,
  max_reminders integer NOT NULL DEFAULT 3,
  next_reminder_at timestamptz,
  last_reminded_at timestamptz,
  recovered_at timestamptz,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS abandoned_carts_email_idx ON abandoned_carts(lower(trim(email)));
CREATE INDEX IF NOT EXISTS abandoned_carts_status_reminder_idx ON abandoned_carts(status, next_reminder_at) WHERE status = 'abandoned';
CREATE INDEX IF NOT EXISTS abandoned_carts_token_idx ON abandoned_carts(recovery_token);
CREATE INDEX IF NOT EXISTS abandoned_carts_token_hash_idx ON abandoned_carts(recovery_token_hash);

CREATE TABLE IF NOT EXISTS abandoned_cart_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES abandoned_carts(id) ON DELETE CASCADE,
  stage integer NOT NULL CHECK (stage >= 1 AND stage <= 3),
  email text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS abandoned_cart_reminders_cart_idx ON abandoned_cart_reminders(cart_id);
