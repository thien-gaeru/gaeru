CREATE TABLE IF NOT EXISTS marketing_banner_images (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 content bytea NOT NULL CHECK (octet_length(content) <= 5242880),
 mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS banner_id uuid REFERENCES marketing_banner_images(id);
