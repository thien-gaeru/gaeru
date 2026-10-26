CREATE TABLE site_pages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), path text NOT NULL UNIQUE,
 title text NOT NULL, description text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 builtin boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_pages_public ON site_pages(path) WHERE status='published';
