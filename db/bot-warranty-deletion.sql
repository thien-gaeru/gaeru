CREATE TABLE bot_failures (key text PRIMARY KEY,failures integer NOT NULL DEFAULT 0,expires_at timestamptz NOT NULL);
ALTER TABLE warranty_activations ADD COLUMN automatic boolean NOT NULL DEFAULT false;
ALTER TABLE warranty_activations ADD COLUMN unit_number integer;
WITH numbered AS (SELECT id,row_number() OVER(PARTITION BY order_item_id ORDER BY created_at,id)::int AS n FROM warranty_activations WHERE order_item_id IS NOT NULL)
UPDATE warranty_activations w SET automatic=true,unit_number=n.n FROM numbered n WHERE n.id=w.id;
CREATE UNIQUE INDEX warranty_automatic_unit ON warranty_activations(order_item_id,unit_number) WHERE unit_number IS NOT NULL;
CREATE TABLE warranty_order_claims(channel text NOT NULL,order_key text NOT NULL,PRIMARY KEY(channel,order_key));
INSERT INTO warranty_order_claims SELECT DISTINCT channel,upper(regexp_replace(external_order_number,'[[:space:]]','','g')) FROM warranty_activations WHERE external_order_number IS NOT NULL ON CONFLICT DO NOTHING;
CREATE FUNCTION sync_website_warranty(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE o orders%ROWTYPE;i order_items%ROWTYPE;unit integer;purchase date;
BEGIN
 SELECT * INTO o FROM orders WHERE id=target;
 IF NOT FOUND THEN RETURN; END IF;
 IF o.status='cancelled' THEN
  UPDATE warranty_activations SET status=CASE WHEN status='active' THEN 'revoked' ELSE 'rejected' END,reason='Đơn website đã hủy.',version=version+1,updated_at=now() WHERE automatic=true AND order_item_id IN(SELECT id FROM order_items WHERE order_id=target) AND status IN('pending','active');
  RETURN;
 END IF;
 purchase:=(o.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;
 FOR i IN SELECT * FROM order_items WHERE order_id=target LOOP
  FOR unit IN 1..i.quantity LOOP
   INSERT INTO warranty_activations(customer_id,order_item_id,request_key,automatic,unit_number,contact_name,contact_phone,contact_address,contact_city)
   VALUES(o.customer_id,i.id,gen_random_uuid(),true,unit,o.customer_name,o.phone,o.address,o.city) ON CONFLICT DO NOTHING;
  END LOOP;
 END LOOP;
 IF o.status='completed' AND o.payment_status='paid' THEN
  UPDATE warranty_activations SET status='active',purchase_date=purchase,expires_on=(purchase+interval '1 year')::date,reason='Tự động kích hoạt theo đơn website đã hoàn tất và thanh toán.',version=version+1,updated_at=now() WHERE automatic=true AND order_item_id IN(SELECT id FROM order_items WHERE order_id=target) AND status='pending';
 END IF;
END;$$;
CREATE FUNCTION warranty_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM sync_website_warranty(NEW.id);RETURN NEW;END;$$;
CREATE FUNCTION warranty_item_added() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM sync_website_warranty(NEW.order_id);RETURN NEW;END;$$;
CREATE TRIGGER website_warranty_order AFTER UPDATE OF status,payment_status ON orders FOR EACH ROW EXECUTE FUNCTION warranty_order_changed();
CREATE TRIGGER website_warranty_item AFTER INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION warranty_item_added();
DO $$ DECLARE o record; BEGIN FOR o IN SELECT id FROM orders WHERE status<>'cancelled' LOOP PERFORM sync_website_warranty(o.id);END LOOP;END;$$;

CREATE TABLE account_deletion_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,token_hash text NOT NULL UNIQUE,email text NOT NULL,password_fingerprint text NOT NULL,reason text NOT NULL,requested_by text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX deletion_requests_customer ON account_deletion_requests(customer_id,created_at DESC);
