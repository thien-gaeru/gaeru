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

-- 2. Tiền kiểm mã yêu cầu cổng trùng lặp trên payment_attempts
SELECT 
  provider_request_id,
  count(*) AS duplicate_count,
  array_agg(id) AS attempt_ids,
  array_agg(order_id) AS order_ids,
  'WARNING: provider_request_id bị trùng lặp cần đối soát trước khi nâng cấp thành UNIQUE INDEX' AS issue
FROM payment_attempts
WHERE provider_request_id IS NOT NULL
GROUP BY provider_request_id
HAVING count(*) > 1;

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
