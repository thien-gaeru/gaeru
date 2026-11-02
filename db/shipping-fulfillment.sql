-- shipping-fulfillment.sql: Quan ly van don thuc te va dong bo hanh trinh hang van chuyen
CREATE TABLE IF NOT EXISTS carrier_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  carrier_id text NOT NULL CHECK (carrier_id IN ('ghn','ghtk','viettel','jt','spx')),
  tracking_number text NOT NULL,
  carrier_order_id text,
  label_url text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','picking','delivering','delivered','returned','cancelled')),
  carrier_status_raw text,
  carrier_status_desc text,
  shipping_fee_vnd integer CHECK (shipping_fee_vnd IS NULL OR shipping_fee_vnd >= 0),
  cod_amount_vnd integer NOT NULL DEFAULT 0 CHECK (cod_amount_vnd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  tracking_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT carrier_shipments_order_carrier_unique UNIQUE (order_id, carrier_id),
  CONSTRAINT carrier_shipments_tracking_number_unique UNIQUE (tracking_number)
);

CREATE INDEX IF NOT EXISTS carrier_shipments_order_id_idx ON carrier_shipments(order_id);
CREATE INDEX IF NOT EXISTS carrier_shipments_tracking_number_idx ON carrier_shipments(tracking_number);
CREATE INDEX IF NOT EXISTS carrier_shipments_status_idx ON carrier_shipments(status, updated_at DESC);
