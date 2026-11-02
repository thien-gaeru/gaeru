ALTER TABLE customers ADD COLUMN deletion_recoverable boolean NOT NULL DEFAULT true;
UPDATE customers SET deletion_recoverable=false WHERE deleted_at IS NOT NULL;
CREATE INDEX customer_deletion_due ON customers(deleted_at) WHERE deleted_at IS NOT NULL;
