CREATE TABLE account_security (
 account_key text PRIMARY KEY,password_hash text,email text,phone text,
 method text NOT NULL DEFAULT 'off' CHECK(method IN ('off','email','app')),
 encrypted_secret text,last_counter bigint NOT NULL DEFAULT -1,
 recovery_hashes jsonb NOT NULL DEFAULT '[]',version integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE security_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_key text NOT NULL,
 purpose text NOT NULL,proof_hash text,payload jsonb NOT NULL DEFAULT '{}',
 fingerprint text NOT NULL,attempts integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_challenges_account ON security_challenges(account_key,purpose,created_at DESC);
