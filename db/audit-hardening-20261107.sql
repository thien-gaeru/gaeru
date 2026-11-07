-- audit-hardening-20261107.sql
-- 1. P0-02: Khôi phục tính bất biến tuyệt đối (append-only) của sổ thu tiền sales_receipts
CREATE OR REPLACE FUNCTION protect_sales_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sales receipts are append-only';
END $$;

DROP TRIGGER IF EXISTS protect_sales_receipt ON sales_receipts;
CREATE TRIGGER protect_sales_receipt
  BEFORE UPDATE OR DELETE ON sales_receipts
  FOR EACH ROW EXECUTE FUNCTION protect_sales_receipt();

-- 2. P0-01, P1-01, P1-02, P1-03: Mở rộng trạng thái vận đơn, tách trạng thái chuyển hoàn & đối soát COD, thêm version fencing
ALTER TABLE carrier_shipments DROP CONSTRAINT IF EXISTS carrier_shipments_status_check;
ALTER TABLE carrier_shipments ADD CONSTRAINT carrier_shipments_status_check CHECK (
  status IN (
    'created',
    'picking',
    'delivering',
    'delivered',
    'return_requested',
    'returning',
    'returned',
    'cancel_requested',
    'cancel_reconciliation_required',
    'cancelled'
  )
);

ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS status_version integer NOT NULL DEFAULT 1 CHECK (status_version >= 1);
ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS provider_event_time timestamptz;
ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS cod_settlement_status text NOT NULL DEFAULT 'unsettled';
ALTER TABLE carrier_shipments DROP CONSTRAINT IF EXISTS carrier_shipments_cod_settlement_status_check;
ALTER TABLE carrier_shipments ADD CONSTRAINT carrier_shipments_cod_settlement_status_check CHECK (
  cod_settlement_status IN ('not_applicable', 'unsettled', 'settled')
);
ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS cod_settled_at timestamptz;
ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS cod_settlement_ref text;

UPDATE carrier_shipments s
SET cod_settlement_status = CASE
  WHEN COALESCE(s.cod_amount_vnd, 0) = 0 THEN 'not_applicable'
  WHEN EXISTS (SELECT 1 FROM orders o WHERE o.id = s.order_id AND o.payment_status = 'paid') THEN 'settled'
  ELSE 'unsettled'
END
WHERE s.cod_settlement_status = 'unsettled';

-- 3. P1-07: Nhật ký sự kiện webhook bất biến chống replay và sự kiện trùng lặp
CREATE TABLE IF NOT EXISTS carrier_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id text NOT NULL CHECK (carrier_id IN ('viettel', 'jt', 'spx', 'ghn', 'ghtk')),
  tracking_number text NOT NULL,
  event_fingerprint text NOT NULL,
  provider_event_id text,
  provider_event_time timestamptz,
  normalized_status text NOT NULL,
  raw_status text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_webhook_events_dedupe_unique UNIQUE (carrier_id, tracking_number, event_fingerprint)
);

CREATE INDEX IF NOT EXISTS carrier_webhook_events_tracking_idx
  ON carrier_webhook_events(carrier_id, tracking_number, received_at DESC);

CREATE OR REPLACE FUNCTION protect_carrier_webhook_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Carrier webhook events are append-only';
END $$;

DROP TRIGGER IF EXISTS protect_carrier_webhook_events ON carrier_webhook_events;
CREATE TRIGGER protect_carrier_webhook_events
  BEFORE UPDATE OR DELETE ON carrier_webhook_events
  FOR EACH ROW EXECUTE FUNCTION protect_carrier_webhook_events();
