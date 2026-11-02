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

-- Reconcile legacy abandoned_carts schema if table pre-existed from platform-upgrades.sql
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS subtotal_vnd integer NOT NULL DEFAULT 0;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovery_token text;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovery_token_hash text;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovery_consent boolean NOT NULL DEFAULT true;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'abandoned';
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS max_reminders integer NOT NULL DEFAULT 3;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS next_reminder_at timestamptz;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS last_reminded_at timestamptz;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS recovered_at timestamptz;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
DECLARE
  v_con record;
BEGIN
  -- Drop outdated status check constraints (e.g. legacy reminded_1 / reminded_2 constraint)
  FOR v_con IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'abandoned_carts'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE abandoned_carts DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;

  -- Legacy phone-only rows may have NULL email; mark expired & opt-out so email worker skips them safely
  UPDATE abandoned_carts
  SET email = '',
      recovery_consent = false,
      status = CASE WHEN status = 'recovered' THEN 'recovered' ELSE 'expired' END
  WHERE email IS NULL OR btrim(email) = '';

  -- Map legacy statuses ('reminded_1', 'reminded_2', etc.) to valid status set
  UPDATE abandoned_carts
  SET status = 'abandoned'
  WHERE status IS NULL OR status NOT IN ('abandoned', 'recovering', 'recovered', 'expired', 'opted_out');

  ALTER TABLE abandoned_carts ADD CONSTRAINT abandoned_carts_status_check
    CHECK (status IN ('abandoned', 'recovering', 'recovered', 'expired', 'opted_out'));

  -- Normalize subtotal_vnd from bigint to integer if needed
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'abandoned_carts'
      AND column_name = 'subtotal_vnd'
      AND udt_name <> 'int4'
  ) THEN
    ALTER TABLE abandoned_carts ALTER COLUMN subtotal_vnd DROP DEFAULT;
    ALTER TABLE abandoned_carts ALTER COLUMN subtotal_vnd TYPE integer
      USING LEAST(GREATEST(COALESCE(subtotal_vnd, 0), 0), 2147483647)::integer;
    ALTER TABLE abandoned_carts ALTER COLUMN subtotal_vnd SET DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'abandoned_carts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%subtotal_vnd >= 0%'
  ) THEN
    UPDATE abandoned_carts SET subtotal_vnd = 0 WHERE subtotal_vnd < 0;
    ALTER TABLE abandoned_carts ADD CONSTRAINT abandoned_carts_subtotal_vnd_check CHECK (subtotal_vnd >= 0);
  END IF;

  -- Preserve legacy reminder timestamp if present
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'abandoned_carts' AND column_name = 'reminder_sent_at'
  ) THEN
    EXECUTE 'UPDATE abandoned_carts SET last_reminded_at = COALESCE(last_reminded_at, reminder_sent_at) WHERE last_reminded_at IS NULL AND reminder_sent_at IS NOT NULL';
  END IF;

  -- Ensure recovery_token and recovery_token_hash are populated and unique
  UPDATE abandoned_carts
  SET recovery_token = gen_random_uuid()::text || replace(id::text, '-', '')
  WHERE recovery_token IS NULL OR btrim(recovery_token) = '';

  UPDATE abandoned_carts
  SET recovery_token_hash = encode(sha256(convert_to(recovery_token, 'UTF8')), 'hex')
  WHERE recovery_token_hash IS NULL OR btrim(recovery_token_hash) = '';

  ALTER TABLE abandoned_carts ALTER COLUMN email SET NOT NULL;
  ALTER TABLE abandoned_carts ALTER COLUMN recovery_token SET NOT NULL;
  ALTER TABLE abandoned_carts ALTER COLUMN recovery_token_hash SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'abandoned_carts'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%(recovery_token_hash)%'
  ) THEN
    ALTER TABLE abandoned_carts ADD CONSTRAINT abandoned_carts_recovery_token_hash_key UNIQUE (recovery_token_hash);
  END IF;
END $$;

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
