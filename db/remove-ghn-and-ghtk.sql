-- Xóa bỏ hoàn toàn GHN và GHTK khỏi hệ thống cấu hình và kết nối vận chuyển
DELETE FROM store_settings WHERE setting_key IN ('private_admin:shipping_ghn', 'private_admin:shipping_ghtk');
DELETE FROM shipping_carrier_connections WHERE carrier_id IN ('ghn', 'ghtk');

-- Cập nhật ràng buộc khóa carrier_id cho các bảng nghiệp vụ vận chuyển (chỉ chấp nhận Viettel Post, J&T Express và Shopee Express)
ALTER TABLE shipping_carrier_connections DROP CONSTRAINT IF EXISTS shipping_carrier_connections_carrier_id_check;
ALTER TABLE shipping_carrier_connections ADD CONSTRAINT shipping_carrier_connections_carrier_id_check CHECK (carrier_id IN ('viettel', 'jt', 'spx'));

ALTER TABLE order_shipping_selection DROP CONSTRAINT IF EXISTS order_shipping_selection_carrier_id_check;
ALTER TABLE order_shipping_selection ADD CONSTRAINT order_shipping_selection_carrier_id_check CHECK (carrier_id IN ('viettel', 'jt', 'spx'));

ALTER TABLE carrier_shipments DROP CONSTRAINT IF EXISTS carrier_shipments_carrier_id_check;
ALTER TABLE carrier_shipments ADD CONSTRAINT carrier_shipments_carrier_id_check CHECK (carrier_id IN ('viettel', 'jt', 'spx'));

ALTER TABLE carrier_shipment_attempts DROP CONSTRAINT IF EXISTS carrier_shipment_attempts_carrier_id_check;
ALTER TABLE carrier_shipment_attempts ADD CONSTRAINT carrier_shipment_attempts_carrier_id_check CHECK (carrier_id IN ('viettel', 'jt', 'spx'));

ALTER TABLE cod_return_intakes DROP CONSTRAINT IF EXISTS cod_return_intakes_carrier_id_check;
ALTER TABLE cod_return_intakes ADD CONSTRAINT cod_return_intakes_carrier_id_check CHECK (carrier_id IN ('viettel', 'jt', 'spx', 'standard', 'other'));
