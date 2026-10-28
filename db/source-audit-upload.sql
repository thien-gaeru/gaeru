-- Additive migration. Do not rewrite any previous, already-applied migration.
ALTER TABLE shopping_chat_upload_sessions
  ADD COLUMN IF NOT EXISTS chunk_hashes jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE shopping_chat_upload_sessions
  ADD COLUMN IF NOT EXISTS completed_file_id uuid REFERENCES shopping_chat_files(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS shopping_chat_upload_expiry_idx
  ON shopping_chat_upload_sessions(updated_at);
-- Expired partial uploads can contain private data; reclaim them on migration.
DELETE FROM shopping_chat_upload_sessions
  WHERE updated_at < now() - interval '1 hour';
