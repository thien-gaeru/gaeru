CREATE TABLE IF NOT EXISTS sales_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0 AND amount_vnd <= 2000000000),
  method text NOT NULL CHECK (method IN ('cash','bank_transfer')),
  reference text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
  request_key text NOT NULL UNIQUE, request_hash text NOT NULL,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_receipts_order_idx ON sales_receipts(order_id,created_at);
CREATE TABLE IF NOT EXISTS supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0 AND amount_vnd <= 1000000000000),
  method text NOT NULL CHECK (method IN ('cash','bank_transfer')),
  reference text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','posted','cancelled')),
  request_key text NOT NULL UNIQUE, request_hash text NOT NULL,
  created_by text NOT NULL, approved_by text, created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS supplier_payments_supplier_idx ON supplier_payments(supplier_id,status);
CREATE TABLE IF NOT EXISTS expense_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL CHECK (category IN ('operations','marketing','payroll','other')),
  payee text NOT NULL,
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0 AND amount_vnd <= 1000000000000),
  method text NOT NULL CHECK (method IN ('cash','bank_transfer')),
  reference text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','posted','cancelled')),
  request_key text NOT NULL UNIQUE, request_hash text NOT NULL,
  created_by text NOT NULL, approved_by text, created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz
);
CREATE INDEX IF NOT EXISTS expense_requests_status_idx ON expense_requests(status,created_at DESC);
CREATE OR REPLACE FUNCTION protect_posted_finance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' OR OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Posted financial records are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_supplier_payment ON supplier_payments;
CREATE TRIGGER protect_supplier_payment BEFORE UPDATE OR DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION protect_posted_finance();
DROP TRIGGER IF EXISTS protect_expense_request ON expense_requests;
CREATE TRIGGER protect_expense_request BEFORE UPDATE OR DELETE ON expense_requests FOR EACH ROW EXECUTE FUNCTION protect_posted_finance();
CREATE OR REPLACE FUNCTION protect_sales_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Sales receipts are append-only'; END $$;
DROP TRIGGER IF EXISTS protect_sales_receipt ON sales_receipts;
CREATE TRIGGER protect_sales_receipt BEFORE UPDATE OR DELETE ON sales_receipts FOR EACH ROW EXECUTE FUNCTION protect_sales_receipt();
