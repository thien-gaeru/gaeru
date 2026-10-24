ALTER TABLE account_security ADD COLUMN contacts_verified_at timestamptz;
UPDATE account_security s SET contacts_verified_at=(SELECT max(created_at) FROM audit_events a WHERE a.entity_type='account' AND a.entity_id=s.account_key AND a.action='security.recovery_contacts.verified') WHERE s.account_key='owner' OR s.account_key LIKE 'staff:%';
CREATE INDEX account_security_login_email_idx ON account_security(lower(email)) WHERE contacts_verified_at IS NOT NULL;
