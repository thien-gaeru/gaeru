# G1 ULTRA and P01 product stories

The layout uses original GAERU copy and existing product imagery, with generous whitespace, alternating text/image sections, and expandable original technical information. Main product images preserve proportions through object-fit:contain; hover distortion is disabled. Text and attributes remain escaped. Other product renderers are unchanged.

Reviewed content is in content/product-stories.json. Store staff can subsequently edit description paragraphs and media positions through the product editor. Each paragraph's first line becomes the section heading; “Thông số và thông tin sản phẩm” opens the specifications disclosure.

Data update: scripts/update-product-stories.cjs defaults to transaction rehearsal/rollback. Set DATABASE_URL through the deployment environment. To apply, set PRODUCT_STORY_BACKUP to a new private backup file, then run node scripts/update-product-stories.cjs --apply. It requires the editorial CSS on gaeru.org, rejects changed text/media, preserves variants/prices/stock, and records audit events. --image-only updates only the G1 main image/gallery ordering without publishing description changes.

The G1 primary artwork is catalog image 0779b270-eedf-4585-bc58-2275d25a06ac. It was edited from the original GAERU advertisement using imagegen to remove its frame, background, marketing text and icons, then converted to WebP with alpha. The published primary image/gallery ordering and served bytes were verified; variants/prices/stock were unchanged. Browser/mobile visual verification remains pending because local browser use is disabled in Work settings. Standalone HTML previews were prepared; do not treat them as a verified live deployment.
