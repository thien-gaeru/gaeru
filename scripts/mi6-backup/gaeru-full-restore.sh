#!/bin/bash
# GAERU 1-Command Bare-Metal Disaster Recovery & Verification Tool (Xiaomi Mi 6 / Linux ARM64)
# Supports pulling encrypted backups from Google Drive (gdrive:GAERU_Backups),
# failing closed on missing/mismatched SHA-256 companions, and restoring DB, Media+Code, and Mail.
set -euo pipefail
unset LD_PRELOAD 2>/dev/null || true
umask 077

PG_DIR="/userdata/storage/gaeru-pg-backups"
MEDIA_DIR="/userdata/storage/gaeru-media-backups"
MAIL_DIR="/userdata/storage/gaeru-mail-backups"
CHROOT="/userdata/storage/ubuntu"
CHROOT_STORAGE="/storage/ubuntu"

say() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$(date -Is)" "$*" >&2; exit 1; }

resolve_chroot() {
  if [ -d "$CHROOT/usr" ]; then
    printf '%s' "$CHROOT"
  elif [ -d "$CHROOT_STORAGE/usr" ]; then
    printf '%s' "$CHROOT_STORAGE"
  else
    die "Ubuntu chroot directory not found at $CHROOT or $CHROOT_STORAGE"
  fi
}

assert_sha256_companion() {
  local target="$1"
  local sha="${target}.sha256"
  [ -f "$sha" ] || die "Missing mandatory SHA-256 companion: $sha"
  local dir base
  dir=$(dirname "$target")
  base=$(basename "$target")
  (cd "$dir" && sha256sum -c "${base}.sha256" >&2) || die "SHA-256 checksum mismatch: $target"
}

verify_gpg_envelope() {
  local gpg_file="$1"
  [ -s "$gpg_file" ] || die "Empty or missing GPG archive: $gpg_file"
  assert_sha256_companion "$gpg_file"
  if command -v gpg >/dev/null 2>&1; then
    (
      set +o pipefail
      if gpg --batch --no-tty --help 2>/dev/null | grep -q -- '--pinentry-mode'; then
        gpg --batch --no-tty --pinentry-mode cancel --list-only --list-packets "$gpg_file" 2>/dev/null
      else
        gpg --batch --no-tty --list-only --list-packets "$gpg_file" 2>/dev/null
      fi | grep -qE 'pubkey enc packet|encrypted data packet'
    ) || die "File is not a valid OpenPGP encrypted archive: $gpg_file"
  fi
}

# Yields decrypted plain file path via stdout ONLY inside a caller-managed temp file when *.gpg is passed;
# callers holding a pre-decrypted artifact get the original path after SHA-256 verification (if companion exists).
prepare_restore_input() {
  local input="$1"
  local tmp_out="$2"
  [ -f "$input" ] || die "Restore input file not found: $input"
  if [[ "$input" == *.gpg ]]; then
    assert_sha256_companion "$input"
    command -v gpg >/dev/null 2>&1 || die "gpg is required to decrypt $input (decrypt on PC before transferring if phone lacks private key)"
    gpg --batch --yes --no-tty --decrypt --output "$tmp_out" "$input" >&2 || \
      die "Failed to decrypt $input (private recovery key must be unlocked or decrypt on PC first)"
    [ -s "$tmp_out" ] || die "Decrypted output is empty for $input"
    printf '%s' "$tmp_out"
  else
    if [ -f "${input}.sha256" ]; then
      assert_sha256_companion "$input"
    fi
    [ -s "$input" ] || die "Restore input file is empty: $input"
    printf '%s' "$input"
  fi
}

