CREATE TABLE IF NOT EXISTS tiktok_ads_connections (
 advertiser_id text PRIMARY KEY, config_version integer NOT NULL,
 account_name text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 timezone text NOT NULL, verified_at timestamptz NOT NULL DEFAULT now(),
 last_synced_at timestamptz, last_from date, last_to date
);
CREATE TABLE IF NOT EXISTS advertising_daily_spend (
 provider text NOT NULL CHECK(provider='tiktok_ads'), advertiser_id text NOT NULL,
 stat_date date NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 timezone text NOT NULL, spend_micros bigint NOT NULL CHECK(spend_micros>=0),
 report_type text NOT NULL CHECK(report_type='BASIC'),
 synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,advertiser_id,stat_date)
);
CREATE TABLE IF NOT EXISTS connected_marketplace_sales (
 provider text NOT NULL CHECK(provider IN('shopee','tiktok','lazada')),
 shop_id text NOT NULL, external_order_id text NOT NULL,
 order_date date NOT NULL, status text NOT NULL CHECK(status IN('pending','shipped','completed','returned','cancelled')),
 currency text NOT NULL CHECK(currency='VND'), gross_vnd bigint NOT NULL CHECK(gross_vnd>=0),
 refund_vnd bigint NOT NULL CHECK(refund_vnd>=0), net_revenue_vnd bigint NOT NULL CHECK(net_revenue_vnd>=0),
 authorization_reference text NOT NULL, source_updated_at timestamptz NOT NULL,
 synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,shop_id,external_order_id),
 CHECK(refund_vnd<=gross_vnd),CHECK(net_revenue_vnd=gross_vnd-refund_vnd)
);
CREATE INDEX IF NOT EXISTS connected_marketplace_sales_date ON connected_marketplace_sales(order_date,provider);
CREATE INDEX IF NOT EXISTS advertising_daily_spend_date ON advertising_daily_spend(stat_date,provider);
