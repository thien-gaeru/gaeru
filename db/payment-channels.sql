CREATE TABLE IF NOT EXISTS payment_channel_connections (
 channel_id text PRIMARY KEY CHECK (channel_id IN ('cod','bank_transfer','vnpay','9pay')),
 config_version integer NOT NULL DEFAULT 0,
 verification_nonce uuid,
 verified_at timestamptz,
 enabled boolean NOT NULL DEFAULT false,
 last_method text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
