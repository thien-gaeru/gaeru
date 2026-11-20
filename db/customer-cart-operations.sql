ALTER TABLE customers ADD COLUMN IF NOT EXISTS cart_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS customer_cart_operations (
  operation_id text PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS customer_cart_operations_customer_idx ON customer_cart_operations(customer_id);
