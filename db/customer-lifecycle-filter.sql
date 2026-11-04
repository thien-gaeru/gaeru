ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_invalid_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lock_reason text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS locked_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_customers_phone_invalid ON customers(phone_invalid_at) WHERE phone_invalid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_lock_reason ON customers(lock_reason) WHERE lock_reason IS NOT NULL;
