CREATE TABLE IF NOT EXISTS media_upload_originals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  derivative_key text NOT NULL UNIQUE,
  original_key text NOT NULL,
  original_mime text NOT NULL,
  original_size bigint NOT NULL CHECK(original_size > 0),
  original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
