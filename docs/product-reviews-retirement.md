# Remove product reviews

Product pages no longer show stars, rating counts, review lists, review forms,
review images, or helpful-vote controls. The admin catalog no longer includes
review moderation, replies, or pending-review badges. The associated API routes
and admin JavaScript asset are removed and return 404.

The shared commerce asset version changes on every page that loads it so browsers
do not reuse the previous immutable script. Product selection, purchasing,
catalog/trash management, and order/email review remain separate features.

## Database upgrade

New installations do not create product-review tables. On an existing database,
`archive-product-reviews.sql` renames `product_reviews` and
`product_review_helpful_votes` to `archived_product_reviews` and
`archived_product_review_helpful_votes`. Historical rows and foreign keys are
preserved; the application has no routes or code that access these archives.
This does not permanently delete customer data.

The migration runs through the existing startup migration process and can be
re-run safely. A conflicting archive table name stops the migration transaction
instead of overwriting data. Investigate and back up both tables before resolving
such a conflict. Do not run an old application release against the upgraded schema
without restoring the original table names as part of a coordinated rollback.
