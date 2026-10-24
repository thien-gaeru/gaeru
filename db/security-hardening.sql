CREATE TABLE IF NOT EXISTS security_rate_limits (
 key text PRIMARY KEY,
 hits integer NOT NULL DEFAULT 1,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS security_rate_limits_expiry ON security_rate_limits(expires_at);
