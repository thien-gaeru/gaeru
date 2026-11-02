-- =============================================================================
-- Order Checkout Idempotency (GAERU-009), Non-Blocking Gateway Intents (GAERU-010)
-- & Business Logic Schema Integrity Reconciliation
-- =============================================================================

CREATE TABLE IF NOT EXISTS order_idempotency_keys (
  scope_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (scope_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS order_idempotency_keys_expires_idx
  ON order_idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS checkout_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider IN ('momo', 'zalopay')),
  provider_request_id text NOT NULL,
  amount_vnd integer NOT NULL CHECK (amount_vnd >= 1),
  status text NOT NULL DEFAULT 'pending_provider' CHECK (status IN ('pending_provider', 'completed', 'released', 'expired')),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkout_payment_intents_status_expires_idx
  ON checkout_payment_intents (status, expires_at);

CREATE TABLE IF NOT EXISTS checkout_stock_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES checkout_payment_intents(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  warehouse_id uuid REFERENCES warehouses(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity >= 1),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkout_stock_holds_intent_idx
  ON checkout_stock_holds (intent_id);

-- Ensure cost_price_vnd exists on product_variants for inventory forecast & PO generation
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS cost_price_vnd bigint NOT NULL DEFAULT 0 CHECK (cost_price_vnd >= 0);

-- Allow recreating a carrier waybill after cancellation while enforcing at most 1 active waybill per order
ALTER TABLE carrier_shipments
  DROP CONSTRAINT IF EXISTS carrier_shipments_order_carrier_unique;

CREATE UNIQUE INDEX IF NOT EXISTS carrier_shipments_one_active_per_order_idx
  ON carrier_shipments (order_id)
  WHERE status <> 'cancelled';

-- Track refund cap and idempotent restocking on order_after_sales
ALTER TABLE order_after_sales
  ADD COLUMN IF NOT EXISTS refund_amount_vnd integer CHECK (refund_amount_vnd IS NULL OR refund_amount_vnd >= 0),
  ADD COLUMN IF NOT EXISTS restocked_at timestamptz;

-- Track exact warehouse allocations for omnichannel marketplace orders
ALTER TABLE marketplace_orders
  ADD COLUMN IF NOT EXISTS stock_allocations jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Keep website warranty activations synchronized on refund returns and post-insert customer_id linking
CREATE OR REPLACE FUNCTION sync_website_warranty(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  o orders%ROWTYPE;
  i order_items%ROWTYPE;
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
  FOR i IN SELECT * FROM order_items WHERE order_id = target LOOP
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

DROP TRIGGER IF EXISTS website_warranty_order ON orders;
CREATE TRIGGER website_warranty_order
  AFTER UPDATE OF status, payment_status, return_completed_at, customer_id ON orders
  FOR EACH ROW EXECUTE FUNCTION warranty_order_changed();
