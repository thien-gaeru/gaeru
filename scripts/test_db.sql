SELECT 'DB_CONNECTED' as status, current_database(), current_user, count(*) as product_count FROM products;
