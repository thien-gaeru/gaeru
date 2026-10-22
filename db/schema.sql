CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('audio', 'video', 'accessory')),
  descriptor text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  image_alt text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_vnd integer NOT NULL CHECK (price_vnd >= 0),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_variants_product_id_idx ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS active_products_sort_order_idx ON products(active, sort_order, name);

UPDATE products SET active = false, updated_at = now() WHERE slug = 'm3';
UPDATE product_variants
SET active = false, updated_at = now()
WHERE product_id = (SELECT id FROM products WHERE slug = 'm3');

CREATE TABLE IF NOT EXISTS store_settings (
  setting_key text PRIMARY KEY,
  setting_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO store_settings (setting_key, setting_value)
VALUES
  ('shipping_note', '"Phí vận chuyển được tính theo tỉnh/thành phố đã chọn."'),
  ('bank_transfer_instructions', '""'),
  ('shipping_rates', '{}')
ON CONFLICT (setting_key) DO NOTHING;

UPDATE store_settings
SET setting_value = '"Phí vận chuyển được tính theo tỉnh/thành phố đã chọn."', updated_at = now()
WHERE setting_key = 'shipping_note'
  AND setting_value = '"Phí vận chuyển sẽ được xác nhận trước khi xử lý đơn hàng."';

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  address text NOT NULL,
  city text NOT NULL,
  note text NOT NULL DEFAULT '',
  payment_method text NOT NULL CHECK (payment_method IN ('cod', 'bank_transfer', '9pay', 'vnpay')),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled')),
  subtotal_vnd integer NOT NULL CHECK (subtotal_vnd >= 0),
  shipping_fee_vnd integer CHECK (shipping_fee_vnd IS NULL OR shipping_fee_vnd >= 0),
  total_vnd integer CHECK (total_vnd IS NULL OR total_vnd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND conname = 'orders_payment_method_check'
      AND pg_get_constraintdef(oid) ILIKE '%9pay%'
      AND pg_get_constraintdef(oid) ILIKE '%vnpay%'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
    ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
      CHECK (payment_method IN ('cod', 'bank_transfer', '9pay', 'vnpay'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at DESC);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  email text NOT NULL UNIQUE,
  phone text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS customer_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_password_reset_customer_idx
  ON customer_password_reset_tokens(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_email_verification_customer_idx
  ON customer_email_verification_tokens(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  variant_name text NOT NULL,
  sku text NOT NULL,
  unit_price_vnd integer NOT NULL CHECK (unit_price_vnd >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  line_total_vnd integer NOT NULL CHECK (line_total_vnd >= 0)
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('9pay', 'vnpay')),
  transaction_ref text NOT NULL UNIQUE,
  amount_vnd integer NOT NULL CHECK (amount_vnd > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
  provider_transaction_id text,
  response_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_attempts_order_id_idx ON payment_attempts(order_id, created_at DESC);
