CREATE TABLE product_promotions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,
 type text NOT NULL CHECK(type IN ('discount','flash')),
 kind text NOT NULL CHECK(kind IN ('fixed','percent')),
 amount integer NOT NULL CHECK(amount>0 AND amount<=20000000),
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 active boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind<>'percent' OR amount<=100)
);
CREATE TABLE product_promotion_variants (
 promotion_id uuid NOT NULL REFERENCES product_promotions(id) ON DELETE CASCADE,
 variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
 PRIMARY KEY(promotion_id,variant_id)
);
CREATE INDEX product_promotion_variant_idx ON product_promotion_variants(variant_id);
ALTER TABLE order_items ADD COLUMN original_price_vnd integer;
ALTER TABLE order_items ADD COLUMN promotion_snapshot jsonb;
