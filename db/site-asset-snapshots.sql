CREATE TABLE site_asset_snapshots (
 path text PRIMARY KEY,
 storage_key text NOT NULL,
 mime_type text NOT NULL,
 byte_size bigint NOT NULL CHECK(byte_size>0),
 sha256 text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
