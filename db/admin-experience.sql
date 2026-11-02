CREATE TABLE admin_notice_reads(account_key text NOT NULL,notice_key text NOT NULL,seen_version text NOT NULL,seen_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_key,notice_key));
ALTER TABLE product_presentations ADD COLUMN description_media jsonb NOT NULL DEFAULT '[]';
CREATE TABLE catalog_videos(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),content bytea NOT NULL,mime_type text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE customers ADD COLUMN deleted_at timestamptz;
