ALTER TABLE marketplace_sku_mappings ADD COLUMN IF NOT EXISTS external_product_id text NOT NULL DEFAULT '';
ALTER TABLE marketplace_sku_mappings ADD COLUMN IF NOT EXISTS external_variant_id text NOT NULL DEFAULT '';
