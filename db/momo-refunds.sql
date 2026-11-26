-- Durable MoMo refund ledger (POST /v2/gateway/api/refund & /v2/gateway/api/refund/query).
-- Uses 3-phase non-blocking execution so no DB connection or row lock is held during
-- MoMo's >=30s HTTP calls, while strictly preventing duplicate or over-limit refunds.
CREATE TABLE IF NOT EXISTS momo_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_attempt_id uuid REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  order_number text NOT NULL,
  refund_order_id text NOT NULL UNIQUE,
  request_id text NOT NULL UNIQUE,
  original_trans_id bigint NOT NULL CHECK (original_trans_id > 0),
  refund_trans_id text,
  amount_vnd integer NOT NULL CHECK (amount_vnd >= 1000 AND amount_vnd <= 50000000),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending_provider'
    CHECK (status IN ('pending_provider', 'pending', 'succeeded', 'failed', 'ambiguous')),
  result_code text,
  provider_message text,
  refund_trans_snapshot jsonb,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  request_key text UNIQUE,
  created_by text NOT NULL,
  last_checked_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS momo_refunds_order_id_idx
  ON momo_refunds(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS momo_refunds_pending_idx
  ON momo_refunds(status, updated_at)
  WHERE status IN ('pending_provider', 'pending', 'ambiguous');
