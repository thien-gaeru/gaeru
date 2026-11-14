#!/bin/bash
set -euo pipefail
unset LD_PRELOAD 2>/dev/null || true
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=gaeru-gpg-common.sh
. "${SCRIPT_DIR}/gaeru-gpg-common.sh"

DEST=/userdata/storage/gaeru-pg-backups
DB=gaeru_store
MAX_KEEP=48
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

OUT_GPG="$DEST/${DB}-${STAMP}.dump.gpg"
SQL_GPG="$DEST/${DB}-${STAMP}.sql.gz.gpg"
GLOBALS_GPG="$DEST/${DB}-globals-${STAMP}.sql.gz.gpg"

TMP_RAW="$DEST/.${DB}-${STAMP}.dump.tmp.$$"
SQL_TMP_RAW="$DEST/.${DB}-${STAMP}.sql.gz.tmp.$$"
GLOBALS_TMP_RAW="$DEST/.${DB}-globals-${STAMP}.sql.gz.tmp.$$"

cleanup() {
  rm -f -- "$TMP_RAW" "$SQL_TMP_RAW" "$GLOBALS_TMP_RAW" \
    "${OUT_GPG}.tmp."* "${SQL_GPG}.tmp."* "${GLOBALS_GPG}.tmp."* 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec 200>/run/gaeru-pg-backup.lock
flock -n 200 || { echo "$(date -Is) Backup already running"; exit 0; }

# Fail closed before writing any dump if public-key recipient is not configured.
gaeru_load_gpg_recipient

mkdir -p "$DEST" && chmod 700 "$DEST"
/usr/local/sbin/ubuntu-mount.sh

# 1. Custom format dump (-Fc) for native pg_restore, encrypted before resting in DEST
chroot /storage/ubuntu su - postgres -c "pg_dump -Fc -Z 6 $DB" > "$TMP_RAW"
[ -s "$TMP_RAW" ] || { echo "$(date -Is) FAIL empty dump"; exit 1; }
chroot /storage/ubuntu /usr/bin/pg_restore -l < "$TMP_RAW" >/dev/null
gaeru_gpg_encrypt_and_wipe "$TMP_RAW" "$OUT_GPG"
gaeru_copy_latest_encrypted "$OUT_GPG" "$DEST/${DB}-latest.dump.gpg"

# 2. Universal portable SQL.GZ dump (PostgreSQL 14-18), encrypted at rest
chroot /storage/ubuntu su - postgres -c "pg_dump --clean --if-exists --no-owner --no-privileges $DB" | \
  sed '/^SET transaction_timeout =/d' | gzip -6 > "$SQL_TMP_RAW"
[ -s "$SQL_TMP_RAW" ] || { echo "$(date -Is) FAIL empty sql.gz"; exit 1; }
gzip -t "$SQL_TMP_RAW"
zcat "$SQL_TMP_RAW" | tail -n 10 | grep -q "PostgreSQL database dump complete"
gaeru_gpg_encrypt_and_wipe "$SQL_TMP_RAW" "$SQL_GPG"
gaeru_copy_latest_encrypted "$SQL_GPG" "$DEST/${DB}-latest.sql.gz.gpg"

# 3. Cluster globals (roles/grants), encrypted at rest
chroot /storage/ubuntu su - postgres -c "pg_dumpall --globals-only --no-role-passwords" | gzip -6 > "$GLOBALS_TMP_RAW"
[ -s "$GLOBALS_TMP_RAW" ] || { echo "$(date -Is) FAIL empty globals sql.gz"; exit 1; }
gzip -t "$GLOBALS_TMP_RAW"
gaeru_gpg_encrypt_and_wipe "$GLOBALS_TMP_RAW" "$GLOBALS_GPG"
gaeru_copy_latest_encrypted "$GLOBALS_GPG" "$DEST/${DB}-globals-latest.sql.gz.gpg"

# Scrub any leftover unencrypted dumps from legacy runs
rm -f -- "$DEST"/${DB}-*.dump "$DEST"/${DB}-*.dump.sha256 \
  "$DEST"/${DB}-*.sql.gz "$DEST"/${DB}-*.sql.gz.sha256 2>/dev/null || true

# Prune older encrypted timestamped dumps beyond MAX_KEEP
gaeru_prune_old_files "$DEST" "${DB}-20*.dump.gpg" "$MAX_KEEP"
gaeru_prune_old_files "$DEST" "${DB}-20*.sql.gz.gpg" "$MAX_KEEP"
gaeru_prune_old_files "$DEST" "${DB}-globals-20*.sql.gz.gpg" "$MAX_KEEP"

echo "$(date -Is) OK encrypted $OUT_GPG ($(stat -c%s "$OUT_GPG") bytes) + $SQL_GPG ($(stat -c%s "$SQL_GPG") bytes) + $GLOBALS_GPG"

# Push independently to Google Drive in background if configured
if [ -x /usr/local/sbin/gaeru-gdrive-sync.sh ]; then
  nohup /usr/local/sbin/gaeru-gdrive-sync.sh pg >> /var/log/gaeru-gdrive-sync.log 2>&1 &
fi
