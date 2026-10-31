-- Migration bổ sung: checkout-lifecycle-hardening-v3.sql
-- Mục đích:
-- 1. Sửa kiểm tra và nâng cấp an toàn UNIQUE INDEX thanh toán: (provider, provider_request_id) WHERE provider_request_id IS NOT NULL.
-- 2. Hậu kiểm bằng PostgreSQL catalog để đảm bảo index đúng bảng, đúng cặp cột, đúng điều kiện lọc và đạt thuộc tính UNIQUE.
-- 3. Tạo index mới và kiểm tra tương thích trước khi thay thế, tuyệt đối không drop index cũ trước khi index mới sẵn sàng.

DO $$
DECLARE
  v_table text;
  v_unique boolean;
  v_cols text[];
  v_pred text;
  needs_upgrade boolean := false;
  dup_count int;
BEGIN
  IF to_regclass('payment_attempts') IS NOT NULL THEN
    -- 1. Kiểm tra định nghĩa index hiện tại trong PostgreSQL catalog
    SELECT 
      tbl.relname,
      i.indisunique,
      ARRAY(
        SELECT a.attname 
        FROM pg_attribute a 
        WHERE a.attrelid = tbl.oid AND a.attnum = ANY(i.indkey)
        ORDER BY array_position(i.indkey, a.attnum)
      ),
      pg_get_expr(i.indpred, i.indrelid)
    INTO v_table, v_unique, v_cols, v_pred
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    WHERE idx.relname = 'idx_payment_attempts_provider_request_id';

    -- Đánh giá xem index hiện tại có đáp ứng chính xác yêu cầu không:
    -- Bảng: payment_attempts, Thuộc tính: UNIQUE, Cặp cột: (provider, provider_request_id), Điều kiện: provider_request_id IS NOT NULL
    IF v_table IS NULL 
       OR v_unique IS NOT TRUE 
       OR v_cols <> ARRAY['provider', 'provider_request_id'] 
       OR v_pred NOT LIKE '%provider_request_id IS NOT NULL%' THEN
      needs_upgrade := true;
    END IF;

    IF needs_upgrade THEN
      -- Kiểm tra xem có bản ghi trùng lặp (provider, provider_request_id) không
      SELECT count(*) INTO dup_count
      FROM (
        SELECT provider, provider_request_id
        FROM payment_attempts
        WHERE provider_request_id IS NOT NULL
        GROUP BY provider, provider_request_id
        HAVING count(*) > 1
      ) dups;

      IF dup_count > 0 THEN
        RAISE EXCEPTION 'MIGRATION_BLOCKED: Phát hiện % nhóm bản ghi trùng lặp (provider, provider_request_id) trong payment_attempts. Vui lòng đối soát dữ liệu trước khi nâng cấp UNIQUE INDEX.', dup_count;
      END IF;

      -- Bước 2: Tạo index mới idx_payment_attempts_provider_req_id_v3 trước (KHÔNG xóa index cũ trước)
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_provider_req_id_v3
        ON payment_attempts (provider, provider_request_id)
        WHERE provider_request_id IS NOT NULL;

      -- Bước 3: Xác minh index mới bằng PostgreSQL catalog
      SELECT 
        tbl.relname,
        i.indisunique,
        ARRAY(
          SELECT a.attname 
          FROM pg_attribute a 
          WHERE a.attrelid = tbl.oid AND a.attnum = ANY(i.indkey)
          ORDER BY array_position(i.indkey, a.attnum)
        ),
        pg_get_expr(i.indpred, i.indrelid)
      INTO v_table, v_unique, v_cols, v_pred
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_class tbl ON tbl.oid = i.indrelid
      WHERE idx.relname = 'idx_payment_attempts_provider_req_id_v3';

      IF v_table <> 'payment_attempts' 
         OR v_unique IS NOT TRUE 
         OR v_cols <> ARRAY['provider', 'provider_request_id'] 
         OR v_pred NOT LIKE '%provider_request_id IS NOT NULL%' THEN
        RAISE EXCEPTION 'VERIFICATION_FAILED: Chỉ mục mới idx_payment_attempts_provider_req_id_v3 không đạt chuẩn catalog PostgreSQL.';
      END IF;

      -- Bước 4: Khi index mới đã được tạo và xác minh an toàn 100%, xóa index cũ sai thiết kế
      DROP INDEX IF EXISTS idx_payment_attempts_provider_request_id;

      -- Bước 5: Đổi tên index mới sang tên định danh chuẩn mực
      ALTER INDEX idx_payment_attempts_provider_req_id_v3 RENAME TO idx_payment_attempts_provider_request_id;
    END IF;

    -- Bước 6: Hậu kiểm catalog cuối cùng trên idx_payment_attempts_provider_request_id
    SELECT 
      tbl.relname,
      i.indisunique,
      ARRAY(
        SELECT a.attname 
        FROM pg_attribute a 
        WHERE a.attrelid = tbl.oid AND a.attnum = ANY(i.indkey)
        ORDER BY array_position(i.indkey, a.attnum)
      ),
      pg_get_expr(i.indpred, i.indrelid)
    INTO v_table, v_unique, v_cols, v_pred
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    WHERE idx.relname = 'idx_payment_attempts_provider_request_id';

    IF v_table <> 'payment_attempts' 
       OR v_unique IS NOT TRUE 
       OR v_cols <> ARRAY['provider', 'provider_request_id'] 
       OR v_pred NOT LIKE '%provider_request_id IS NOT NULL%' THEN
      RAISE EXCEPTION 'POST_VERIFICATION_FAILED: idx_payment_attempts_provider_request_id không thỏa mãn catalog chuẩn: table=%, unique=%, cols=%, pred=%',
        v_table, v_unique, v_cols, v_pred;
    END IF;
  END IF;
END $$;
