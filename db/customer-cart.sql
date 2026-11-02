-- customer-cart.sql: Dong bo gio hang da thiet bi theo khach hang va merge strategy
CREATE TABLE IF NOT EXISTS customer_cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 99),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_cart_items_customer_variant_unique UNIQUE (customer_id, variant_id)
);

CREATE INDEX IF NOT EXISTS customer_cart_items_customer_id_idx ON customer_cart_items(customer_id);
