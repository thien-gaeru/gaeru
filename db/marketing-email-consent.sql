CREATE TABLE IF NOT EXISTS marketing_email_subscriptions (
  email text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'subscribed', 'unsubscribed')),
  consent_source text NOT NULL DEFAULT 'web',
  consent_version text NOT NULL DEFAULT 'v2026.11',
  consent_at timestamptz DEFAULT now(),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  confirmation_token_hash text UNIQUE,
  confirmation_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_email_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('opt_in_requested', 'confirmed', 'unsubscribed')),
  source text NOT NULL,
  ip_hash text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_email_subscriptions_status_idx ON marketing_email_subscriptions(status);
CREATE INDEX IF NOT EXISTS marketing_email_consent_events_email_idx ON marketing_email_consent_events(email);
