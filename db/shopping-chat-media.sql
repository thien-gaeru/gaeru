ALTER TABLE shopping_chat_messages DROP CONSTRAINT shopping_chat_messages_sender_check;
ALTER TABLE shopping_chat_messages ADD CONSTRAINT shopping_chat_messages_sender_check CHECK(sender IN ('customer','admin','ai'));
CREATE TABLE shopping_chat_files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),message_id bigint NOT NULL UNIQUE REFERENCES shopping_chat_messages(id) ON DELETE CASCADE,thread_id uuid NOT NULL REFERENCES shopping_chat_threads(id) ON DELETE CASCADE,name text NOT NULL,mime text NOT NULL,content bytea NOT NULL CHECK(octet_length(content)<=10485760),created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX shopping_chat_files_thread ON shopping_chat_files(thread_id);
