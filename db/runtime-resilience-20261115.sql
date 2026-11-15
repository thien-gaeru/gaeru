-- runtime-resilience-20261115.sql
-- Convert high-churn ephemeral rate-limit and bot-failure tables to UNLOGGED on PostgreSQL
-- to eliminate WAL write amplification on UFS flash storage.
-- Wrapped in an exception-safe PL/pgSQL block so embedded PGlite test engines skip safely if unsupported.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'security_rate_limits') THEN
    EXECUTE 'ALTER TABLE security_rate_limits SET UNLOGGED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'bot_failures') THEN
    EXECUTE 'ALTER TABLE bot_failures SET UNLOGGED';
  END IF;
EXCEPTION WHEN others THEN
  NULL;
END $$;
