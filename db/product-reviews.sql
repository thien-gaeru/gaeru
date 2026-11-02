CREATE TABLE IF NOT EXISTS product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
  title text,
  comment text NOT NULL CHECK (length(comment) >= 5),
  is_verified_buyer boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'hidden')),
  moderator_note text,
  moderated_by uuid,
  moderated_at timestamptz,
  admin_reply text,
  admin_replied_at timestamptz,
  helpful_count integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Reconcile legacy product_reviews schema if table pre-existed from platform-upgrades-phase2.sql
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS customer_email text;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS rating integer;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS comment text;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS is_verified_buyer boolean NOT NULL DEFAULT false;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS moderator_note text;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS moderated_by uuid;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS moderated_at timestamptz;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS admin_reply text;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS admin_replied_at timestamptz;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS helpful_count integer NOT NULL DEFAULT 0;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
DECLARE
  v_con record;
BEGIN
  ALTER TABLE product_reviews ALTER COLUMN title DROP NOT NULL;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_reviews' AND column_name = 'product_slug'
  ) THEN
    EXECUTE 'ALTER TABLE product_reviews ALTER COLUMN product_slug DROP NOT NULL';
    EXECUTE '
      UPDATE product_reviews pr
      SET product_id = p.id
      FROM products p
      WHERE pr.product_id IS NULL AND p.slug = pr.product_slug
    ';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_reviews' AND column_name = 'author_name'
  ) THEN
    EXECUTE 'ALTER TABLE product_reviews ALTER COLUMN author_name DROP NOT NULL';
    EXECUTE '
      UPDATE product_reviews
      SET customer_name = COALESCE(NULLIF(btrim(customer_name), ''''), NULLIF(btrim(author_name), ''''), ''Khách hàng'')
      WHERE customer_name IS NULL OR btrim(customer_name) = ''''
    ';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_reviews' AND column_name = 'media_urls'
  ) THEN
    EXECUTE 'ALTER TABLE product_reviews ALTER COLUMN media_urls DROP NOT NULL';
    EXECUTE '
      UPDATE product_reviews
      SET images = media_urls
      WHERE (images IS NULL OR images = ''[]''::jsonb)
        AND media_urls IS NOT NULL
        AND jsonb_typeof(media_urls) = ''array''
    ';
  END IF;

  -- Remove orphan legacy rows that do not map to an existing product
  DELETE FROM product_reviews WHERE product_id IS NULL;

  UPDATE product_reviews pr
  SET customer_email = c.email
  FROM customers c
  WHERE (pr.customer_email IS NULL OR btrim(pr.customer_email) = '')
    AND pr.customer_id = c.id;

  UPDATE product_reviews
  SET customer_name = COALESCE(NULLIF(btrim(customer_name), ''), 'Khách hàng'),
      customer_email = COALESCE(customer_email, ''),
      comment = CASE
        WHEN comment IS NULL OR length(comment) < 5 THEN rpad(COALESCE(comment, ''), 5, '.')
        ELSE comment
      END
  WHERE customer_name IS NULL
     OR btrim(customer_name) = ''
     OR customer_email IS NULL
     OR comment IS NULL
     OR length(comment) < 5;

  FOR v_con IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'product_reviews'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE product_reviews DROP CONSTRAINT IF EXISTS %I', v_con.conname);
  END LOOP;

  UPDATE product_reviews
  SET status = 'pending'
  WHERE status IS NULL OR status NOT IN ('pending', 'approved', 'rejected', 'hidden');

  ALTER TABLE product_reviews ADD CONSTRAINT product_reviews_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'hidden'));

  ALTER TABLE product_reviews ALTER COLUMN product_id SET NOT NULL;
  ALTER TABLE product_reviews ALTER COLUMN customer_name SET NOT NULL;
  ALTER TABLE product_reviews ALTER COLUMN customer_email SET NOT NULL;
  ALTER TABLE product_reviews ALTER COLUMN comment SET NOT NULL;
END $$;

CREATE INDEX IF NOT EXISTS product_reviews_product_status_idx ON product_reviews(product_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS product_reviews_status_created_idx ON product_reviews(status, created_at DESC);
CREATE INDEX IF NOT EXISTS product_reviews_email_idx ON product_reviews(lower(trim(customer_email)));
CREATE INDEX IF NOT EXISTS product_reviews_order_idx ON product_reviews(order_id);

CREATE TABLE IF NOT EXISTS product_review_helpful_votes (
  review_id uuid NOT NULL REFERENCES product_reviews(id) ON DELETE CASCADE,
  voter_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, voter_key)
);

CREATE INDEX IF NOT EXISTS product_review_helpful_votes_review_idx ON product_review_helpful_votes(review_id);
