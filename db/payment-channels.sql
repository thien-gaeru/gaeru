CREATE TABLE IF NOT EXISTS payment_channel_connections (
 channel_id text PRIMARY KEY CHECK (channel_id IN ('cod','bank_transfer','vnpay','9pay','momo','zalopay')),
 config_version integer NOT NULL DEFAULT 0,
 verification_nonce uuid,
 verified_at timestamptz,
 enabled boolean NOT NULL DEFAULT false,
 last_method text,
 updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_channel_connections DROP CONSTRAINT IF EXISTS payment_channel_connections_channel_id_check;
ALTER TABLE payment_channel_connections ADD CONSTRAINT payment_channel_connections_channel_id_check
 CHECK (channel_id IN ('cod','bank_transfer','vnpay','9pay','momo','zalopay'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
 CHECK (payment_method IN ('cod', 'bank_transfer', '9pay', 'vnpay', 'momo', 'zalopay'));

ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_provider_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_provider_check
 CHECK (provider IN ('9pay', 'vnpay', 'momo', 'zalopay', 'bank_transfer'));
