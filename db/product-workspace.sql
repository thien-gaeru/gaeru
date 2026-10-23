ALTER TABLE product_variants ADD COLUMN image_url text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN edit_version integer NOT NULL DEFAULT 1;
ALTER TABLE product_variants ADD COLUMN edit_version integer NOT NULL DEFAULT 1;
CREATE FUNCTION bump_catalog_edit_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.edit_version=OLD.edit_version+1; RETURN NEW; END $$;
CREATE TRIGGER products_edit_version BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION bump_catalog_edit_version();
CREATE TRIGGER variants_edit_version BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION bump_catalog_edit_version();
CREATE TABLE catalog_images(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),content bytea NOT NULL,mime_type text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE product_presentations(product_id uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,gallery jsonb NOT NULL DEFAULT '[]',option_groups jsonb NOT NULL DEFAULT '[]');
