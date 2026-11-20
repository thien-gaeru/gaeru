-- Historical captures used a preselected checkbox. Only a fresh affirmative action enables reminders.
ALTER TABLE abandoned_carts ADD COLUMN IF NOT EXISTS consent_confirmed_at timestamptz;
ALTER TABLE abandoned_carts ALTER COLUMN recovery_consent SET DEFAULT false;
UPDATE abandoned_carts SET next_reminder_at = NULL
WHERE consent_confirmed_at IS NULL AND status IN ('recovering','abandoned');
