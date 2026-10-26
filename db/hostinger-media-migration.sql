CREATE TABLE media_filesystem_jobs (
 id text PRIMARY KEY, target_identity text NOT NULL, owner_id uuid, lease_until timestamptz, state text NOT NULL DEFAULT 'pending',
 copied_objects integer NOT NULL DEFAULT 0, copied_bytes bigint NOT NULL DEFAULT 0,
 updated_references integer NOT NULL DEFAULT 0, error_code text, updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE media_filesystem_objects (
 source_key text PRIMARY KEY, target_key text NOT NULL, byte_size bigint NOT NULL, sha256 text NOT NULL,
 source_etag text, verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_filesystem_reference_backups (
 table_name text NOT NULL, row_id uuid NOT NULL, previous_content bytea NOT NULL,
 replacement_content bytea NOT NULL, migrated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(table_name,row_id)
);
