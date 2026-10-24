ALTER TABLE products ADD COLUMN IF NOT EXISTS card_title text NOT NULL DEFAULT '' CHECK (length(card_title)<=100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS card_summary text NOT NULL DEFAULT '' CHECK (length(card_summary)<=240);
