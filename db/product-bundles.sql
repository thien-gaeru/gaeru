CREATE TABLE IF NOT EXISTS product_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  discount_type text NOT NULL CHECK (discount_type IN ('fixed', 'percent')),
  discount_value integer NOT NULL CHECK (discount_value > 0),
  active boolean NOT NULL DEFAULT true,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (discount_type <> 'percent' OR discount_value <= 100)
);

-- Reconcile legacy product_bundles schema if table pre-existed from platform-upgrades-phase2.sql
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS discount_type text;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS discount_value integer;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS ends_at timestamptz;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE product_bundles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
DECLARE
  has_bundle_title boolean;
  has_discount_percent boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_bundles' AND column_name = 'main_product_slug'
  ) THEN
    EXECUTE 'ALTER TABLE product_bundles ALTER COLUMN main_product_slug DROP NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_bundles' AND column_name = 'bundle_product_slug'
  ) THEN
    EXECUTE 'ALTER TABLE product_bundles ALTER COLUMN bundle_product_slug DROP NOT NULL';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_bundles' AND column_name = 'bundle_title'
  ) INTO has_bundle_title;

  IF has_bundle_title THEN
    EXECUTE 'ALTER TABLE product_bundles ALTER COLUMN bundle_title DROP NOT NULL';
    EXECUTE 'UPDATE product_bundles SET title = COALESCE(NULLIF(btrim(title), ''''), NULLIF(btrim(bundle_title), ''''), ''Combo ưu đãi'') WHERE title IS NULL OR btrim(title) = ''''';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_bundles' AND column_name = 'discount_percent'
  ) INTO has_discount_percent;

  IF has_discount_percent THEN
    EXECUTE 'ALTER TABLE product_bundles DROP CONSTRAINT IF EXISTS product_bundles_discount_percent_check';
    EXECUTE 'ALTER TABLE product_bundles ALTER COLUMN discount_percent DROP NOT NULL';
    EXECUTE '
      UPDATE product_bundles
      SET discount_type = COALESCE(discount_type, ''percent''),
          discount_value = COALESCE(discount_value, GREATEST(1, LEAST(100, COALESCE(discount_percent, 10))))
      WHERE discount_type IS NULL OR discount_value IS NULL
    ';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'product_bundles' AND column_name = 'sort_order'
  ) THEN
    EXECUTE 'ALTER TABLE product_bundles ALTER COLUMN sort_order DROP NOT NULL';
  END IF;

  UPDATE product_bundles
  SET title = COALESCE(NULLIF(btrim(title), ''), 'Combo ưu đãi'),
      discount_type = CASE WHEN discount_type IN ('fixed', 'percent') THEN discount_type ELSE 'percent' END,
      discount_value = CASE
        WHEN discount_type = 'fixed' THEN GREATEST(1, COALESCE(discount_value, 10000))
        ELSE GREATEST(1, LEAST(100, COALESCE(discount_value, 10)))
      END,
      starts_at = COALESCE(starts_at, created_at, now()),
      ends_at = CASE
        WHEN ends_at IS NOT NULL AND ends_at > COALESCE(starts_at, created_at, now()) THEN ends_at
        ELSE COALESCE(starts_at, created_at, now()) + interval '365 days'
      END
  WHERE title IS NULL
     OR discount_type IS NULL
     OR discount_type NOT IN ('fixed', 'percent')
     OR discount_value IS NULL
     OR discount_value <= 0
     OR (discount_type = 'percent' AND discount_value > 100)
     OR starts_at IS NULL
     OR ends_at IS NULL
     OR ends_at <= COALESCE(starts_at, created_at, now());

  ALTER TABLE product_bundles ALTER COLUMN title SET NOT NULL;
  ALTER TABLE product_bundles ALTER COLUMN discount_type SET NOT NULL;
  ALTER TABLE product_bundles ALTER COLUMN discount_value SET NOT NULL;
  ALTER TABLE product_bundles ALTER COLUMN starts_at SET NOT NULL;
  ALTER TABLE product_bundles ALTER COLUMN ends_at SET NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'product_bundles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%discount_type%' AND pg_get_constraintdef(oid) ILIKE '%fixed%'
  ) THEN
    ALTER TABLE product_bundles ADD CONSTRAINT product_bundles_discount_type_check CHECK (discount_type IN ('fixed', 'percent'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'product_bundles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%discount_value > 0%'
  ) THEN
    ALTER TABLE product_bundles ADD CONSTRAINT product_bundles_discount_value_check CHECK (discount_value > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'product_bundles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%ends_at > starts_at%'
  ) THEN
    ALTER TABLE product_bundles ADD CONSTRAINT product_bundles_ends_after_starts_check CHECK (ends_at > starts_at);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'product_bundles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%discount_value <= 100%'
  ) THEN
    ALTER TABLE product_bundles ADD CONSTRAINT product_bundles_percent_cap_check CHECK (discount_type <> 'percent' OR discount_value <= 100);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS product_bundle_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id uuid NOT NULL REFERENCES product_bundles(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  min_quantity integer NOT NULL DEFAULT 1 CHECK (min_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bundle_id, variant_id)
);

CREATE INDEX IF NOT EXISTS product_bundle_items_bundle_idx ON product_bundle_items(bundle_id);
CREATE INDEX IF NOT EXISTS product_bundle_items_variant_idx ON product_bundle_items(variant_id);
