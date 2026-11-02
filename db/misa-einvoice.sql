CREATE TABLE IF NOT EXISTS misa_einvoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  document_id uuid REFERENCES business_documents(id) ON DELETE SET NULL,
  order_number text NOT NULL,
  invoice_number text NOT NULL,
  invoice_series text NOT NULL,
  template_code text NOT NULL,
  transaction_id text NOT NULL,
  view_url text NOT NULL,
  total_vnd integer NOT NULL,
  buyer_name text NOT NULL,
  buyer_tax_code text NOT NULL DEFAULT '',
  buyer_address text NOT NULL DEFAULT '',
  buyer_email text NOT NULL DEFAULT '',
  buyer_phone text NOT NULL DEFAULT '',
  issued_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id)
);

CREATE INDEX IF NOT EXISTS misa_einvoices_order_number ON misa_einvoices(order_number);
