ALTER TABLE shopping_chat_threads ADD COLUMN handoff_offered_at timestamptz;
ALTER TABLE shopping_chat_threads ADD COLUMN handoff_started_at timestamptz;
UPDATE shopping_chat_threads SET handoff_started_at=updated_at WHERE handling_mode='human';
