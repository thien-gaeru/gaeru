-- order-after-sales-customer.sql
-- Ho tro khach hang tu tao yeu cau doi tra (After-sales return/exchange),
-- va he thong quan ly RMA ticket chuyen biet (Inbound/Outbound logistics, RMA capability token).

ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS rma_number text UNIQUE;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS rma_token text UNIQUE;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS requested_by text NOT NULL DEFAULT 'admin' CHECK (requested_by IN ('admin', 'customer', 'guest'));
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS return_type text CHECK (return_type IS NULL OR return_type IN ('exchange', 'refund'));
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS reason_category text CHECK (reason_category IS NULL OR reason_category IN ('faulty', 'wrong_item', 'damaged', 'change_mind', 'other'));
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS bank_info jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Inbound logistics (Khach gui tra ve kho)
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS inbound_carrier text;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS inbound_tracking_number text;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS inbound_status text DEFAULT 'pending_shipment' CHECK (inbound_status IN ('pending_shipment', 'in_transit', 'delivered_to_warehouse'));

-- Outbound logistics (Kho gui hang moi/bao hanh cho khach)
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS outbound_carrier text;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS outbound_tracking_number text;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS outbound_status text DEFAULT 'none' CHECK (outbound_status IN ('none', 'preparing', 'in_transit', 'delivered'));

-- Kho tiep nhan & kiem dinh ky thuat
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES warehouses(id) ON DELETE SET NULL;
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS inspection_notes text DEFAULT '';
ALTER TABLE order_after_sales ADD COLUMN IF NOT EXISTS restock_eligible boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_after_sales_rma_number ON order_after_sales(rma_number);
CREATE INDEX IF NOT EXISTS ix_after_sales_rma_token ON order_after_sales(rma_token);
