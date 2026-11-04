-- Product reviews are retired. Keep historical records for recovery without
-- exposing the old application tables or creating them on new installations.
-- A conflicting archive name intentionally fails the enclosing migration
-- transaction; never overwrite or delete previously archived records.
DO $$
BEGIN
  IF to_regclass(format('%I.product_reviews', current_schema())) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.product_reviews RENAME TO archived_product_reviews', current_schema());
  END IF;
  IF to_regclass(format('%I.product_review_helpful_votes', current_schema())) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.product_review_helpful_votes RENAME TO archived_product_review_helpful_votes', current_schema());
  END IF;
END $$;
