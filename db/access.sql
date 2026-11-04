CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$'),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 160),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'sales', 'warehouse', 'accountant', 'viewer')),
  department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_accounts_username_lower_idx ON staff_accounts(lower(username));
CREATE INDEX IF NOT EXISTS staff_accounts_department_idx ON staff_accounts(department_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_username text NOT NULL,
  actor_name text NOT NULL,
  actor_role text NOT NULL,
  actor_source text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events(actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='audit_events'::regclass AND tgname='audit_events_no_change') THEN
    CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='audit_events'::regclass AND tgname='audit_events_no_truncate') THEN
    CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
      FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_event_mutation();
  END IF;
END;
$$;
