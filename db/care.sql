CREATE TABLE care_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES customers(id),
 order_id uuid NOT NULL REFERENCES orders(id),
 request_key uuid NOT NULL,
 subject text NOT NULL, description text NOT NULL,
 status text NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','reviewing','waiting_customer','resolved','closed')),
 response text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,request_key)
);
CREATE INDEX care_customer_created ON care_requests(customer_id,created_at DESC);
