-- cod-return-intake.sql: Quan ly quy trinh kiem nhan hang chuyen hoan COD
CREATE TABLE IF NOT EXISTS cod_return_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  shipment_id uuid REFERENCES carrier_shipments(id) ON DELETE SET NULL,
  carrier_id text NOT NULL CHECK (carrier_id IN ('viettel','jt','spx','standard','other')),
  tracking_number text NOT NULL,
  order_number text NOT NULL,
  package_condition text NOT NULL CHECK (package_condition IN ('intact', 'damaged', 'lost_or_tampered')),
  warehouse_id uuid REFERENCES warehouses(id) ON DELETE SET NULL,
  warehouse_name text NOT NULL DEFAULT '',
  restocked boolean NOT NULL DEFAULT false,
  claimed_damage boolean NOT NULL DEFAULT false,
  carrier_fault boolean NOT NULL DEFAULT false,
  inspection_notes text NOT NULL DEFAULT '',
  evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  inspector text NOT NULL,
  items_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cod_return_intakes_shipment_unique UNIQUE (shipment_id)
);

CREATE INDEX IF NOT EXISTS ix_cod_return_intakes_order_id ON cod_return_intakes(order_id);
CREATE INDEX IF NOT EXISTS ix_cod_return_intakes_tracking_number ON cod_return_intakes(tracking_number);
CREATE INDEX IF NOT EXISTS ix_cod_return_intakes_created_at ON cod_return_intakes(created_at DESC);
