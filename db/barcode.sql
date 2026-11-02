-- barcode.sql: Ho tro quan ly kho bang ma vach (Barcode Scanner & Code 128 Workflow)

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode text;
CREATE INDEX IF NOT EXISTS product_variants_barcode_idx ON product_variants(barcode);

CREATE TABLE IF NOT EXISTS barcode_scan_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('sku', 'order', 'waybill', 'unknown')),
  entity_id uuid,
  action text NOT NULL CHECK (action IN ('lookup', 'inbound_receive', 'outbound_dispatch', 'cycle_count', 'pack_verify')),
  warehouse_id uuid REFERENCES warehouses(id) ON DELETE SET NULL,
  quantity integer NOT NULL DEFAULT 1,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  scanned_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS barcode_scan_logs_code_idx ON barcode_scan_logs(code);
CREATE INDEX IF NOT EXISTS barcode_scan_logs_created_idx ON barcode_scan_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS barcode_scan_logs_action_idx ON barcode_scan_logs(action, created_at DESC);

CREATE TABLE IF NOT EXISTS order_pack_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'packing' CHECK (status IN ('packing', 'verified', 'dispatched')),
  total_items integer NOT NULL,
  scanned_items integer NOT NULL DEFAULT 0,
  items_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  packed_by text,
  packed_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_pack_verifications_status_idx ON order_pack_verifications(status);
CREATE INDEX IF NOT EXISTS order_pack_verifications_order_idx ON order_pack_verifications(order_id);