usage() {
  cat <<'EOF'
GAERU Full Server Disaster Recovery Tool
Usage:
  gaeru-full-restore.sh --verify
      Verify SHA-256 + OpenPGP envelope integrity of newest PG, Media/Codebase, and Mail backups.
  gaeru-full-restore.sh --pull-from-gdrive
      Download newest encrypted PG, Media, and Mail backups from Google Drive (gdrive:GAERU_Backups).
  gaeru-full-restore.sh --restore-db <path/to/decrypted.dump|archive.dump.gpg>
      Restore PostgreSQL database gaeru_store cleanly (stops Node app first).
  gaeru-full-restore.sh --restore-media-code <path/to/decrypted.tar.gz|archive.tar.gz.gpg>
      Restore Web Codebase, AVIF Media Library, Admin Dashboard, and Server Configs (--numeric-owner).
  gaeru-full-restore.sh --restore-mail-archive <path/to/decrypted-mail-backup.tar.gz|archive.tar.gz.gpg>
      Restore Maildirs, Roundcube DB, WebPush DB, Sync DB, and restart Mail services.
EOF
}

verify_all() {
  /usr/local/sbin/ubuntu-mount.sh
  say "=== 1. Verifying Latest Encrypted PostgreSQL Backups ==="
  local pg_file pg_sql_file
  pg_file=$(ls -1t "$PG_DIR"/gaeru_store-20*.dump.gpg 2>/dev/null | head -n 1 || true)
  [ -n "$pg_file" ] || die "No encrypted PostgreSQL .dump.gpg found in $PG_DIR"
  verify_gpg_envelope "$pg_file"
  say "PG Custom Dump OK: $(basename "$pg_file") ($(stat -c%s "$pg_file") bytes)"

  pg_sql_file=$(ls -1t "$PG_DIR"/gaeru_store-20*.sql.gz.gpg 2>/dev/null | head -n 1 || true)
  [ -n "$pg_sql_file" ] || die "No encrypted PostgreSQL .sql.gz.gpg found in $PG_DIR"
  verify_gpg_envelope "$pg_sql_file"
  say "PG SQL Dump OK: $(basename "$pg_sql_file") ($(stat -c%s "$pg_sql_file") bytes)"

  say "=== 2. Verifying Latest Encrypted Media + Codebase + Config Backup ==="
  local media_file
  media_file=$(ls -1t "$MEDIA_DIR"/gaeru-media-config-*.tar.gz.gpg 2>/dev/null | head -n 1 || true)
  [ -n "$media_file" ] || die "No encrypted Media/Config .tar.gz.gpg found in $MEDIA_DIR"
  verify_gpg_envelope "$media_file"
  say "Media+Codebase Backup OK: $(basename "$media_file") ($(stat -c%s "$media_file") bytes)"

  say "=== 3. Checking Optional Legacy Mail Backup (iCloud+ Mail active) ==="
  local mail_file
  mail_file=$(ls -1t "$MAIL_DIR"/gaeru-mail-v04-*.tar.gz.gpg 2>/dev/null | head -n 1 || true)
  if [ -n "$mail_file" ]; then
    verify_gpg_envelope "$mail_file"
    say "Legacy Mail Backup OK: $(basename "$mail_file") ($(stat -c%s "$mail_file") bytes)"
  else
    say "Mail archive directory empty or decommissioned (iCloud Mail active) — skipping mail archive check."
  fi
  say "=== ALL ACTIVE ENCRYPTED BACKUP LAYERS VERIFIED INTACT ==="
}

