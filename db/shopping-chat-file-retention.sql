ALTER TABLE shopping_chat_files ALTER COLUMN content DROP NOT NULL;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS deletion_reason text
 CHECK(deletion_reason IN ('retention','admin'));
CREATE INDEX IF NOT EXISTS shopping_chat_files_retention
 ON shopping_chat_files(created_at,id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS shopping_chat_file_cleanup (
 storage_key text PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 next_attempt_at timestamptz NOT NULL DEFAULT now()
);
