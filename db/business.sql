CREATE TABLE business_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN('payroll','tax','invoice','marketplace')),
 period text NOT NULL CHECK(period ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),reference text NOT NULL,
 payload jsonb NOT NULL,calculation jsonb NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','approved','paid','void')),
 request_key uuid NOT NULL UNIQUE,request_hash text NOT NULL,version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL,approved_by text,approved_at timestamptz,payment_reference text,
 void_reason text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX business_reference_unique ON business_documents(kind,period,reference) WHERE status<>'void';
CREATE UNIQUE INDEX business_invoice_order_unique ON business_documents((payload->>'orderId')) WHERE kind='invoice' AND status<>'void';
CREATE UNIQUE INDEX business_marketplace_order_unique ON business_documents(reference) WHERE kind='marketplace' AND status<>'void';
CREATE INDEX business_kind_period ON business_documents(kind,period,created_at DESC);
CREATE OR REPLACE FUNCTION protect_business_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'Business documents cannot be removed'; END IF;
 IF OLD.status IN('paid','void') THEN RAISE EXCEPTION 'Final business documents are immutable'; END IF;
 IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.calculation IS DISTINCT FROM OLD.calculation OR NEW.period<>OLD.period OR NEW.reference<>OLD.reference OR NEW.kind<>OLD.kind THEN RAISE EXCEPTION 'Business document snapshots are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_business_document BEFORE UPDATE OR DELETE ON business_documents FOR EACH ROW EXECUTE FUNCTION protect_business_document();
CREATE TRIGGER protect_business_truncate BEFORE TRUNCATE ON business_documents FOR EACH STATEMENT EXECUTE FUNCTION protect_business_document();
