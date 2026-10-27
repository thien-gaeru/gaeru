ALTER TABLE shopping_chat_files DROP CONSTRAINT IF EXISTS shopping_chat_files_content_check;
ALTER TABLE shopping_chat_files DROP CONSTRAINT IF EXISTS shopping_chat_file_size;
ALTER TABLE shopping_chat_files ADD CONSTRAINT shopping_chat_file_size CHECK(byte_size >= 1);

ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS original_byte_size bigint;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS compressed_byte_size bigint;
ALTER TABLE shopping_chat_files ADD COLUMN IF NOT EXISTS compression_status text NOT NULL DEFAULT 'pending'
  CHECK(compression_status IN ('pending','processing','compressed','optimal','failed'));

UPDATE shopping_chat_files
SET original_byte_size = COALESCE(original_byte_size, byte_size),
    compressed_byte_size = COALESCE(compressed_byte_size, byte_size)
WHERE original_byte_size IS NULL OR compressed_byte_size IS NULL;

CREATE TABLE IF NOT EXISTS shopping_chat_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES shopping_chat_threads(id) ON DELETE CASCADE,
  sender text NOT NULL CHECK(sender IN ('customer','admin')),
  request_key uuid NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  total_bytes bigint NOT NULL CHECK(total_bytes >= 1),
  total_chunks integer NOT NULL CHECK(total_chunks >= 1),
  received_chunks integer NOT NULL DEFAULT 0,
  content bytea NOT NULL DEFAULT ''::bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(thread_id, request_key)
);
