-- A fully spent earning still needs a one-time reversal marker. Keep ordinary
-- ledger movements nonzero; allow zero only for earned-points refund markers.
ALTER TABLE customer_loyalty_ledger
  DROP CONSTRAINT IF EXISTS customer_loyalty_ledger_points_check;

ALTER TABLE customer_loyalty_ledger
  ADD CONSTRAINT customer_loyalty_ledger_points_check
  CHECK (points <> 0 OR (type = 'refund' AND event_key LIKE 'refund-earn:%'));
