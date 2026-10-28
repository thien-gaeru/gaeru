# Hostinger persistent media storage

## Current setup — 28 October 2026

Set the exact uppercase variable `MEDIA_ROOT` to an absolute persistent directory outside deployment-managed `hbuilds`, `public_html`, `node_modules` and `.git` directories. No server-specific path is committed. `Media_root` is not an alias. Production uploads require this directory; there is no remote object-storage provider or remote fallback in the current code.

The Node process needs read/write access. Newly created directories use mode 700 and files use mode 600; existing permissions are not broadened. The startup probe creates supported scope directories, writes/reads/removes a random fixture and checks a private sentinel. Its fingerprint can be compared across restarts. A repeated fingerprint is continuity evidence, not proof of disk redundancy or backup.

Owner settings provide **Kiểm tra lưu trữ ngay** (`POST /api/gaeru_ceo/owner/media-storage/probe`). It requires the bootstrap owner, CSRF and a rate limit. The diagnostic shows the configured/resolved directory and aggregate inventory only to the owner. Public health headers expose bounded categories and no private paths, keys or credentials.

## File access and compatibility

New uploads use safe UUID filenames and a `GAERU_FS_V1:` reference in PostgreSQL. Reads check size/hash and reject unsafe paths, symlinks, deployment-managed roots and invalid files. Optional UUID subfolders are supported. There is no `express.static(MEDIA_ROOT)` mount or public directory listing.

The existing catalog/news/banner/video/chat APIs enforce publication and private access before reading bytes. `/media/products/:filename` is a compatibility alias for a published catalog image, not a general filesystem endpoint. Both administration upload endpoints use the validated image-optimization/filesystem pipeline.

Old database-format markers can read a verified copy already present in this directory. Startup reference conversion only publishes a local reference after comparing integrity evidence, and retains the previous database value. An absent or corrupt local copy remains an actionable audit failure; the application cannot download it from a remote bucket. The former remote copy worker, activation command and SDK have been removed. Historical migration records remain recovery evidence.

Packaged raster assets are saved as immutable `site-assets` snapshots and retain their original public URLs. See [links and packaged assets](primary-links-and-assets.md). Source code, fonts, CSS and JavaScript remain deployment assets.

## Retention, recovery and rollout

Back up the whole private media directory and PostgreSQL together, including mapping tables. A failed database publication may leave an orphan; general media must be reconciled before deletion. Chat files have a separate 30-day policy and durable cleanup queue documented in [the file library](file-library.md).

Before deployment, confirm the production directory is persistent and complete, preserve a recoverable backup, run the owner probe and inspect local-reference audit results. Verify representative published images, private attachments and videos. A historical migration-completed status is not a current inventory check. This source update has not deleted the original remote objects or changed production configuration.

Tests use actual temporary files and embedded PostgreSQL-compatible fixtures. They verify writes/reads, corruption, safe nested keys, path/symlink rejection, missing-root behavior, local conversion/idempotency, no remote requests, route authorization, range handling, logical deletion and physical chat cleanup. Live production validation must be recorded separately from fixture tests.
