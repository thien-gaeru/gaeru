-- Claim carrier requests durably before crossing the provider boundary. A lost
-- response, process crash or rolled-back finalization must never send again.
CREATE TABLE carrier_shipment_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 carrier_id text NOT NULL CHECK(carrier_id IN ('viettel','jt','spx')),
 config_version integer NOT NULL,
 status text NOT NULL DEFAULT 'sending' CHECK(status IN ('sending','unknown','succeeded','reconciled')),
 provider_result jsonb,
 result text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX carrier_shipment_unresolved_attempt ON carrier_shipment_attempts(order_id) WHERE status IN ('sending','unknown');

ALTER TABLE shopping_chat_email_outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0;
ALTER TABLE shopping_chat_email_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
