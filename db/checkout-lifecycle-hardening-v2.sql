-- Migration bổ sung: checkout-lifecycle-hardening-v2.sql
-- Mục đích:
-- 1. Bảo vệ tính bất biến của checkout-lifecycle-hardening.sql đã phát hành (P1-02).
-- 2. Đảm bảo ràng buộc chống trùng provider_request_id là TRUE UNIQUE INDEX, không bị suy yếu (P1-01).
-- 3. Cách ly bản ghi trùng lặp vào bảng payment_attempts_quarantine_duplicates và FAIL-CLOSED nếu còn trùng.
-- 4. Xử lý an toàn warehouse_stock CHECK constraint (NOT VALID nếu có tồn kho âm lịch sử).

-- 1. Bảng cách ly dữ liệu trùng lặp để đối soát, tuyệt đối không tự xóa giao dịch
CREATE TABLE IF NOT EXISTS payment_attempts_quarantine_duplicates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider text NOT NULL,
  provider_request_id text NOT NULL,
  transaction_ref text,
  amount_vnd bigint,
  status text,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT 'duplicate_provider_request_id'
);

-- 2. warehouse_stock non-negative check constraint (an toàn nếu có tồn kho âm lịch sử)
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
        RAISE NOTICE 'Bảng warehouse_stock có bản ghi quantity < 0. Đã áp dụng CHECK (quantity >= 0) NOT VALID.';
      ELSE
        ALTER TABLE warehouse_stock
          ADD CONSTRAINT warehouse_stock_quantity_nonnegative_chk CHECK (quantity >= 0);
      END IF;
    END IF;
  END IF;
END $$;

-- 3. payment_attempts provider_request_id TRUE UNIQUE INDEX (P1-01)
DO $$
DECLARE
  dup_count int;
  existing_is_unique boolean;
BEGIN
  IF to_regclass('payment_attempts') IS NOT NULL THEN
    -- Đếm số nhóm trùng lặp theo (provider, provider_request_id)
    SELECT count(*) INTO dup_count
    FROM (
      SELECT provider, provider_request_id
      FROM payment_attempts
      WHERE provider_request_id IS NOT NULL
      GROUP BY provider, provider_request_id
      HAVING count(*) > 1
    ) dups;

    IF dup_count > 0 THEN
      -- Cách ly dữ liệu trùng lặp vào bảng quarantine để kiểm tra, bảo toàn 100% dữ liệu gốc
      INSERT INTO payment_attempts_quarantine_duplicates (
        attempt_id, order_id, provider, provider_request_id, transaction_ref, amount_vnd, status, reason
      )
      SELECT 
        pa.id, pa.order_id, pa.provider, pa.provider_request_id, pa.transaction_ref, pa.amount_vnd, pa.status,
        'Trùng lặp khóa (provider, provider_request_id) phát hiện trong migration v2'
      FROM payment_attempts pa
      WHERE (pa.provider, pa.provider_request_id) IN (
        SELECT provider, provider_request_id
        FROM payment_attempts
        WHERE provider_request_id IS NOT NULL
        GROUP BY provider, provider_request_id
        HAVING count(*) > 1
      )
      ON CONFLICT DO NOTHING;

      -- FAIL-CLOSED: Không tự động tạo index thường làm suy yếu bảo vệ; báo lỗi để can thiệp thủ công
      RAISE EXCEPTION 'MIGRATION_BLOCKED: Phát hiện % nhóm bản ghi trùng lặp (provider, provider_request_id) trong payment_attempts. Dữ liệu đã được cách ly vào payment_attempts_quarantine_duplicates. Vui lòng đối soát dữ liệu (db/precheck-checkout-lifecycle.sql) trước khi tạo UNIQUE INDEX.', dup_count;
    END IF;

    -- Nếu index đã tồn tại nhưng KHÔNG PHẢI là UNIQUE (bị suy yếu ở lần chạy trước) -> Drop để tạo lại
    SELECT indisunique INTO existing_is_unique
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_payment_attempts_provider_request_id';

    IF existing_is_unique IS FALSE THEN
      RAISE NOTICE 'Phát hiện idx_payment_attempts_provider_request_id không phải UNIQUE index. Đang nâng cấp lên TRUE UNIQUE INDEX.';
      DROP INDEX idx_payment_attempts_provider_request_id;
    END IF;

    -- Tạo TRUE UNIQUE INDEX trên (provider, provider_request_id)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_request_id
      ON payment_attempts (provider, provider_request_id)
      WHERE provider_request_id IS NOT NULL;

    -- Tiền kiểm tra lại thực tế (Post-verification assertion)
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_payment_attempts_provider_request_id'
        AND i.indisunique = true
    ) THEN
      RAISE EXCEPTION 'VERIFICATION_FAILED: Chỉ mục idx_payment_attempts_provider_request_id không đạt chuẩn UNIQUE INDEX.';
    END IF;
  END IF;
END $$;
