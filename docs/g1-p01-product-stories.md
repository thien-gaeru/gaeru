# G1 ULTRA and P01 product stories

The layout uses original GAERU copy and existing product imagery, with generous whitespace, alternating text/image sections, and expandable original technical information. Main product images preserve proportions through object-fit:contain; hover distortion is disabled. Text and attributes remain escaped. Other product renderers are unchanged.

Reviewed content is in content/product-stories.json. Store staff can subsequently edit description paragraphs and media positions through the product editor. Each paragraph's first line becomes the section heading; “Thông số và thông tin sản phẩm” opens the specifications disclosure.

Data update: scripts/update-product-stories.cjs defaults to transaction rehearsal/rollback. Set DATABASE_URL through the deployment environment. To apply, set PRODUCT_STORY_BACKUP to a new private backup file, then run node scripts/update-product-stories.cjs --apply. It requires the editorial CSS on gaeru.org, rejects changed text/media, preserves variants/prices/stock, and records audit events. --image-only updates only the G1 main image/gallery ordering without publishing description changes.

The selected G1 artwork is the existing immutable catalog image 9b20b771-a130-4b2b-bf95-3283ea680cc2. Source raster pixels are unchanged. Browser/mobile visual verification remains pending because local browser use is disabled in Work settings. Standalone HTML previews were prepared; do not treat them as a verified live deployment.
