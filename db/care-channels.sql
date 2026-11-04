ALTER TABLE care_requests ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE care_requests ADD COLUMN channel text NOT NULL DEFAULT 'website' CHECK(channel IN('website','shopee','tiktok','lazada'));
ALTER TABLE care_requests ADD COLUMN external_order_number text;
ALTER TABLE care_requests ADD CONSTRAINT care_purchase_source CHECK(
 (channel='website' AND order_id IS NOT NULL AND external_order_number IS NULL) OR
 (channel<>'website' AND order_id IS NULL AND external_order_number IS NOT NULL)
);
