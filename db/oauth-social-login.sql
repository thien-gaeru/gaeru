-- OAuth Social Login: Google Login and Sign in with Apple
ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id text UNIQUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS apple_id text UNIQUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE customers ALTER COLUMN password_hash DROP NOT NULL;

CREATE INDEX IF NOT EXISTS customers_google_id_idx ON customers(google_id);
CREATE INDEX IF NOT EXISTS customers_apple_id_idx ON customers(apple_id);
