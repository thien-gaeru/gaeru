CREATE TABLE marketing_email_campaigns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),title text NOT NULL,subject text NOT NULL,body text NOT NULL,
 sources jsonb NOT NULL,scheduled_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','completed','cancelled')),
 rate_per_minute integer NOT NULL DEFAULT 6 CHECK(rate_per_minute BETWEEN 1 AND 12),next_send_at timestamptz,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketing_email_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid NOT NULL REFERENCES marketing_email_campaigns(id) ON DELETE CASCADE,
 email text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','skipped')),
 unsubscribe_hash text UNIQUE,attempted_at timestamptz,finished_at timestamptz,result text NOT NULL DEFAULT '',
 UNIQUE(campaign_id,email)
);
CREATE INDEX marketing_email_queue_idx ON marketing_email_recipients(campaign_id,status);
CREATE TABLE marketing_email_suppressions(email text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
