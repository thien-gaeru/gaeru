CREATE TABLE warranty_activations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES customers(id),
 order_item_id uuid NOT NULL REFERENCES order_items(id),serial text,request_key uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','active','rejected','revoked')),
 purchase_date date,expires_on date,reason text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,request_key),CHECK((purchase_date IS NULL)=(expires_on IS NULL))
);
CREATE UNIQUE INDEX warranty_serial_unique ON warranty_activations(serial) WHERE serial IS NOT NULL AND status IN('pending','active','revoked');
CREATE INDEX warranty_customer ON warranty_activations(customer_id,created_at DESC);
