ALTER TABLE tiktok_ads_connections ADD COLUMN IF NOT EXISTS last_sync_request_id bigint NOT NULL DEFAULT 0;
CREATE SEQUENCE IF NOT EXISTS tiktok_ads_sync_request_seq;
CREATE INDEX IF NOT EXISTS business_marketplace_order_identity ON business_documents ((payload->>'channel'),(COALESCE(NULLIF(btrim(payload->>'shopId'),''),'')),(btrim(payload->>'externalOrderId')),approved_at DESC,created_at DESC,id DESC) WHERE kind='marketplace' AND status='approved';
