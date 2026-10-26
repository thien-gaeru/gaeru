# Hostinger persistent media storage

Set the exact uppercase variable MEDIA_ROOT to an existing, absolute directory outside deployment-managed hbuilds/public_html. The application chooses this provider for NEW uploads whenever it is configured. Without it the existing Neon provider remains active. Media_root is not an alias: startup reports its incorrect casing in the owner status message. No credentials or server-specific default path are committed.

Startup probes create/check products, news, banners, videos, chat directories, write/read/remove a random noncustomer fixture, and maintain a private .gaeru-storage-check sentinel. Finding that marker on a subsequent process start is continuity evidence; it is not proof of backup, disk redundancy or a successful cross-host migration. Failure reports a sanitized message and does not prevent storefront startup. Configured local uploads fail closed with 503 rather than silently switching to Neon/database storage. Owner configuration shows the last startup result, not a permanent guarantee of disk availability.

All uploads still pass existing route validation and the shared WebP optimizer. New filenames are UUIDs under fixed namespaces. File bytes are written exclusively, flushed and closed before a small GAERU_FS_V1 reference (key, byte size, SHA-256) is returned for database publication. No original filename, customer name or filesystem path goes into that key. Files are mode 600, newly created subdirectories 700, and existing folder permissions are not broadened. App-mediated public images can use mode 600 because the Node process reads them; direct public filesystem serving is unnecessary.

The configured absolute root is created recursively on a write/probe, using private permissions for newly created directories. Reads never create directories. Lexical and resolved existing-ancestor checks reject deployment-managed paths before creation. Deployment-managed paths, invalid keys, symlink scope directories and symlink files are rejected. Reads require a bounded regular file and validate exact byte count/hash. A failed or uncertain database publication may leave an orphan file; it is retained rather than risking deletion of a committed reference. Reconcile before cleanup.

Existing authorization/publication/MIME/range/private-cache rules remain at the current endpoints. There is no express.static(MEDIA_ROOT) mount or public filesystem listing. Private documents/chat keep their existing access checks. Business/account/order/stock data remain in the original PostgreSQL database.

Readers support local FS references, S3 V2/V1 references and legacy inline records simultaneously. Existing Neon files are NOT automatically copied or deleted. Keep Neon credentials while any old references remain. Back up the directory and database separately. Once local pointers have been stored, restoring code must retain the filesystem reader and MEDIA_ROOT; old releases without that reader cannot serve those new files.

Validation: real temporary filesystem writes/reads, corruption, invalid input, disallowed deployment roots, symlink scope escape, mode 600 on Unix, missing-root failure without fallback, Neon and inline backward compatibility, sentinel continuity and probe cleanup. Full test suite: 335 passing. The agent's Hostinger configuration read timed out, so actual production root/value/access must be confirmed from the owner status after deployment. No old media migration or production customer upload was performed by these tests.

## Authorized Neon S3 to MEDIA_ROOT migration (26 October 2026)

The user explicitly requested copying the entire Neon S3 media store. This release automatically starts a one-time background migration after migrations and the startup filesystem probe succeed. An owner-status panel and non-sensitive health response headers expose ready/blocked/copying/completed states. They do not expose object keys, paths, names, file counts or credentials publicly.

All five media tables are scanned for S3 V1/V2 pointers. Each source is downloaded and integrity-checked, copied atomically to the same safe key under MEDIA_ROOT, read back and byte/hash checked. Only then does a short transaction lock and compare the original record, retain the previous pointer in media_filesystem_reference_backups, and replace its content reference. IDs, URLs, filenames, MIME, created timestamps, ownership and chat byte_size stay unchanged. No image recompression occurs during migration.

The S3 assets bucket is also enumerated in pages of 100, and unreferenced files are copied and verified without publishing them. A destination manifest stores key/bytes/hash/ETag. Zero-byte directory markers are ignored. Unrecognized keys or oversized/invalid files block completion rather than being silently omitted or written to arbitrary paths. No S3 delete operation is called. Completion requires successful enumeration, integrity verification and no remaining S3 pointers in the five tables.

The database job lease prevents concurrent workers and is renewed between operations; a stopped process can resume after lease expiry. Each successful reference is committed separately. Failed copies retain original pointers; retries reuse verified destination files. An immutable destination sentinel identity prevents a different empty directory from being mistaken for the original migration target. A crash can leave private staging files; they are not published. Cleanup of those orphans is a later reconciliation operation.

A blocked run retries after one minute. Missing/unwritable MEDIA_ROOT requires correcting the environment/path and restarting; startup never asserts success without its actual probe. A completed run is not a continuous S3 synchronizer: files independently added to S3 after this migration snapshot are outside its completion statement. New uploads from this release go to MEDIA_ROOT.

