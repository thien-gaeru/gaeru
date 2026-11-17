-- Remediate carrier attempt failed-state check constraint and unique variant barcodes idempotently.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN (
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'carrier_shipment_attempts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reconciled%'
  ) LOOP
    EXECUTE format('ALTER TABLE carrier_shipment_attempts DROP CONSTRAINT %I', r.conname);
  END LOOP;

  ALTER TABLE carrier_shipment_attempts
    ADD CONSTRAINT carrier_shipment_attempts_status_check
    CHECK (status IN ('sending', 'unknown', 'succeeded', 'reconciled', 'failed'));
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM product_variants
    WHERE barcode IS NOT NULL AND btrim(barcode) <> ''
    GROUP BY barcode
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS product_variants_barcode_unique_idx
      ON product_variants(barcode)
      WHERE barcode IS NOT NULL AND btrim(barcode) <> '';
  END IF;
END $$;
