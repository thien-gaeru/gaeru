# Primary file storage

Since 28 October 2026, user-uploaded file bytes use the private persistent filesystem configured by `MEDIA_ROOT`. The application contains no object-storage SDK, remote bucket client, remote migration worker or storage credentials. The PostgreSQL database remains authoritative for accounts, settings, orders, payments, stock, warranty, article text, chat history, access rules and file metadata.

In production, missing or unavailable storage rejects new uploads with a controlled 503 response. Development and tests can use inline database fixtures when `MEDIA_ROOT` is absent. Configured filesystem writes never silently fall back to database bytes. See [Hostinger storage setup](hostinger-media-storage.md).

New files have UUID names under fixed scopes. They are written exclusively, flushed and closed before the database receives a `GAERU_FS_V1:` reference containing the safe key, exact stored byte count and SHA-256. User-supplied names and paths are not physical filenames. Existing image optimization, logical chat quotas, authentication, publication checks, MIME handling and video range responses remain in force.

The old `GAERU_S3_V1:` and `GAERU_S3_V2:` strings remain solely as read-only database-format compatibility markers. They read already-copied files from `MEDIA_ROOT`; they never make network requests. Removing these format readers would break historical database references. At startup, `src/media-storage-audit.js` replaces old references only after validating an existing local copy against its size/hash or the original migration manifest. It compares the original row under a transaction lock and retains a backup of the old reference. Missing or corrupt copies preserve the original reference for diagnosis; there is no remote recovery fallback. V1 conversion needs manifest integrity evidence.

The local audit checks stored manifests and active references and reports bounded status categories through health headers. Owner settings show the fuller status. A successful probe or an old migration-completed marker alone does not prove every file exists, and neither replaces a backup. Historic migration tables are retained for integrity evidence and recovery; this release does not delete the original remote bucket or change the database provider.

Back up the database and `MEDIA_ROOT` together. A database restore alone cannot recover missing file bytes. Before rollout, verify the existing persistent volume, inspect the local audit and compare representative public and private media. Chat attachments expire after 30 days; see [file-library retention and permissions](file-library.md). Other media does not inherit that policy.

Tests cover actual temporary filesystem reads/writes, integrity failures, missing storage, safe keys and nested folders, legacy local compatibility without network access, publication/private access checks, file retention, failed writes, quotas and byte-range responses.
