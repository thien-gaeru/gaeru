CREATE TABLE IF NOT EXISTS bnpl_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_number text NOT NULL,
  provider text NOT NULL DEFAULT 'fundiin' CHECK (provider IN ('fundiin', 'kredivo')),
  transaction_id text UNIQUE NOT NULL,
  amount_vnd bigint NOT NULL,
  installments_count integer NOT NULL DEFAULT 3 CHECK (installments_count IN (3, 4, 6, 12)),
  installment_amount_vnd bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'settled', 'cancelled')),
  customer_phone text,
  gateway_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bnpl_tx_order_number_idx ON bnpl_transactions (order_number);
CREATE INDEX IF NOT EXISTS bnpl_tx_transaction_id_idx ON bnpl_transactions (transaction_id);

CREATE TABLE IF NOT EXISTS rma_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_code text UNIQUE NOT NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_number text,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  product_name text NOT NULL,
  serial_number text,
  issue_type text NOT NULL CHECK (issue_type IN ('power_loss', 'mic_noise', 'gimbal_axis_jitter', 'connectivity', 'physical_defect', 'other')),
  issue_description text NOT NULL,
  media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'inspecting', 'approved_replacement', 'approved_repair', 'rejected', 'shipping_back', 'completed')),
  resolution_type text CHECK (resolution_type IS NULL OR resolution_type IN ('replace_1_1', 'repair', 'refund', 'rejected')),
  tracking_code_inbound text,
  tracking_code_outbound text,
  technician_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rma_tickets_code_idx ON rma_tickets (ticket_code);
CREATE INDEX IF NOT EXISTS rma_tickets_phone_idx ON rma_tickets (customer_phone);
CREATE INDEX IF NOT EXISTS rma_tickets_status_idx ON rma_tickets (status);

CREATE TABLE IF NOT EXISTS rma_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES rma_tickets(id) ON DELETE CASCADE,
  status text NOT NULL,
  description text NOT NULL,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rma_events_ticket_id_idx ON rma_timeline_events (ticket_id, created_at);

CREATE TABLE IF NOT EXISTS inventory_reorder_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text UNIQUE NOT NULL,
  product_name text NOT NULL,
  lead_time_days integer NOT NULL DEFAULT 7,
  safety_stock_units integer NOT NULL DEFAULT 5,
  min_order_qty integer NOT NULL DEFAULT 10,
  manual_override_rop integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_rop_sku_idx ON inventory_reorder_points (sku);

CREATE TABLE IF NOT EXISTS server_capi_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  event_name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('meta', 'tiktok', 'simulated')),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'simulated')),
  payload_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS server_capi_event_idx ON server_capi_logs (event_name, created_at DESC);

CREATE TABLE IF NOT EXISTS order_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_number text,
  actor_type text NOT NULL CHECK (actor_type IN ('customer', 'staff', 'system', 'gateway')),
  actor_name text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_activities_order_idx ON order_activities (order_id, created_at ASC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND conname = 'orders_payment_method_check'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT orders_payment_method_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('cod', 'bank_transfer', '9pay', 'vnpay', 'momo', 'zalopay', 'bnpl'));
  END IF;
END $$;
