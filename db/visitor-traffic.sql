-- Migration: visitor-traffic.sql
-- Storefront visitor and pageview traffic counters

CREATE TABLE IF NOT EXISTS site_traffic (
  date DATE PRIMARY KEY,
  pageviews INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_traffic_realtime (
  visitor_hash VARCHAR(64) PRIMARY KEY,
  path VARCHAR(255) NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_traffic_realtime_seen ON site_traffic_realtime(last_seen_at);
