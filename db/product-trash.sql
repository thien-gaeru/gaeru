-- Preserve the selection of saleable variants while the catalog entry is trashed.
ALTER TABLE products ADD COLUMN deleted_variant_state jsonb NOT NULL DEFAULT '[]'::jsonb;
