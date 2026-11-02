-- Retain product/variant IDs, stock and document references when removing a listing.
ALTER TABLE products ADD COLUMN deleted_at timestamptz;
