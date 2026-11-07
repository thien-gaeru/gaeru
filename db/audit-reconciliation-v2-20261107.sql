-- audit-reconciliation-v2-20261107.sql
-- Migration bổ sung (additive, không sửa lịch sử schema_migrations đã áp dụng)
-- Khắc phục: P0-01 (Legacy COD verification_required), P1-03 (Batch COD payout allocations),
--            P1-08 (Attestation level metadata), P2-04 (Webhook retention policy guard)

-- 1. P0-01 & P1-08: Mở rộng trạng thái đối soát COD lịch sử và mức chứng thực nguồn tiền
ALTER TABLE carrier_shipments DROP CONSTRAINT IF EXISTS carrier_shipments_cod_settlement_status_check;
ALTER TABLE carrier_shipments ADD CONSTRAINT carrier_shipments_cod_settlement_status_check CHECK (
  cod_settlement_status IN ('not_applicable', 'unsettled', 'verification_required', 'settled')
);

ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS cod_attestation_level text NOT NULL DEFAULT 'none';
ALTER TABLE carrier_shipments DROP CONSTRAINT IF EXISTS carrier_shipments_cod_attestation_level_check;
ALTER TABLE carrier_shipments ADD CONSTRAINT carrier_shipments_cod_attestation_level_check CHECK (
  cod_attestation_level IN ('none', 'manually_attested', 'statement_verified')
);

ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS cod_attested_by text;
ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS cod_evidence_ref text;
ALTER TABLE carrier_shipments ADD COLUMN IF NOT EXISTS cod_payout_period text;

-- Phân loại lại các vận đơn COD lịch sử từng được tự động đánh dấu paid/settled nhưng chưa có mã sao kê chuyển tiền thực tế:
-- Giữ nguyên 100% phiếu thu sales_receipts cũ nhưng chuyển sang 'verification_required' để kế toán đối chiếu sao kê.
UPDATE carrier_shipments s
SET cod_settlement_status = 'verification_required',
    cod_attestation_level = 'none'
WHERE COALESCE(s.cod_amount_vnd, 0) > 0
  AND s.cod_settlement_status = 'settled'
  AND (
    NULLIF(BTRIM(COALESCE(s.cod_settlement_ref, '')), '') IS NULL
    OR s.cod_settlement_ref LIKE 'SHIPPING-%'
    OR s.cod_settlement_ref LIKE 'DIRECT-%'
  );

UPDATE carrier_shipments s
SET cod_attestation_level = 'manually_attested'
WHERE COALESCE(s.cod_amount_vnd, 0) > 0
  AND s.cod_settlement_status = 'settled'
  AND s.cod_attestation_level = 'none'
  AND NULLIF(BTRIM(COALESCE(s.cod_settlement_ref, '')), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS carrier_shipments_cod_settlement_idx
  ON carrier_shipments(cod_settlement_status, carrier_id, created_at DESC)
  WHERE cod_amount_vnd > 0;

-- 2. P1-03 & P1-08: Bảng lô chi trả COD (cod_settlement_batches) và phân bổ từng vận đơn (cod_settlement_allocations)
CREATE TABLE IF NOT EXISTS cod_settlement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id text NOT NULL CHECK (carrier_id IN ('viettel', 'jt', 'spx', 'ghn', 'ghtk')),
  provider_transaction_ref text NOT NULL,
  declared_payout_vnd bigint CHECK (declared_payout_vnd IS NULL OR declared_payout_vnd > 0),
  allocated_total_vnd bigint NOT NULL DEFAULT 0 CHECK (allocated_total_vnd >= 0),
  method text NOT NULL DEFAULT 'bank_transfer' CHECK (method IN ('cash', 'bank_transfer')),
  payout_period text,
  evidence_ref text,
  note text,
  attestation_level text NOT NULL DEFAULT 'manually_attested'
    CHECK (attestation_level IN ('manually_attested', 'statement_verified')),
  created_by text NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cod_settlement_batches_carrier_ref_unique UNIQUE (carrier_id, provider_transaction_ref),
  CONSTRAINT cod_settlement_batches_cap_check CHECK (declared_payout_vnd IS NULL OR allocated_total_vnd <= declared_payout_vnd)
);

CREATE TABLE IF NOT EXISTS cod_settlement_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES cod_settlement_batches(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  shipment_id uuid NOT NULL REFERENCES carrier_shipments(id),
  allocated_amount_vnd bigint NOT NULL CHECK (allocated_amount_vnd > 0),
  receipt_id uuid REFERENCES sales_receipts(id),
  was_legacy_verified boolean NOT NULL DEFAULT false,
  request_key text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cod_settlement_allocations_order_unique UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS cod_settlement_allocations_batch_idx
  ON cod_settlement_allocations(batch_id, created_at ASC);

CREATE OR REPLACE FUNCTION protect_cod_settlement_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'COD settlement allocations are append-only';
END $$;

DROP TRIGGER IF EXISTS protect_cod_settlement_allocations ON cod_settlement_allocations;
CREATE TRIGGER protect_cod_settlement_allocations
  BEFORE UPDATE OR DELETE ON cod_settlement_allocations
  FOR EACH ROW EXECUTE FUNCTION protect_cod_settlement_allocations();

-- 3. P2-04: Giữ tính bất biến của carrier_webhook_events nhưng cho phép quy trình dọn dẹp dữ liệu hết hạn lưu trữ (>= 90 ngày)
CREATE OR REPLACE FUNCTION protect_carrier_webhook_events() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('gaeru.allow_webhook_retention_purge', true) = 'on'
     AND OLD.received_at < now() - interval '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Carrier webhook events are append-only';
END $$;
