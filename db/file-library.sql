CREATE TABLE media_library_folders (
 id uuid PRIMARY KEY, scope text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(scope,name)
);
CREATE TABLE media_library_files (
 storage_key text PRIMARY KEY, name text NOT NULL, mime_type text NOT NULL,
 byte_size bigint NOT NULL CHECK(byte_size>0), sha256 text NOT NULL,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
