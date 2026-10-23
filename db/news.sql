CREATE TABLE news_images (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),content bytea NOT NULL,mime_type text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE news_posts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),slug text NOT NULL UNIQUE,title text NOT NULL,
 excerpt text NOT NULL,body text NOT NULL,cover_id uuid NOT NULL REFERENCES news_images(id),
 image_alt text NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 version integer NOT NULL DEFAULT 1,published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX news_public_order ON news_posts(published_at DESC,id) WHERE status='published';
