CREATE TABLE IF NOT EXISTS warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO warehouses (code, name) VALUES ('MAIN', 'Kho chính') ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS warehouse_stock (
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, variant_id)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES product_variants(id) ON DELETE RESTRICT,
  sku text NOT NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL,
  movement_type text NOT NULL CHECK (movement_type IN ('opening','adjustment','transfer_in','transfer_out','sale_reservation','sale_release','legacy_sale_release','purchase_receipt')),
  delta integer NOT NULL CHECK (delta <> 0),
  quantity_before integer NOT NULL CHECK (quantity_before >= 0),
  quantity_after integer NOT NULL CHECK (quantity_after >= 0 AND quantity_after = quantity_before + delta),
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  reason text NOT NULL DEFAULT '',
  actor_id uuid,
  actor_username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_movements_created_idx ON inventory_movements(created_at DESC, id);
CREATE INDEX IF NOT EXISTS inventory_movements_variant_idx ON inventory_movements(variant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_warehouse_idx ON inventory_movements(warehouse_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_stock_allocations (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  released_at timestamptz,
  PRIMARY KEY (order_id, variant_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS inventory_requests (
  request_key text PRIMARY KEY,
  operation_type text NOT NULL,
  request_hash text NOT NULL,
  result jsonb,
  actor_username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  supplier_name text NOT NULL,
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','partially_received','received','cancelled')),
  total_vnd bigint NOT NULL CHECK (total_vnd >= 0 AND total_vnd <= 9000000000000),
  created_by uuid,
  created_by_username text NOT NULL,
  submitted_by uuid,
  submitted_by_username text,
  approved_by uuid,
  approved_by_username text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_orders_created_idx ON purchase_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders(supplier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  sku text NOT NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  received_quantity integer NOT NULL DEFAULT 0 CHECK (received_quantity >= 0 AND received_quantity <= quantity),
  unit_cost_vnd bigint NOT NULL CHECK (unit_cost_vnd >= 0 AND unit_cost_vnd <= 9000000000000),
  line_total_vnd bigint NOT NULL CHECK (line_total_vnd = quantity * unit_cost_vnd AND line_total_vnd <= 9000000000000),
  UNIQUE (purchase_order_id, variant_id)
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  request_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  created_by uuid,
  created_by_username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goods_receipts_order_idx ON goods_receipts(purchase_order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE RESTRICT,
  purchase_order_item_id uuid NOT NULL REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost_vnd bigint NOT NULL CHECK (unit_cost_vnd >= 0),
  line_total_vnd bigint NOT NULL CHECK (line_total_vnd = quantity * unit_cost_vnd AND line_total_vnd <= 9000000000000),
  UNIQUE (goods_receipt_id, purchase_order_item_id)
);

CREATE OR REPLACE FUNCTION protect_operations_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Posted goods receipts and inventory movements are append-only';
END $$;
DROP TRIGGER IF EXISTS protect_goods_receipt ON goods_receipts;
CREATE TRIGGER protect_goods_receipt BEFORE UPDATE OR DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_operations_history();
DROP TRIGGER IF EXISTS protect_goods_receipt_item ON goods_receipt_items;
CREATE TRIGGER protect_goods_receipt_item BEFORE UPDATE OR DELETE ON goods_receipt_items
  FOR EACH ROW EXECUTE FUNCTION protect_operations_history();
DROP TRIGGER IF EXISTS protect_inventory_movement ON inventory_movements;
CREATE TRIGGER protect_inventory_movement BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION protect_operations_history();

-- Establish today's available-stock opening balances only for variants that have
-- never had a warehouse balance. Historical warehouse activity is not inferred.
WITH opening AS (
  INSERT INTO warehouse_stock (warehouse_id, variant_id, quantity)
  SELECT w.id, v.id, v.stock_quantity
  FROM product_variants v CROSS JOIN warehouses w
  WHERE w.code = 'MAIN'
    AND NOT EXISTS (SELECT 1 FROM warehouse_stock s WHERE s.variant_id = v.id)
  ON CONFLICT (warehouse_id, variant_id) DO NOTHING
  RETURNING warehouse_id, variant_id, quantity
)
INSERT INTO inventory_movements (event_key,warehouse_id,variant_id,sku,product_name,variant_name,
  movement_type,delta,quantity_before,quantity_after,reference_type,reference_id,reason,actor_username)
SELECT 'opening:' || v.id::text,o.warehouse_id,v.id,v.sku,p.name,v.name,
  'opening',o.quantity,0,o.quantity,'opening',v.id::text,'Số dư tồn khả dụng khi bắt đầu quản lý kho','system'
FROM opening o JOIN product_variants v ON v.id=o.variant_id JOIN products p ON p.id=v.product_id
WHERE o.quantity > 0
ON CONFLICT (event_key) DO NOTHING;
