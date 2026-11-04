CREATE TABLE shipping_carrier_connections (
 carrier_id text PRIMARY KEY CHECK (carrier_id IN ('ghn','ghtk','viettel','jt','spx')),
 config_version integer NOT NULL,
 verification_nonce uuid,
 verified_at timestamptz,
 enabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_shipping_selection (
 order_id uuid PRIMARY KEY REFERENCES orders(id),
 carrier_id text NOT NULL CHECK (carrier_id IN ('ghn','ghtk','viettel','jt','spx')),
 carrier_name text NOT NULL,
 fee_vnd integer NOT NULL CHECK(fee_vnd>=0),
 config_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
