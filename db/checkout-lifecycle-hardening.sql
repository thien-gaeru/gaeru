-- Hardening migration: P0, P1 & P2 audit remediation (supplementary migration)
-- Automatically executed on production databases where audit-hardening.sql has already run.
-- 1. Safe warehouse_stock non-negative check constraint with existence check (P1-1 / Issue F)
-- 2. payment_attempts provider_request_id unique index for active sessions (P0-03)
-- 3. payment_attempts status check constraint including expiry_awaiting_verification (P1-01)
-- 4. orders checkout_payload_hash immutable fingerprint column & index (P2-01)

-- 1. warehouse_stock non-negative check constraint (idempotent and safe against missing table or existing negative rows)
DO $$
BEGIN
  IF to_regclass('warehouse_stock') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'warehouse_stock'::regclass
        AND (conname = 'warehouse_stock_quantity_nonnegative_chk' OR (contype = 'c' AND pg_get_constraintdef(oid) LIKE '%quantity >= 0%'))
    ) THEN
      IF EXISTS (SELECT 1 FROM warehouse_stock WHERE quantity < 0) THEN
        ALTER TABLE warehouse_stock
          ADD CONSTRAINT warehouse_stock_quantity_nonnegative_chk CHECK (quantity >= 0) NOT VALID;
        RAISE NOTICE 'Bảng warehouse_stock có bản ghi quantity < 0. Đã áp dụng CHECK (quantity >= 0) NOT VALID. Dữ liệu hiện tại được bảo toàn, cần xử lý nghiệp vụ trước khi VALIDATE.';
      ELSE
        ALTER TABLE warehouse_stock
          ADD CONSTRAINT warehouse_stock_quantity_nonnegative_chk CHECK (quantity >= 0);
      END IF;
    END IF;
  END IF;
END $$;

-- 2. payment_attempts provider_request_id unique index (safe against existing duplicates)
DO $$
BEGIN
  IF to_regclass('payment_attempts') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'payment_attempts'
        AND indexname = 'idx_payment_attempts_provider_request_id'
    ) THEN
      IF EXISTS (
        SELECT provider_request_id
        FROM payment_attempts
        WHERE provider_request_id IS NOT NULL
        GROUP BY provider_request_id
        HAVING count(*) > 1
      ) THEN
        RAISE WARNING 'Bảng payment_attempts chứa các bản ghi trùng lặp provider_request_id. Tạo index thông thường (không UNIQUE) để tránh gián đoạn migration. Vui lòng đối soát và xử lý trùng lặp dữ liệu trước khi nâng cấp thành UNIQUE INDEX.';
        CREATE INDEX idx_payment_attempts_provider_request_id
          ON payment_attempts (provider_request_id)
          WHERE provider_request_id IS NOT NULL;
      ELSE
        CREATE UNIQUE INDEX idx_payment_attempts_provider_request_id
          ON payment_attempts (provider_request_id)
          WHERE provider_request_id IS NOT NULL;
      END IF;
    END IF;
  END IF;
END $$;

-- 3. payment_attempts status check constraint with expiry_awaiting_verification
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_attempts'::regclass
      AND conname = 'payment_attempts_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%expiry_awaiting_verification%'
  ) THEN
    ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_status_check;
    ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
      CHECK (status IN (
        'pending',
        'payment_initiation_unknown',
        'awaiting_reconciliation',
        'expiry_awaiting_verification',
        'paid',
        'failed',
        'cancelled'
      ));
  END IF;
END $$;

-- 4. orders checkout_payload_hash column & index
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS checkout_payload_hash text;

CREATE INDEX IF NOT EXISTS idx_orders_checkout_payload_hash
  ON orders (checkout_payload_hash)
  WHERE checkout_payload_hash IS NOT NULL;
