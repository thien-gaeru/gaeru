-- Outbox bền vững cho thông báo quản trị (CARE+ mới, phản hồi CARE+ từ khách, đăng ký bảo hành ngoài)
CREATE TABLE IF NOT EXISTS admin_domain_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('care_new', 'care_customer_reply', 'warranty_external_new')),
  entity_id uuid NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  subject text NOT NULL,
  body_text text NOT NULL,
  recipient text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'unknown')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  finished_at timestamptz,
  result text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_domain_email_outbox_pending_idx
  ON admin_domain_email_outbox(next_attempt_at, created_at)
  WHERE status = 'pending';