pull_from_gdrive() {
  local chroot_dir
  /usr/local/sbin/ubuntu-mount.sh
  chroot_dir=$(resolve_chroot)
  [ -d "$chroot_dir" ] || die "Missing chroot"
  mkdir -p "$PG_DIR" "$MEDIA_DIR" "$MAIL_DIR"
  chmod 700 "$PG_DIR" "$MEDIA_DIR" "$MAIL_DIR"
  say "Pulling newest encrypted backups from Google Drive (gdrive:GAERU_Backups)..."
  env -u LD_PRELOAD chroot "$chroot_dir" /usr/bin/rclone --config /etc/gaeru-rclone/rclone.conf \
    copy "gdrive:GAERU_Backups/pg" "/storage/gaeru-pg-backups" --max-age 48h --transfers 2
  env -u LD_PRELOAD chroot "$chroot_dir" /usr/bin/rclone --config /etc/gaeru-rclone/rclone.conf \
    copy "gdrive:GAERU_Backups/mail" "/storage/gaeru-mail-backups" --max-age 7d --transfers 2 || true
  env -u LD_PRELOAD chroot "$chroot_dir" /usr/bin/rclone --config /etc/gaeru-rclone/rclone.conf \
    copy "gdrive:GAERU_Backups/media" "/storage/gaeru-media-backups" --max-age 7d --transfers 2
  verify_all
}

restore_db() {
  local raw_input="${1:-}"
  if [ -z "$raw_input" ]; then
    raw_input=$(ls -1t "$PG_DIR"/gaeru_store-20*.dump.gpg 2>/dev/null | head -n 1 || true)
  fi
  [ -n "$raw_input" ] || die "Specify dump file (.dump or .dump.gpg)"

  local tmp_plain="/run/gaeru-restore-db.$$.dump"
  trap 'rm -f -- "$tmp_plain"' RETURN
  local dump_file
  dump_file=$(prepare_restore_input "$raw_input" "$tmp_plain")

  /usr/local/sbin/ubuntu-mount.sh
  local chroot_dir
  chroot_dir=$(resolve_chroot)

  say "Verifying dump TOC before restore: $dump_file"
  chroot "$chroot_dir" /usr/bin/pg_restore -l < "$dump_file" >/dev/null
  say "Stopping node-app before database restore..."
  initctl stop node-app 2>/dev/null || true

  say "Restoring database gaeru_store from $dump_file ..."
  chroot "$chroot_dir" su - postgres -c "pg_restore --clean --if-exists --no-owner --no-privileges -v -d gaeru_store" < "$dump_file"
  local stats
  stats=$(chroot "$chroot_dir" su - postgres -c "psql -tA -d gaeru_store -c \"SELECT 'public_tables=' || count(*) FROM pg_tables WHERE schemaname='public' UNION ALL SELECT 'products=' || count(*) FROM products UNION ALL SELECT 'orders=' || count(*) FROM orders UNION ALL SELECT 'media_upload_originals=' || count(*) FROM media_upload_originals;\"" | tr '\n' ' ')
  say "Starting node-app..."
  initctl start node-app 2>/dev/null || true
  say "Database restore completed successfully: $stats"
}

restore_media_code() {
  local raw_input="${1:-}"
  if [ -z "$raw_input" ]; then
    raw_input=$(ls -1t "$MEDIA_DIR"/gaeru-media-config-*.tar.gz.gpg 2>/dev/null | head -n 1 || true)
  fi
  [ -n "$raw_input" ] || die "Specify Media/Config archive (.tar.gz or .tar.gz.gpg)"

  local tmp_plain="/run/gaeru-restore-media.$$.tar.gz"
  trap 'rm -f -- "$tmp_plain"' RETURN
  local archive
  archive=$(prepare_restore_input "$raw_input" "$tmp_plain")

  say "Testing archive integrity: $archive"
  gzip -t "$archive"
  say "Stopping node-app before extracting codebase & configs..."
  initctl stop node-app 2>/dev/null || true
  say "Extracting Media, Codebase, Admin Dashboard, and Server Configs to / ..."
  if (set +o pipefail; tar -tzf "$archive" | grep -qE '(^|/)\.\.(/|$)|^/'); then
    die "Unsafe path traversal or absolute entry detected in archive: $archive"
  fi
  tar -xzpf "$archive" -C / --numeric-owner
  say "Starting node-app..."
  initctl start node-app 2>/dev/null || true
  say "Media + Codebase + System Configs restored cleanly."
}

