CREATE TABLE IF NOT EXISTS care_message_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_id uuid NOT NULL REFERENCES care_requests(id) ON DELETE CASCADE,
  message_id bigint NOT NULL UNIQUE REFERENCES care_messages(id) ON DELETE CASCADE,
  name text NOT NULL,
  mime text NOT NULL,
  content bytea NOT NULL CHECK(octet_length(content) <= 10485760),
  byte_size integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_message_files_care ON care_message_files(care_id);

CREATE TABLE IF NOT EXISTS care_email_preferences (
  customer_id uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  notify_on_response boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS care_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_id uuid NOT NULL REFERENCES care_requests(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES care_messages(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','skipped','unknown')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  finished_at timestamptz,
  result text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_email_outbox_care_message_unique UNIQUE(care_id, message_id)
);
CREATE INDEX IF NOT EXISTS care_email_outbox_pending ON care_email_outbox(created_at) WHERE status = 'pending';
