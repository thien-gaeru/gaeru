UPDATE security_challenges SET used_at=now() WHERE purpose='delete-account' AND used_at IS NULL;
