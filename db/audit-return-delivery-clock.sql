-- Capture the first known delivery once. Synchronization and unrelated order
-- edits must not restart the return-policy window.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- Historical rows have no immutable clock; preserve the best timestamp already
-- recorded, rather than giving old orders a fresh window on migration day.
UPDATE carrier_shipments SET delivered_at = COALESCE(last_synced_at, updated_at, created_at)
WHERE status = 'delivered' AND delivered_at IS NULL;

UPDATE orders o SET delivered_at = COALESCE(
  (SELECT MIN(s.delivered_at) FROM carrier_shipments s WHERE s.order_id = o.id),
  o.updated_at, o.created_at
)
WHERE o.delivered_at IS NULL AND (o.status = 'completed' OR EXISTS (
  SELECT 1 FROM carrier_shipments s WHERE s.order_id = o.id AND s.delivered_at IS NOT NULL
));

CREATE OR REPLACE FUNCTION preserve_order_delivery_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.delivered_at IS NOT NULL THEN
    NEW.delivered_at := OLD.delivered_at;
  ELSIF NEW.status = 'completed' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.delivered_at := COALESCE(NEW.delivered_at, NEW.updated_at, NEW.created_at, now());
    ELSE
      NEW.delivered_at := COALESCE(NEW.delivered_at, now());
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS orders_preserve_delivery_clock ON orders;
CREATE TRIGGER orders_preserve_delivery_clock
BEFORE INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION preserve_order_delivery_clock();

CREATE OR REPLACE FUNCTION preserve_shipment_delivery_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.delivered_at IS NOT NULL THEN
    NEW.delivered_at := OLD.delivered_at;
  ELSIF NEW.status = 'delivered' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.delivered_at := COALESCE(NEW.delivered_at, NEW.last_synced_at, NEW.updated_at, now());
    ELSE
      NEW.delivered_at := COALESCE(NEW.delivered_at, now());
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS shipments_preserve_delivery_clock ON carrier_shipments;
CREATE TRIGGER shipments_preserve_delivery_clock
BEFORE INSERT OR UPDATE ON carrier_shipments
FOR EACH ROW EXECUTE FUNCTION preserve_shipment_delivery_clock();

CREATE OR REPLACE FUNCTION copy_shipment_delivery_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.delivered_at IS NOT NULL THEN
    UPDATE orders SET delivered_at = NEW.delivered_at
    WHERE id = NEW.order_id AND delivered_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS shipments_copy_delivery_clock ON carrier_shipments;
CREATE TRIGGER shipments_copy_delivery_clock
AFTER INSERT OR UPDATE ON carrier_shipments
FOR EACH ROW EXECUTE FUNCTION copy_shipment_delivery_clock();
