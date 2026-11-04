CREATE TABLE IF NOT EXISTS order_deletion_sessions (
  order_id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION protect_sales_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM order_deletion_sessions WHERE order_id = OLD.order_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Sales receipts are append-only';
END $$;
