-- Migration: Multi-provider Authentication Identities (Google Sign-In & Social Logins)
-- Standardizes identity federation with composite uniqueness on (provider, issuer, provider_subject)
-- Prevents email-based account takeover and enables secure multi-account linking/unlinking

CREATE TABLE IF NOT EXISTS auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL,
  issuer VARCHAR(255) NOT NULL,
  provider_subject VARCHAR(255) NOT NULL,
  email_at_link VARCHAR(254),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_auth_provider_issuer_sub UNIQUE(provider, issuer, provider_subject)
);

CREATE INDEX IF NOT EXISTS ix_auth_identities_customer ON auth_identities(customer_id);
CREATE INDEX IF NOT EXISTS ix_auth_identities_provider_sub ON auth_identities(provider, provider_subject);

-- Backfill from legacy customers.google_id column if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'customers' AND column_name = 'google_id'
  ) THEN
    INSERT INTO auth_identities (customer_id, provider, issuer, provider_subject, email_at_link)
    SELECT id, 'google', 'https://accounts.google.com', google_id, email
    FROM customers
    WHERE google_id IS NOT NULL AND google_id != ''
    ON CONFLICT (provider, issuer, provider_subject) DO NOTHING;
  END IF;
END $$;
