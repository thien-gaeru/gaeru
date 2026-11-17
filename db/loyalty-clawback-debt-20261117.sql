-- Track unrecovered earned GAERU Xu debt and cash refund clawback deductions idempotently.

ALTER TABLE customer_loyalty
  ADD COLUMN IF NOT EXISTS clawback_debt_points integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'customer_loyalty'::regclass AND conname = 'customer_loyalty_clawback_debt_check'
  ) THEN
    ALTER TABLE customer_loyalty
      ADD CONSTRAINT customer_loyalty_clawback_debt_check CHECK (clawback_debt_points >= 0);
  END IF;
END $$;

ALTER TABLE order_after_sales
  ADD COLUMN IF NOT EXISTS loyalty_clawback_vnd integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'order_after_sales'::regclass AND conname = 'order_after_sales_loyalty_clawback_check'
  ) THEN
    ALTER TABLE order_after_sales
      ADD CONSTRAINT order_after_sales_loyalty_clawback_check CHECK (loyalty_clawback_vnd >= 0);
  END IF;
END $$;
