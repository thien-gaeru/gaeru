CREATE TABLE order_after_sales (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES orders(id),
 kind text NOT NULL CHECK(kind IN ('cancellation','return')),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','received','resolved','rejected')),
 reason text NOT NULL,
 resolution text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX order_after_sales_open ON order_after_sales(order_id) WHERE status NOT IN ('resolved','rejected');
CREATE INDEX order_after_sales_status ON order_after_sales(status,created_at DESC);
