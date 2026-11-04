CREATE TABLE IF NOT EXISTS inventory_reorder_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  lead_time_days integer NOT NULL DEFAULT 7 CHECK (lead_time_days >= 1),
  safety_stock_days integer NOT NULL DEFAULT 7 CHECK (safety_stock_days >= 0),
  manual_safety_stock integer CHECK (manual_safety_stock IS NULL OR manual_safety_stock >= 0),
  manual_reorder_point integer CHECK (manual_reorder_point IS NULL OR manual_reorder_point >= 0),
  min_order_quantity integer NOT NULL DEFAULT 1 CHECK (min_order_quantity >= 1),
  target_stock_days integer NOT NULL DEFAULT 30 CHECK (target_stock_days >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_reorder_warehouse_variant UNIQUE (warehouse_id, variant_id)
);

CREATE INDEX IF NOT EXISTS ix_reorder_settings_wh ON inventory_reorder_settings(warehouse_id);
CREATE INDEX IF NOT EXISTS ix_reorder_settings_variant ON inventory_reorder_settings(variant_id);
