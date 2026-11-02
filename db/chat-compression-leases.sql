ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS compression_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS compression_lease uuid;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS compression_lease_until timestamptz;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS compression_next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS compression_last_error text;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS original_content bytea;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS original_mime text;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS original_name text;
CREATE INDEX IF NOT EXISTS shopping_chat_compression_due ON shopping_chat_files(compression_status,compression_next_attempt_at) WHERE deleted_at IS NULL;