Tests use real filesystem and embedded PostgreSQL-compatible fixtures for S3 V1/V2, unreferenced paginated objects, metadata retention, rollback, hash mismatch, retry/idempotency, target identity and concurrent lease ownership. No original S3 objects are removed, and no customer orders/payment data are rewritten.

## Hostinger upload and URL checks

The owner configuration panel now has “Kiểm tra lưu trữ ngay”, POST /api/gaeru_ceo/owner/media-storage/probe. It runs a fresh write/read/delete probe without restarting, requires the bootstrap owner and CSRF, is limited to six checks/minute and reports filesystem operation, configured path and failing path only to the owner. Public health headers remain bounded categories without paths. Rechecking does not itself start a new migration or publish an image.

POST /api/gaeru_ceo/uploads/image is an authenticated alias of the existing image upload: same multipart image field, catalog.write permission, CSRF, rate/size/signature checks, WebP conversion and database reference. It is not an anonymous /api/upload endpoint.

GET /media/products/<UUID>.<webp|png|jpg> resolves an existing filesystem pointer and reuses the exact catalog image publication checks and response handler. A file merely existing on disk is insufficient. Draft, unreferenced, unpublished and private/chat objects are not exposed. There is no static mount of the complete MEDIA_ROOT directory.

Verification: real multipart upload against embedded PostgreSQL and a temporary filesystem, successful public image decode bytes after publication, 404 before/after unpublishing, malicious payload rejection, owner-only recheck, CSRF and private-path protection. Full suite: 340 passing. Production read/write results must be reported separately from fixture success.


Root creation update: implement mkdir(MEDIA_ROOT,{recursive:true}) as requested, after validation; do not hard-code account paths or mount private files publicly. Startup returns a nonsecret sentinel fingerprint for comparison across deployments. Automatic legacy-media migration now requires MEDIA_MIGRATION_ENABLED=true and remains paused by default until the operator verifies persistent storage. This does not change read compatibility or delete existing objects. Full suite after change: 341 tests.

## Migration activation after destination verification

On 26 October 2026 the user explicitly requested proceeding with the transfer while retaining high-quality WebP behavior. A real redeploy completed (build 01a17860-c59e-7028-911d-9a1b9bcace47); the random sentinel fingerprint was 6bc15b31e821dba1 both before and after, read/write checks passed, and seven sampled public image hashes were unchanged. This release authorizes automatic migration only on that verified volume. MEDIA_MIGRATION_ENABLED=false still disables it; explicit true retains the operator override.

Migration copies source bytes exactly, without calling the image encoder or changing resolution/format. Existing WebP uploads retain the current optimizer behavior; no new claim of mathematical losslessness is made for the quality-90 encoder. Migration logs only aggregate counts/states and bounded error categories, not keys, customer data or credentials. Original S3 objects remain for recovery.

## Full upload-route review

The legacy POST /api/gaeru_ceo/uploads endpoint previously wrote bytes into deployment assets/products. It now uses the same storeUpload('products') WebP/filesystem/metadata pipeline as the new editor, with catalog.write, CSRF and rate limits. Its response keeps imageUrl but points to the checked catalog image API. No user-upload endpoint writes into the checkout asset directory after this change.

A read-only audit runs after completed migration on startup: verify every manifest file, inspect all five media tables, hash-check every filesystem reference, and count any remaining S3 pointers or inline payloads. Oversized inline database contents are counted without loading entire media blobs into memory. Audit logs contain aggregate counts only. Original shipped assets/fonts/code remain part of the deployment; generated Excel exports are responses, not newly persisted documents. This distinction is separate from user-uploaded media storage.

Validation: all 342 tests pass; multipart regression covers both upload endpoints and checks real MEDIA_ROOT files plus WebP metadata. Full migration audit tests detect inline leftovers instead of incorrectly reporting complete filesystem storage.

## File Manager versus application-path diagnostics

Owner storage recheck now reports the configured root, resolved real path, application working directory and file/byte counts by allowed scope, excluding hidden staging files and not following symlinks. The post-migration audit logs the same inventory and one published sample's actual /media URL plus its catalog API URL. These diagnostics are owner/server-side only; no public directory listing is introduced.

The /media sample resolves the real UUID filename, not an illustrative products/k9/main.webp path. Existing /api/catalog-images URLs are application readers for filesystem references and are not old Neon bucket URLs. Neither route requires mounting all private storage with express.static.

Validation: 342 tests pass, including a real filesystem inventory of a resolved directory, upload/publication/privacy checks and the full reference audit. Public checks on both gaeru.com and gaeru.org confirmed the same storage sentinel fingerprint and a WebP image response with status 200 before release.

Ảnh giao diện đóng gói được lưu bền vững và phục vụ qua URL cũ theo [quy ước liên kết và ảnh](primary-links-and-assets.md).
