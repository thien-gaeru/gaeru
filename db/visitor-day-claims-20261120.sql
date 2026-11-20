-- Keep only recent deduplication keys; the historical report remains aggregated.
CREATE TABLE IF NOT EXISTS site_traffic_daily_visitors (
  visit_date date NOT NULL,
  visitor_hash varchar(64) NOT NULL,
  PRIMARY KEY (visit_date, visitor_hash)
);
INSERT INTO site_traffic_daily_visitors (visit_date, visitor_hash)
SELECT (last_seen_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, visitor_hash
FROM site_traffic_realtime
WHERE last_seen_at >= now() - interval '1 day'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS site_traffic_batch_receipts (
  id uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_traffic_batch_receipts_recorded_at
  ON site_traffic_batch_receipts(recorded_at);
