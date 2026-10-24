
CREATE TABLE marketing_vouchers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE CHECK(code=upper(code)),title text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('fixed','percent')),amount integer NOT NULL CHECK(amount>0),max_discount_vnd integer CHECK(max_discount_vnd>0),
 min_spend_vnd integer NOT NULL DEFAULT 0 CHECK(min_spend_vnd>=0),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 total_limit integer NOT NULL CHECK(total_limit>0),per_customer_limit integer NOT NULL DEFAULT 1 CHECK(per_customer_limit>0),
 public_claim boolean NOT NULL DEFAULT true,active boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(kind<>'percent' OR amount<=100)
);
CREATE TABLE customer_vouchers(customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,voucher_id uuid NOT NULL REFERENCES marketing_vouchers(id) ON DELETE RESTRICT,source text NOT NULL CHECK(source IN ('saved','granted')),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(customer_id,voucher_id));
ALTER TABLE orders ADD COLUMN discount_vnd integer NOT NULL DEFAULT 0 CHECK(discount_vnd>=0 AND discount_vnd<=subtotal_vnd);
ALTER TABLE orders ADD COLUMN voucher_code text NOT NULL DEFAULT '';
CREATE TABLE voucher_redemptions(order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,voucher_id uuid NOT NULL REFERENCES marketing_vouchers(id) ON DELETE RESTRICT,customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,discount_vnd integer NOT NULL CHECK(discount_vnd>0),released boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX voucher_redemptions_usage_idx ON voucher_redemptions(voucher_id,customer_id) WHERE released=false;
CREATE TABLE marketing_campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,body text NOT NULL,voucher_id uuid REFERENCES marketing_vouchers(id) ON DELETE RESTRICT,starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),active boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE customer_campaign_reads(customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,read_version integer NOT NULL,PRIMARY KEY(customer_id,campaign_id));
