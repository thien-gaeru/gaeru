-- Durable scheduling: status queries use short DB claims and never hold a
-- connection/transaction open during MoMo's up-to-30-second HTTP request.
ALTER TABLE payment_attempts
 ADD COLUMN IF NOT EXISTS next_status_check_at timestamptz DEFAULT (now() + interval '30 seconds'),
 ADD COLUMN IF NOT EXISTS status_check_token uuid,
 ADD COLUMN IF NOT EXISTS status_check_lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS last_status_check_at timestamptz,
 ADD COLUMN IF NOT EXISTS status_check_error text;

ALTER TABLE payment_attempts
 ALTER COLUMN next_status_check_at DROP NOT NULL;

DROP INDEX IF EXISTS payment_attempts_momo_recovery_idx;
CREATE INDEX IF NOT EXISTS payment_attempts_momo_recovery_idx
 ON payment_attempts(next_status_check_at)
 WHERE provider='momo' AND status<>'paid' AND next_status_check_at IS NOT NULL;

ALTER TABLE checkout_payment_intents
 DROP CONSTRAINT IF EXISTS checkout_payment_intents_status_check,
 ADD CONSTRAINT checkout_payment_intents_status_check
   CHECK (status IN ('pending_provider', 'completed', 'released', 'expired', 'ambiguous'));

ALTER TABLE order_email_outbox
 DROP CONSTRAINT IF EXISTS order_email_outbox_kind_check,
 ADD CONSTRAINT order_email_outbox_kind_check
   CHECK (kind IN ('receipt', 'welcome', 'payment_confirmed'));

-- Earlier code treated non-final notifications as failures. Recheck with MoMo;
-- a migration itself must never mark an order paid.
UPDATE payment_attempts SET status='pending', next_status_check_at=now()
 WHERE provider='momo' AND status='failed' AND response_code IN ('1000','7000','7002','9000');
