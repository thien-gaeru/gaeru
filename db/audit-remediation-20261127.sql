-- Audit Remediation (2026-11-27) [I-05]:
-- Prevent website_warranty_order trigger from resurrecting deleted warranties
-- or queuing emails for retention-anonymized orders (anonymized@privacy.gaeru.com).

-- 1. Guard sync_website_warranty against anonymized orders
CREATE OR REPLACE FUNCTION sync_website_warranty(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  i RECORD;
  unit integer;
  purchase date;
BEGIN
  SELECT * INTO o FROM orders WHERE id = target;
  IF NOT FOUND THEN RETURN; END IF;

  IF o.customer_id IS NULL AND (
    lower(COALESCE(o.email, '')) = 'anonymized@privacy.gaeru.com'
    OR COALESCE(o.customer_name, '') LIKE 'Khách hàng ẩn danh%'
  ) THEN
    RETURN;
  END IF;

  IF o.status = 'cancelled' OR o.return_completed_at IS NOT NULL THEN
    UPDATE warranty_activations
       SET status = CASE WHEN status = 'active' THEN 'revoked' ELSE 'rejected' END,
           reason = CASE
             WHEN o.return_completed_at IS NOT NULL THEN 'Thu hồi tự động do đơn website đã hoàn trả.'
             ELSE 'Đơn website đã hủy.'
           END,
           version = version + 1,
           updated_at = now()
     WHERE automatic = true
       AND order_item_id IN (SELECT id FROM order_items WHERE order_id = target)
       AND status IN ('pending', 'active');
    RETURN;
  END IF;

  IF o.customer_id IS NOT NULL THEN
    UPDATE warranty_activations
       SET customer_id = o.customer_id,
           updated_at = now()
     WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = target)
       AND customer_id IS NULL;
  END IF;

  purchase := (o.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
  FOR i IN
    SELECT oi.*, p.slug AS product_slug, p.category AS product_category
      FROM order_items oi
      LEFT JOIN product_variants pv ON pv.id = oi.variant_id
      LEFT JOIN products p ON p.id = pv.product_id
     WHERE oi.order_id = target
  LOOP
    IF COALESCE(i.product_category, '') = 'accessory'
       OR COALESCE(i.product_slug, '') IN ('gaeru-p185', 'dau-chuyen-doi-micro-gaeru')
       OR i.product_name ILIKE '%P185%'
       OR i.product_name ILIKE '%Đầu chuyển đổi%'
    THEN
      CONTINUE;
    END IF;

    FOR unit IN 1..i.quantity LOOP
      INSERT INTO warranty_activations (
        customer_id, order_item_id, request_key, automatic, unit_number,
        contact_name, contact_phone, contact_address, contact_city
      )
      VALUES (
        o.customer_id, i.id, gen_random_uuid(), true, unit,
        o.customer_name, o.phone, o.address, o.city
      )
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;

  IF o.status = 'completed' AND o.payment_status = 'paid' AND o.return_completed_at IS NULL THEN
    UPDATE warranty_activations w
       SET status = 'active',
           purchase_date = purchase,
           expires_on = (purchase + interval '1 year')::date,
           reason = 'Tự động kích hoạt theo đơn website đã hoàn tất và thanh toán.',
           version = w.version + 1,
           updated_at = now()
      FROM order_items oi
      LEFT JOIN product_variants pv ON pv.id = oi.variant_id
      LEFT JOIN products p ON p.id = pv.product_id
     WHERE w.automatic = true
       AND w.order_item_id = oi.id
       AND oi.order_id = target
       AND w.status = 'pending'
       AND NOT (
         COALESCE(p.category, '') = 'accessory'
         OR COALESCE(p.slug, '') IN ('gaeru-p185', 'dau-chuyen-doi-micro-gaeru')
         OR oi.product_name ILIKE '%P185%'
         OR oi.product_name ILIKE '%Đầu chuyển đổi%'
       );
  END IF;
END;
$$;

-- 2. Clean up pending/failed warranty email outbox rows for anonymized orders
DELETE FROM warranty_email_outbox weo
 WHERE weo.status IN ('pending', 'failed')
   AND (
     EXISTS (
       SELECT 1
         FROM orders o
        WHERE o.id = weo.order_id
          AND o.customer_id IS NULL
          AND (
            lower(COALESCE(o.email, '')) = 'anonymized@privacy.gaeru.com'
            OR COALESCE(o.customer_name, '') LIKE 'Khách hàng ẩn danh%'
          )
     )
     OR EXISTS (
       SELECT 1
         FROM warranty_activations w
         JOIN order_items oi ON oi.id = w.order_item_id
         JOIN orders o ON o.id = oi.order_id
        WHERE w.id = weo.warranty_id
          AND o.customer_id IS NULL
          AND (
            lower(COALESCE(o.email, '')) = 'anonymized@privacy.gaeru.com'
            OR COALESCE(o.customer_name, '') LIKE 'Khách hàng ẩn danh%'
          )
     )
   );

-- 3. Clean up pending/failed order email outbox rows for anonymized orders
DELETE FROM order_email_outbox oeo
 USING orders o
 WHERE oeo.order_id = o.id
   AND oeo.status IN ('pending', 'failed')
   AND o.customer_id IS NULL
   AND (
     lower(COALESCE(o.email, '')) = 'anonymized@privacy.gaeru.com'
     OR COALESCE(o.customer_name, '') LIKE 'Khách hàng ẩn danh%'
   );

-- 4. Clean up any already-resurrected automatic warranties for anonymized orders
DELETE FROM warranty_activations w
 USING order_items oi, orders o
 WHERE w.automatic = true
   AND w.customer_id IS NULL
   AND w.order_item_id = oi.id
   AND oi.order_id = o.id
   AND o.customer_id IS NULL
   AND (
     lower(COALESCE(o.email, '')) = 'anonymized@privacy.gaeru.com'
     OR COALESCE(o.customer_name, '') LIKE 'Khách hàng ẩn danh%'
   );

-- 5. Clean up orphaned warranty_order_claims left by legacy rejected/withdrawn rows
--    so customers can resubmit legacy rejected manual warranties without HTTP 409.
DELETE FROM warranty_order_claims c
 WHERE NOT EXISTS (
   SELECT 1
     FROM warranty_activations w
    WHERE w.channel = c.channel
      AND w.external_order_number IS NOT NULL
      AND upper(regexp_replace(w.external_order_number, '[[:space:]]', '', 'g')) = c.order_key
      AND w.withdrawn_at IS NULL
      AND w.status IN ('pending', 'active', 'revoked')
 );

