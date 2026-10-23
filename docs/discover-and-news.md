# Product discovery and news

Discovery pages: `discover-k9.html`, `discover-m3.html`, `discover-p01.html`, `discover-g1-ultra.html`. Home K9 CTA and catalog discovery links point here; buying actions retain the existing product variant/cart flow.

K9 content was retrieved from https://gaeru.com/gaeru-k9/ on 2026-10-23. The page adapts its introduction, feature explanations, use cases, comparison and FAQ. Original WAV demonstrations and MP4 video stream from gaeru.com with native controls, no autoplay. Media CSP permits only self and gaeru.com. Prices remain authoritative in the current store, and no legacy discounts, testimonials or inventory are copied.

News: open **Tin tức** in administration (catalog read permission), click **Viết bài mới**, fill title, lowercase slug, excerpt, cover image, image description and plain text body. Save as draft or publish. Edit and save as draft to unpublish. Writing requires catalog write permission, CSRF and a current record version. Public endpoints expose only published posts and their cover images. No placeholder news is published automatically.

Images accept PNG, JPEG or WebP up to 5 MB, with file signature checks. Image bytes and posts persist in PostgreSQL through the additive `news.sql` migration; they are independent of the application checkout. Uploads that are not attached to posts remain private. No automatic deletion of unused images is performed. Public content is escaped as text, with blank lines rendered as paragraphs; raw HTML is never executed. News lists paginate, while the homepage displays the latest twelve in a native horizontal scroll area with buttons and keyboard focus.

Validation: real embedded PostgreSQL integration tests cover authorization, CSRF, upload bytes, file mismatch, draft privacy, duplicate slugs, publication/unpublication, stale edits and audit. VM tests verify public text escaping and carousel controls. Browser visual review remains unavailable while local browser access is disabled.