restore_mail_archive() {
  local raw_input="${1:-}"
  [ -n "$raw_input" ] || die "Provide mail archive (.tar.gz or .tar.gz.gpg): $0 --restore-mail-archive <file>"

  local tmp_plain="/run/gaeru-restore-mail.$$.tar.gz"
  trap 'rm -f -- "$tmp_plain"' RETURN
  local archive
  archive=$(prepare_restore_input "$raw_input" "$tmp_plain")

  local chroot_dir
  chroot_dir=$(resolve_chroot)

  say "Testing decrypted mail archive integrity: $archive"
  gzip -t "$archive"
  say "Stopping Mail & Webmail services before extract..."
  initctl stop gaeru-mail-sync 2>/dev/null || true
  initctl stop gaeru-webmail-nginx 2>/dev/null || true
  initctl stop gaeru-webmail-fpm 2>/dev/null || true
  initctl stop gaeru-mail 2>/dev/null || true

  say "Extracting Maildirs, Postfix, Dovecot, Roundcube, WebPush & Sync databases to / ..."
  if (set +o pipefail; tar -tzf "$archive" | grep -qE '(^|/)\.\.(/|$)|^/'); then
    die "Unsafe path traversal or absolute entry detected in archive: $archive"
  fi
  tar -xzpf "$archive" -C / --numeric-owner

  local rc_snap wp_snap sync_snap
  rc_snap=$(ls -1t "$chroot_dir"/opt/gaeru-webmail/data/.gaeru-mail-v04-snapshot-*.sqlite 2>/dev/null | head -n 1 || true)
  if [ -n "$rc_snap" ]; then
    cp -f "$rc_snap" "$chroot_dir/opt/gaeru-webmail/data/roundcube.sqlite"
    chown 33:33 "$chroot_dir/opt/gaeru-webmail/data/roundcube.sqlite"
    chmod 660 "$chroot_dir/opt/gaeru-webmail/data/roundcube.sqlite"
    rm -f "$rc_snap"
  fi
  wp_snap=$(ls -1t "$chroot_dir"/opt/gaeru-webmail/data/.gaeru-webpush-v04-snapshot-*.sqlite 2>/dev/null | head -n 1 || true)
  if [ -n "$wp_snap" ]; then
    cp -f "$wp_snap" "$chroot_dir/opt/gaeru-webmail/data/webpush.sqlite"
    chown 33:33 "$chroot_dir/opt/gaeru-webmail/data/webpush.sqlite"
    chmod 660 "$chroot_dir/opt/gaeru-webmail/data/webpush.sqlite"
    rm -f "$wp_snap"
  fi
  sync_snap=$(ls -1t "$chroot_dir"/opt/gaeru-webmail/data/.gaeru-sync-v04-snapshot-*.sqlite 2>/dev/null | head -n 1 || true)
  if [ -n "$sync_snap" ]; then
    mkdir -p /var/lib/gaeru-mail
    cp -f "$sync_snap" /var/lib/gaeru-mail/sync.sqlite
    chmod 644 /var/lib/gaeru-mail/sync.sqlite
    rm -f "$sync_snap"
  fi
  say "Starting Mail & Webmail services..."
  initctl start gaeru-mail 2>/dev/null || true
  initctl start gaeru-webmail-fpm 2>/dev/null || true
  initctl start gaeru-webmail-nginx 2>/dev/null || true
  initctl start gaeru-mail-sync 2>/dev/null || true
  say "Mail & Webmail restore completed cleanly."
}

case "${1:---help}" in
  --verify) verify_all ;;
  --pull-from-gdrive) pull_from_gdrive ;;
  --restore-db) shift; restore_db "${1:-}" ;;
  --restore-media-code) shift; restore_media_code "${1:-}" ;;
  --restore-mail-archive) shift; restore_mail_archive "${1:-}" ;;
  *) usage; exit 1 ;;
esac
