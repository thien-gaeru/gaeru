CREATE TABLE care_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 care_id uuid NOT NULL REFERENCES care_requests(id),
 sender text NOT NULL CHECK(sender IN ('customer','staff')),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 3000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_messages_thread ON care_messages(care_id,id);
INSERT INTO care_messages(care_id,sender,body,created_at) SELECT id,'staff',response,updated_at FROM care_requests WHERE response<>'';
