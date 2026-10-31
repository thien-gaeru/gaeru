-- Script tiền kiểm (Pre-check Diagnostic) trước khi chạy db/checkout-lifecycle-hardening.sql
-- Mục đích: Phát hiện các bất thường dữ liệu trước khi thêm ràng buộc toàn vẹn mà không sửa đổi hoặc xóa dữ liệu.

-- 1. Tiền kiểm tồn kho âm trên warehouse_stock
SELECT 
  warehouse_id,
  variant_id,
  quantity,
  updated_at,
  'WARNING: Tồn kho âm cần kiểm kê điều chỉnh trước khi VALIDATE constraint' AS issue
FROM warehouse_stock
WHERE quantity < 0;

-- 2. Tiền kiểm mã yêu cầu cổng trùng lặp trên payment_attempts theo (provider, provider_request_id)
SELECT 
  provider,
  provider_request_id,
  count(*) AS duplicate_count,
  array_agg(id) AS attempt_ids,
  array_agg(order_id) AS order_ids,
  'WARNING: (provider, provider_request_id) bị trùng lặp cần đối soát trước khi nâng cấp thành UNIQUE INDEX' AS issue
FROM payment_attempts
WHERE provider_request_id IS NOT NULL
GROUP BY provider, provider_request_id
HAVING count(*) > 1;

-- 2b. Kiểm tra chỉ mục idx_payment_attempts_provider_request_id hiện tại có phải TRUE UNIQUE INDEX không
SELECT 
  c.relname AS index_name,
  i.indisunique AS is_unique,
  CASE 
    WHEN i.indisunique = true THEN 'OK: Chỉ mục là TRUE UNIQUE INDEX'
    ELSE 'CRITICAL: Chỉ mục đang là index thường (bị suy yếu); cần đối soát trùng lặp và nâng cấp'
  END AS uniqueness_status
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'idx_payment_attempts_provider_request_id';

-- 2c. Tự động cách ly các bản ghi trùng lặp vào bảng quarantine để đối soát trước khi chạy migration v2
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

INSERT INTO payment_attempts_quarantine_duplicates (
  attempt_id, order_id, provider, provider_request_id, transaction_ref, amount_vnd, status, reason
)
SELECT 
  pa.id, pa.order_id, pa.provider, pa.provider_request_id, pa.transaction_ref, pa.amount_vnd, pa.status,
  'Trùng lặp khóa (provider, provider_request_id) phát hiện trong pre-check'
FROM payment_attempts pa
WHERE (pa.provider, pa.provider_request_id) IN (
  SELECT provider, provider_request_id
  FROM payment_attempts
  WHERE provider_request_id IS NOT NULL
  GROUP BY provider, provider_request_id
  HAVING count(*) > 1
);

-- 3. Tiền kiểm trạng thái không xác định trên payment_attempts
SELECT 
  status,
  count(*) AS count,
  CASE 
    WHEN status IN ('pending', 'payment_initiation_unknown', 'awaiting_reconciliation', 'expiry_awaiting_verification', 'paid', 'failed', 'cancelled') THEN 'OK'
    ELSE 'UNKNOWN_STATUS: Cần chuyển đổi trước khi áp dụng status check constraint'
  END AS check_result
FROM payment_attempts
GROUP BY status;

-- 4. Tiền kiểm cột checkout_payload_hash trên orders
SELECT 
  column_name, 
  data_type 
FROM information_schema.columns 
WHERE table_name = 'orders' AND column_name = 'checkout_payload_hash';
