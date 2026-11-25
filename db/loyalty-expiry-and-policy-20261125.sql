-- 1. GAERU Xu 12-month rolling expiration (extended automatically on new completed order earnings)
ALTER TABLE customer_loyalty
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE customer_loyalty l
   SET expires_at = COALESCE(
     (SELECT MAX(g.created_at)
        FROM customer_loyalty_ledger g
       WHERE g.customer_id = l.customer_id
         AND g.type IN ('earn', 'adjustment')
         AND g.points > 0),
     l.updated_at,
     now()
   ) + interval '12 months'
 WHERE l.points_balance > 0
   AND l.expires_at IS NULL;

CREATE INDEX IF NOT EXISTS customer_loyalty_expires_at_idx
  ON customer_loyalty (expires_at)
  WHERE points_balance > 0 AND expires_at IS NOT NULL;

-- 2. Exclude accessories (GAERU P185, Đầu chuyển đổi, category = 'accessory') from automatic 12-month website warranty
CREATE OR REPLACE FUNCTION sync_website_warranty(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  i RECORD;
  unit integer;
  purchase date;
BEGIN
  SELECT * INTO o FROM orders WHERE id = target;
  IF NOT FOUND THEN RETURN; END IF;

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
    UPDATE warranty_activations
       SET status = 'active',
           purchase_date = purchase,
           expires_on = (purchase + interval '1 year')::date,
           reason = 'Tự động kích hoạt theo đơn website đã hoàn tất và thanh toán.',
           version = version + 1,
           updated_at = now()
     WHERE automatic = true
       AND order_item_id IN (SELECT id FROM order_items WHERE order_id = target)
       AND status = 'pending';
  END IF;
END;
$$;
