ALTER TABLE shopping_chat_threads ADD COLUMN handling_mode text NOT NULL DEFAULT 'ai' CHECK(handling_mode IN ('ai','human'));
ALTER TABLE shopping_chat_threads ADD COLUMN handoff_reason text NOT NULL DEFAULT '';
UPDATE shopping_chat_threads SET handling_mode='human' WHERE EXISTS(SELECT 1 FROM shopping_chat_messages m WHERE m.thread_id=shopping_chat_threads.id AND m.sender='admin');
UPDATE shopping_chat_threads SET awaiting_admin=false WHERE handling_mode='ai';
ALTER TABLE shopping_chat_email_outbox ADD COLUMN kind text NOT NULL DEFAULT 'session' CHECK(kind IN ('session','handoff'));
ALTER TABLE shopping_chat_email_outbox DROP CONSTRAINT shopping_chat_email_outbox_thread_id_account_key_bucket_key;
ALTER TABLE shopping_chat_email_outbox ADD UNIQUE(thread_id,account_key,bucket,kind);
CREATE OR REPLACE FUNCTION enqueue_shopping_chat_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.sender='customer' AND (SELECT count(*) FROM shopping_chat_messages WHERE thread_id=NEW.thread_id AND sender='customer')=1 THEN INSERT INTO shopping_chat_email_outbox(thread_id,account_key,bucket,kind) SELECT NEW.thread_id,account_key,floor(extract(epoch FROM now())/300)::bigint,'session' FROM shopping_chat_email_preferences WHERE enabled=true ON CONFLICT DO NOTHING; END IF;RETURN NEW;END $$;
INSERT INTO shopping_chat_email_preferences(account_key,enabled) SELECT 'owner',true FROM account_security WHERE account_key='owner' AND email IS NOT NULL AND email<>'' ON CONFLICT(account_key) DO UPDATE SET enabled=true,updated_at=now();
CREATE TABLE shopping_chat_ai_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),thread_id uuid NOT NULL REFERENCES shopping_chat_threads(id) ON DELETE CASCADE,message_id bigint NOT NULL UNIQUE REFERENCES shopping_chat_messages(id) ON DELETE CASCADE,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','skipped','failed')),created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz);
CREATE INDEX shopping_chat_ai_pending ON shopping_chat_ai_jobs(created_at) WHERE status='pending';
CREATE FUNCTION queue_shopping_chat_ai() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.sender='admin' THEN UPDATE shopping_chat_threads SET handling_mode='human' WHERE id=NEW.thread_id;
 ELSIF NEW.sender='customer' THEN
 UPDATE shopping_chat_threads SET awaiting_admin=(handling_mode='human') WHERE id=NEW.thread_id;
 IF EXISTS(SELECT 1 FROM shopping_chat_threads WHERE id=NEW.thread_id AND handling_mode='ai' AND status='open') THEN INSERT INTO shopping_chat_ai_jobs(thread_id,message_id) VALUES(NEW.thread_id,NEW.id) ON CONFLICT DO NOTHING;END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER shopping_chat_ai_insert AFTER INSERT ON shopping_chat_messages FOR EACH ROW EXECUTE FUNCTION queue_shopping_chat_ai();
