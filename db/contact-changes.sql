CREATE TABLE customer_contact_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES customers(id),
 old_email text NOT NULL,new_email text NOT NULL,old_phone text NOT NULL,new_phone text NOT NULL,
 credential_fingerprint text NOT NULL,old_token_hash text NOT NULL UNIQUE,new_token_hash text UNIQUE,
 old_confirmed boolean NOT NULL DEFAULT false,new_confirmed boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,applied_at timestamptz,cancelled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_contact_changes_owner ON customer_contact_changes(customer_id,created_at DESC);
