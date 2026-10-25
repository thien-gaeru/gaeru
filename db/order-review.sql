CREATE TABLE order_reviews (
 order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
 reason text NOT NULL,
 resolved_at timestamptz,
 resolution text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE order_admin_email_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown')),
 recipient text,
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempted_at timestamptz,
 finished_at timestamptz,
 result text
);
CREATE FUNCTION queue_order_admin_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO order_admin_email_outbox(order_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER order_admin_email AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION queue_order_admin_email();
