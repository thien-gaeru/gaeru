ALTER TABLE warranty_activations ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE warranty_activations ALTER COLUMN order_item_id DROP NOT NULL;
ALTER TABLE warranty_activations ADD COLUMN channel text NOT NULL DEFAULT 'website' CHECK(channel IN('website','shopee','tiktok','lazada'));
ALTER TABLE warranty_activations ADD COLUMN external_order_number text;
ALTER TABLE warranty_activations ADD COLUMN external_product_name text;
ALTER TABLE warranty_activations ADD COLUMN contact_name text NOT NULL DEFAULT '';
ALTER TABLE warranty_activations ADD COLUMN contact_phone text NOT NULL DEFAULT '';
ALTER TABLE warranty_activations ADD COLUMN contact_address text NOT NULL DEFAULT '';
ALTER TABLE warranty_activations ADD COLUMN contact_city text NOT NULL DEFAULT '';
ALTER TABLE warranty_activations ADD COLUMN request_hash text;
ALTER TABLE warranty_activations ADD COLUMN guest_owner_hash text;
ALTER TABLE warranty_activations ADD CONSTRAINT warranty_purchase_source CHECK(
 (order_item_id IS NOT NULL AND channel='website') OR
 (order_item_id IS NULL AND external_order_number IS NOT NULL AND external_product_name IS NOT NULL)
);
CREATE UNIQUE INDEX warranty_guest_request_key ON warranty_activations(request_key) WHERE customer_id IS NULL;
