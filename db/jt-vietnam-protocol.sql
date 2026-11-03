-- Account validation is not fulfillment/provider acceptance. Invalidate legacy
-- J&T verification so old JSON wire assumptions cannot enable checkout.
ALTER TABLE shipping_carrier_connections ADD COLUMN IF NOT EXISTS verified_protocol text;
ALTER TABLE shipping_carrier_connections ADD COLUMN IF NOT EXISTS verified_environment text;
ALTER TABLE shipping_carrier_connections ADD COLUMN IF NOT EXISTS verification_scope text;
UPDATE shipping_carrier_connections
SET verified_at=NULL, enabled=false, verified_protocol=NULL,
    verified_environment=NULL, verification_scope=NULL, updated_at=now()
WHERE carrier_id='jt' AND verified_protocol IS NULL;
