CREATE TABLE IF NOT EXISTS admin_push_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  account_key TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_push_subscriptions_account_key
  ON admin_push_subscriptions(account_key);
