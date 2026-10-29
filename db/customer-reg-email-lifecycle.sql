ALTER TABLE customers ADD COLUMN IF NOT EXISTS reg_email_failed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_customers_reg_email_failed ON customers(reg_email_failed_at) WHERE reg_email_failed_at IS NOT NULL;
