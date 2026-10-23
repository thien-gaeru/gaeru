CREATE TABLE customer_addresses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 label text NOT NULL, full_name text NOT NULL, phone text NOT NULL,
 address text NOT NULL, city text NOT NULL,
 is_default boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_address_default ON customer_addresses(customer_id) WHERE is_default;
ALTER TABLE orders ADD COLUMN customer_id uuid REFERENCES customers(id);
CREATE INDEX orders_customer_created ON orders(customer_id, created_at DESC);
