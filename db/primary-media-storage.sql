ALTER TABLE shopping_chat_files ADD COLUMN byte_size bigint;
UPDATE shopping_chat_files SET byte_size=octet_length(content);
CREATE FUNCTION set_shopping_chat_file_size() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.byte_size:=COALESCE(NEW.byte_size,octet_length(NEW.content));
 RETURN NEW;
END $$;
CREATE TRIGGER shopping_chat_file_size_before_insert BEFORE INSERT ON shopping_chat_files FOR EACH ROW EXECUTE FUNCTION set_shopping_chat_file_size();
ALTER TABLE shopping_chat_files ALTER COLUMN byte_size SET NOT NULL;
ALTER TABLE shopping_chat_files ADD CONSTRAINT shopping_chat_file_size CHECK(byte_size BETWEEN 1 AND 10485760);
