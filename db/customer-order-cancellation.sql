-- Migration: Customer Order Cancellation Support
-- Adds cancellation_reason to orders table and indexing for customer orders lookup

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
CREATE INDEX IF NOT EXISTS orders_customer_status_idx ON orders(customer_id, status, created_at DESC);
