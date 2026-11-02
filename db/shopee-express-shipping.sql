ALTER TABLE shipping_carrier_connections DROP CONSTRAINT IF EXISTS shipping_carrier_connections_carrier_id_check;
ALTER TABLE shipping_carrier_connections ADD CONSTRAINT shipping_carrier_connections_carrier_id_check CHECK (carrier_id IN ('ghn','ghtk','viettel','jt','spx'));
ALTER TABLE order_shipping_selection DROP CONSTRAINT IF EXISTS order_shipping_selection_carrier_id_check;
ALTER TABLE order_shipping_selection ADD CONSTRAINT order_shipping_selection_carrier_id_check CHECK (carrier_id IN ('ghn','ghtk','viettel','jt','spx'));
