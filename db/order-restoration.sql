ALTER TABLE orders ADD COLUMN IF NOT EXISTS management_version integer NOT NULL DEFAULT 1 CHECK(management_version>0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_completed_at timestamptz;
ALTER TABLE order_stock_allocations ADD COLUMN IF NOT EXISTS reservation_cycle uuid;

UPDATE orders o SET return_completed_at=a.closed_at
FROM (SELECT order_id,max(updated_at) AS closed_at FROM order_after_sales WHERE kind='return' AND status='resolved' GROUP BY order_id) a
WHERE o.id=a.order_id AND o.return_completed_at IS NULL;

CREATE OR REPLACE FUNCTION advance_order_management_version() RETURNS trigger AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN NEW.management_version=OLD.management_version+1; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS order_management_version ON orders;
CREATE TRIGGER order_management_version BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION advance_order_management_version();

CREATE TABLE IF NOT EXISTS order_restoration_requests(
 request_key uuid PRIMARY KEY,
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
 request_hash text NOT NULL,
 result jsonb NOT NULL,
 actor_username text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
