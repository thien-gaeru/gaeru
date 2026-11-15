#!/bin/bash
# GAERU Mi 6 Local Backup Retention Pruner
# Automatically deletes local backups older than RETENTION_HOURS (default 48h)
# while preserving *-latest.* aliases and at least MIN_KEEP newest snapshots per tier.
set -euo pipefail
unset LD_PRELOAD 2>/dev/null || true
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=gaeru-gpg-common.sh
. "${SCRIPT_DIR}/gaeru-gpg-common.sh"

VERBOSE=0
if [ "${1:-}" = "--verbose" ] || [ "${1:-}" = "-v" ]; then
  VERBOSE=1
fi

RETENTION_HOURS="${RETENTION_HOURS:-48}"
PG_DIR="/userdata/storage/gaeru-pg-backups"
PG_MIN_KEEP="${PG_MIN_KEEP:-2}"
MEDIA_DIR="/userdata/storage/gaeru-media-backups"
MEDIA_MIN_KEEP="${MEDIA_MIN_KEEP:-1}"
STATUS_FILE="/var/lib/gaeru-backup-prune-status.json"
LOG_FILE="/var/log/gaeru-backup-prune.log"

exec 206>/run/gaeru-backup-prune.lock
flock -n 206 || {
  [ "$VERBOSE" -eq 1 ] && echo "[$(date -Is)] Prune already running"
  exit 0
}

rm_pg_dump=$(gaeru_prune_older_than_hours "$PG_DIR" "gaeru_store-20*.dump.gpg" "$RETENTION_HOURS" "$PG_MIN_KEEP")
rm_pg_sql=$(gaeru_prune_older_than_hours "$PG_DIR" "gaeru_store-20*.sql.gz.gpg" "$RETENTION_HOURS" "$PG_MIN_KEEP")
rm_pg_glob=$(gaeru_prune_older_than_hours "$PG_DIR" "gaeru_store-globals-20*.sql.gz.gpg" "$RETENTION_HOURS" "$PG_MIN_KEEP")
rm_media=$(gaeru_prune_older_than_hours "$MEDIA_DIR" "gaeru-media-config-*.tar.gz.gpg" "$RETENTION_HOURS" "$MEDIA_MIN_KEEP")

# Clean stale aborted temp files older than 6 hours without touching active runs
rm_tmp=0
for d in "$PG_DIR" "$MEDIA_DIR"; do
  [ -d "$d" ] || continue
  while IFS= read -r tmpf; do
    [ -n "$tmpf" ] || continue
    rm -f -- "$tmpf"
    rm_tmp=$((rm_tmp + 1))
  done < <(find "$d" -maxdepth 1 -type f -name '*.tmp.*' -mmin +360 2>/dev/null || true)
done

rm_pg_total=$((rm_pg_dump + rm_pg_sql + rm_pg_glob))
rm_total=$((rm_pg_total + rm_media + rm_tmp))

count_dir_files() {
  local d="$1" pat="$2"
  [ -d "$d" ] || { echo 0; return 0; }
  find "$d" -maxdepth 1 -type f -name "$pat" ! -name '*-latest.*' 2>/dev/null | wc -l | tr -d '[:space:]'
}
dir_bytes() {
  local d="$1"
  [ -d "$d" ] || { echo 0; return 0; }
  du -sb "$d" 2>/dev/null | awk '{print $1}' || echo 0
}

pg_kept=$(count_dir_files "$PG_DIR" "gaeru_store-20*.dump.gpg")
media_kept=$(count_dir_files "$MEDIA_DIR" "gaeru-media-config-*.tar.gz.gpg")
pg_bytes=$(dir_bytes "$PG_DIR")
media_bytes=$(dir_bytes "$MEDIA_DIR")
stamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p "$(dirname "$STATUS_FILE")"
cat > "${STATUS_FILE}.tmp.$$" <<EOF
{
  "retentionHours": ${RETENTION_HOURS},
  "pgMinKeep": ${PG_MIN_KEEP},
  "mediaMinKeep": ${MEDIA_MIN_KEEP},
  "lastRunUtc": "${stamp_utc}",
  "lastRemovedPg": ${rm_pg_total},
  "lastRemovedMedia": ${rm_media},
  "lastRemovedTmp": ${rm_tmp},
  "pgSnapshots": ${pg_kept},
  "mediaSnapshots": ${media_kept},
  "pgBytes": ${pg_bytes},
  "mediaBytes": ${media_bytes}
}
EOF
chmod 644 "${STATUS_FILE}.tmp.$$"
mv -f "${STATUS_FILE}.tmp.$$" "$STATUS_FILE"

summary="[$(date -Is)] [PRUNE-${RETENTION_HOURS}h] removed(pg=${rm_pg_total}, media=${rm_media}, tmp=${rm_tmp}) | kept(pg_sets=${pg_kept}, media=${media_kept}) | disk(pg=${pg_bytes}B, media=${media_bytes}B)"
if [ "$rm_total" -gt 0 ]; then
  echo "$summary" | tee -a "$LOG_FILE"
elif [ "$VERBOSE" -eq 1 ]; then
  echo "$summary (no expired >${RETENTION_HOURS}h backups found)"
fi
