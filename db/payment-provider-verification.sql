ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE payment_channel_connections ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE payment_channel_connections ADD COLUMN IF NOT EXISTS reachable boolean;
ALTER TABLE payment_channel_connections ADD COLUMN IF NOT EXISTS verification_scope text;

-- Earlier releases inferred authenticated verification from public HTTP probes.
-- Those records cannot attest merchant credentials and must be checked again.
UPDATE payment_channel_connections
SET verified_at=NULL, verification_nonce=NULL, verification_scope=NULL,
    last_method=CASE WHEN channel_id IN ('cod','bank_transfer')
      THEN 'configuration_validation' ELSE 'legacy_unverified' END,
    updated_at=now();
