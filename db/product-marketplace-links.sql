-- product-marketplace-links.sql: Thêm liên kết Shopee và TikTok Shop cho từng sản phẩm
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopee_url text NOT NULL DEFAULT '' CHECK (length(shopee_url)<=1000);
ALTER TABLE products ADD COLUMN IF NOT EXISTS tiktok_shop_url text NOT NULL DEFAULT '' CHECK (length(tiktok_shop_url)<=1000);
