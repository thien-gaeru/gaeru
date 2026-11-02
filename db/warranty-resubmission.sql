ALTER TABLE warranty_activations ADD COLUMN contact_email text NOT NULL DEFAULT '';
ALTER TABLE warranty_activations ADD COLUMN withdrawn_at timestamptz;
ALTER TABLE warranty_activations ADD COLUMN manage_token_hash text;
DROP INDEX warranty_serial_unique;
CREATE UNIQUE INDEX warranty_serial_unique ON warranty_activations(serial) WHERE serial IS NOT NULL AND status IN ('pending','active','revoked') AND withdrawn_at IS NULL;
CREATE TABLE warranty_email_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),dedupe_key text NOT NULL UNIQUE,
 warranty_id uuid NOT NULL REFERENCES warranty_activations(id) ON DELETE CASCADE,order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','skipped')),
 attempts integer NOT NULL DEFAULT 0,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempted_at timestamptz,finished_at timestamptz,result text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION queue_warranty_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_order uuid;dedupe text;
BEGIN
 IF NEW.status<>'active' OR (TG_OP='UPDATE' AND OLD.status='active') THEN RETURN NEW;END IF;
 IF NEW.automatic THEN SELECT order_id INTO target_order FROM order_items WHERE id=NEW.order_item_id;END IF;
 dedupe:=CASE WHEN target_order IS NOT NULL THEN 'order:'||target_order::text ELSE 'warranty:'||NEW.id::text END;
 INSERT INTO warranty_email_outbox(dedupe_key,warranty_id,order_id) VALUES(dedupe,NEW.id,target_order) ON CONFLICT DO NOTHING;
 RETURN NEW;
END;$$;
CREATE TRIGGER warranty_activation_email AFTER INSERT OR UPDATE OF status ON warranty_activations FOR EACH ROW EXECUTE FUNCTION queue_warranty_confirmation();
