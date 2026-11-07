-- owner-order-purge-override.sql
-- Cập nhật trigger protect_sales_receipt() và protect_cod_settlement_allocations()
-- Cho phép Quản Trị Tối Cao (Owner) xóa vĩnh viễn đơn hàng mà không có bất kỳ hạn chế nào
-- khi session setting 'gaeru.allow_owner_order_purge' = 'on'.
-- Đối với nhân viên được phân quyền, trigger vẫn bảo vệ nghiêm ngặt tính bất biến append-only.

CREATE OR REPLACE FUNCTION protect_sales_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('gaeru.allow_owner_order_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Sales receipts are append-only';
END $$;

CREATE OR REPLACE FUNCTION protect_cod_settlement_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('gaeru.allow_owner_order_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'COD settlement allocations are append-only';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales_receipts') THEN
    DROP TRIGGER IF EXISTS protect_sales_receipt ON sales_receipts;
    CREATE TRIGGER protect_sales_receipt
      BEFORE UPDATE OR DELETE ON sales_receipts
      FOR EACH ROW EXECUTE FUNCTION protect_sales_receipt();
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cod_settlement_allocations') THEN
    DROP TRIGGER IF EXISTS protect_cod_settlement_allocations ON cod_settlement_allocations;
    CREATE TRIGGER protect_cod_settlement_allocations
      BEFORE UPDATE OR DELETE ON cod_settlement_allocations
      FOR EACH ROW EXECUTE FUNCTION protect_cod_settlement_allocations();
  END IF;
END $$;
