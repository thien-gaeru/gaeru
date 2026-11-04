CREATE TABLE rma_exchange_issues (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL REFERENCES order_after_sales(id) ON DELETE CASCADE,
 warehouse_id uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
 warehouse_name text NOT NULL,
 status text NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','voided')),
 reason text NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 voided_by text,
 voided_at timestamptz,
 void_reason text
);
CREATE UNIQUE INDEX rma_exchange_one_posted_issue ON rma_exchange_issues(case_id) WHERE status='posted';
CREATE TABLE rma_exchange_issue_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 issue_id uuid NOT NULL REFERENCES rma_exchange_issues(id) ON DELETE CASCADE,
 order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
 replacement_variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
 inventory_movement_id uuid NOT NULL REFERENCES inventory_movements(id) ON DELETE RESTRICT,
 sku text NOT NULL,
 variant_name text NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 99),
 unit_price_vnd integer NOT NULL CHECK(unit_price_vnd>=0),
 UNIQUE(issue_id,order_item_id)
);
CREATE INDEX rma_exchange_issue_case_history ON rma_exchange_issues(case_id,created_at DESC);
