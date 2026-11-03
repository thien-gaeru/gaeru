-- Fence a checkout against deleted/replaced claims with the same request hash.
ALTER TABLE order_idempotency_keys ADD COLUMN claim_token uuid NOT NULL DEFAULT gen_random_uuid();
