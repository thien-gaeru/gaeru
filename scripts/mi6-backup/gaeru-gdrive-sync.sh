#!/bin/bash
# GAERU 24/7 Autonomous Google Drive Offsite Backup Sync (Xiaomi Mi 6 -> Google Drive)
# Uses rclone inside Ubuntu arm64 chroot with IPv4 fast path (--bind 0.0.0.0) and batched transfers.
# Only OpenPGP-encrypted (*.gpg + *.sha256) archives are ever uploaded off-device.
set -euo pipefail
unset LD_PRELOAD 2>/dev/null || true
export LANG=C.UTF-8 LC_ALL=C.UTF-8
unset LANGUAGE 2>/dev/null || true

MODE="${1:-all}"
RCLONE_CONF_CHROOT="/etc/gaeru-rclone/rclone.conf"
RCLONE_CONF_HOST="/userdata/storage/ubuntu${RCLONE_CONF_CHROOT}"
REMOTE_NAME="gdrive"
REMOTE_ROOT="${REMOTE_NAME}:GAERU_Backups"
LOG_FILE="/var/log/gaeru-gdrive-sync.log"
STATUS_FILE="/var/lib/gaeru-gdrive-sync-status.json"
REMOTE_RETENTION_AGE="60d"

log() {
  local msg="[$(date -Is)] [GDRIVE-SYNC] $*"
  if [ /proc/self/fd/1 -ef "$LOG_FILE" ]; then
    echo "$msg"
  else
    echo "$msg" | tee -a "$LOG_FILE"
  fi
}

run_rclone() {
  env -u LD_PRELOAD chroot /storage/ubuntu /usr/bin/rclone --config "$RCLONE_CONF_CHROOT" --bind 0.0.0.0 "$@"
}

/usr/local/sbin/ubuntu-mount.sh

if [ "$MODE" = "status" ]; then
  if [ ! -s "$RCLONE_CONF_HOST" ]; then
    echo "STATUS: NOT_CONFIGURED (missing $RCLONE_CONF_HOST)"
    exit 0
  fi
  if ! grep -q "^\[${REMOTE_NAME}\]" "$RCLONE_CONF_HOST" 2>/dev/null; then
    echo "STATUS: NOT_CONFIGURED (remote [$REMOTE_NAME] missing in $RCLONE_CONF_HOST)"
    exit 0
  fi
  echo "STATUS: CONFIGURED"
  run_rclone about "${REMOTE_NAME}:" || true
  echo "=== Remote Files in ${REMOTE_ROOT} ==="
  run_rclone ls "${REMOTE_ROOT}" 2>/dev/null || true
  [ -f "$STATUS_FILE" ] && cat "$STATUS_FILE"
  exit 0
fi

if [ ! -s "$RCLONE_CONF_HOST" ] || ! grep -q "^\[${REMOTE_NAME}\]" "$RCLONE_CONF_HOST" 2>/dev/null; then
  log "SKIP ($MODE): Google Drive remote [$REMOTE_NAME] not yet configured at $RCLONE_CONF_HOST"
  exit 0
fi

exec 205>/run/gaeru-gdrive-sync.lock
if ! flock -w 900 205; then
  log "WARN ($MODE): Timed out after 900s waiting for Google Drive sync lock."
  exit 1
fi

COMMON_FLAGS=(
  --transfers 1
  --checkers 2
  --tpslimit 4
  --tpslimit-burst 4
  --drive-chunk-size 64M
  --contimeout 15s
  --timeout 180s
  --retries 5
  --low-level-retries 10
  --stats 0
)

SYNC_STATUS="ok"
SYNC_WARNINGS=()

remote_file_verified() {
  local src_chroot="$1"
  local subdir="$2"
  local filename="$3"
  local out
  out=$(run_rclone ls "${REMOTE_ROOT}/${subdir}" --filter "+ ${filename}" --filter "- *" 2>/dev/null || true)
  printf '%s\n' "$out" | awk -v f="$filename" '$1 > 0 && $2 == f { found=1 } END { exit(found ? 0 : 1) }' || return 1
  # Verify remote file content hash matches local file on Drive before allowing prune
  run_rclone check "$src_chroot" "${REMOTE_ROOT}/${subdir}" \
    --filter "+ ${filename}" \
    --filter "- *" \
    --one-way \
    "${COMMON_FLAGS[@]}" >/dev/null 2>&1
}

sync_pg() {
  local src_host="/userdata/storage/gaeru-pg-backups"
  local src_chroot="/storage/gaeru-pg-backups"
  if [ ! -d "$src_host" ]; then
    log "WARN (pg): Source directory missing ($src_host); skipping remote prune to protect existing Drive backups."
    SYNC_STATUS="missing_backup"
    SYNC_WARNINGS+=("pg_source_missing")
    return 0
  fi
  local newest newest_sql newest_globals latest_dump
  newest=$(ls -1t "$src_host"/gaeru_store-20*.dump.gpg 2>/dev/null | head -n 1 || true)
  newest_sql=$(ls -1t "$src_host"/gaeru_store-20*.sql.gz.gpg 2>/dev/null | head -n 1 || true)
  newest_globals=$(ls -1t "$src_host"/gaeru_store-globals-20*.sql.gz.gpg 2>/dev/null | head -n 1 || true)
  latest_dump="$src_host/gaeru_store-latest.dump.gpg"
  if [ -z "$newest" ] && [ ! -s "$latest_dump" ]; then
    log "WARN (pg): No encrypted PostgreSQL backup found in $src_host; skipping remote prune to protect existing Drive backups."
    SYNC_STATUS="missing_backup"
    SYNC_WARNINGS+=("pg_archive_missing")
    return 0
  fi
  log "Pushing encrypted PostgreSQL backups to ${REMOTE_ROOT}/pg ..."
  local filter_args=(
    --filter "+ gaeru_store-latest.sql.gz.gpg"
    --filter "+ gaeru_store-latest.sql.gz.gpg.sha256"
    --filter "+ gaeru_store-latest.dump.gpg"
    --filter "+ gaeru_store-latest.dump.gpg.sha256"
    --filter "+ gaeru_store-globals-latest.sql.gz.gpg"
    --filter "+ gaeru_store-globals-latest.sql.gz.gpg.sha256"
  )
  local current_hour today_date daily_stamp_file last_daily_date need_daily_snapshot
  current_hour=$(date +%H)
  today_date=$(date +%Y-%m-%d)
  daily_stamp_file="/var/lib/gaeru-gdrive-daily-pg.date"
  last_daily_date=$(cat "$daily_stamp_file" 2>/dev/null || true)
  need_daily_snapshot="false"
  if [ "$MODE" = "all" ] || [ "$current_hour" = "03" ] || [ "$last_daily_date" != "$today_date" ]; then
    need_daily_snapshot="true"
    [ -n "$newest" ] && filter_args+=(--filter "+ $(basename "$newest")" --filter "+ $(basename "$newest").sha256")
    [ -n "$newest_sql" ] && filter_args+=(--filter "+ $(basename "$newest_sql")" --filter "+ $(basename "$newest_sql").sha256")
    [ -n "$newest_globals" ] && filter_args+=(--filter "+ $(basename "$newest_globals")" --filter "+ $(basename "$newest_globals").sha256")
  fi
  filter_args+=(--filter "- *")

  run_rclone copy "$src_chroot" "${REMOTE_ROOT}/pg" "${filter_args[@]}" "${COMMON_FLAGS[@]}"

  local verify_name=""
  if [ "$need_daily_snapshot" = "true" ] && [ -n "$newest" ] && [ -s "${newest}.sha256" ]; then
    verify_name=$(basename "$newest")
  elif [ -s "$latest_dump" ] && [ -s "${latest_dump}.sha256" ]; then
    verify_name="gaeru_store-latest.dump.gpg"
  fi
  if [ -z "$verify_name" ] || ! remote_file_verified "$src_chroot" "pg" "$verify_name" || ! remote_file_verified "$src_chroot" "pg" "${verify_name}.sha256"; then
    log "WARN (pg): Remote verification failed for ${verify_name:-none}; skipping remote prune."
    SYNC_STATUS="verify_failed"
    SYNC_WARNINGS+=("pg_remote_verify_failed")
    return 0
  fi

  if [ "$need_daily_snapshot" = "true" ]; then
    printf '%s\n' "$today_date" > "$daily_stamp_file" 2>/dev/null || true
  fi
  local prune_filters=(--filter "- *-latest.*" --filter "- *-latest.*.*")
  [ -n "$newest" ] && prune_filters+=(--filter "- $(basename "$newest")" --filter "- $(basename "$newest").sha256")
  [ -n "$newest_sql" ] && prune_filters+=(--filter "- $(basename "$newest_sql")" --filter "- $(basename "$newest_sql").sha256")
  [ -n "$newest_globals" ] && prune_filters+=(--filter "- $(basename "$newest_globals")" --filter "- $(basename "$newest_globals").sha256")
  prune_remote_subdir "pg" "${prune_filters[@]}"
  log "Encrypted PostgreSQL backup push to Google Drive OK."
}

prune_remote_subdir() {
  local subdir="$1"
  shift || true
  run_rclone delete "${REMOTE_ROOT}/${subdir}" --min-age "$REMOTE_RETENTION_AGE" "$@" || true
}

sync_media() {
  local src_host="/userdata/storage/gaeru-media-backups"
  local src_chroot="/storage/gaeru-media-backups"
  if [ ! -d "$src_host" ]; then
    log "WARN (media): Source directory missing ($src_host); skipping remote prune to protect existing Drive backups."
    SYNC_STATUS="missing_backup"
    SYNC_WARNINGS+=("media_source_missing")
    return 0
  fi
  local newest newest_base
  newest=$(ls -1t "$src_host"/gaeru-media-config-*.tar.gz.gpg 2>/dev/null | head -n 1 || true)
  if [ -z "$newest" ] || [ ! -s "$newest" ] || [ ! -s "${newest}.sha256" ]; then
    log "WARN (media): No complete encrypted media backup (.tar.gz.gpg + .sha256) in $src_host; preserving remote backups without pruning."
    SYNC_STATUS="missing_backup"
    SYNC_WARNINGS+=("media_archive_missing")
    return 0
  fi
  newest_base=$(basename "$newest")
  log "Pushing encrypted Media + Codebase + System Config backups to ${REMOTE_ROOT}/media ($newest_base) ..."
  run_rclone copy "$src_chroot" "${REMOTE_ROOT}/media" \
    --filter "+ ${newest_base}" \
    --filter "+ ${newest_base}.sha256" \
    --filter "- *" \
    "${COMMON_FLAGS[@]}"

  # Fail-closed: verify BOTH archive and checksum exist non-empty on Drive before pruning older generations,
  # and ALWAYS exclude the newest complete pair so Drive can never lose its last valid media backup.
  if ! remote_file_verified "$src_chroot" "media" "$newest_base" || ! remote_file_verified "$src_chroot" "media" "${newest_base}.sha256"; then
    log "WARN (media): Remote verification failed for $newest_base; skipping remote prune to protect existing Drive backups."
    SYNC_STATUS="verify_failed"
    SYNC_WARNINGS+=("media_remote_verify_failed")
    return 0
  fi

  prune_remote_subdir "media" --filter "- ${newest_base}" --filter "- ${newest_base}.sha256"
  log "Encrypted Media + Codebase backup push to Google Drive OK."
}

case "$MODE" in
  pg) sync_pg ;;
  media) sync_media ;;
  all)
    sync_pg
    sync_media
    ;;
  *)
    echo "Usage: $0 {all|pg|media|status}" >&2
    exit 1
    ;;
esac

STAMP_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
WARNINGS_JSON="[]"
if [ "${#SYNC_WARNINGS[@]}" -gt 0 ]; then
  WARNINGS_JSON=$(printf '"%s",' "${SYNC_WARNINGS[@]}")
  WARNINGS_JSON="[${WARNINGS_JSON%,}]"
fi
cat > "${STATUS_FILE}.tmp" <<EOF
{
  "last_sync_utc": "$STAMP_UTC",
  "mode": "$MODE",
  "remote": "$REMOTE_ROOT",
  "encrypted_only": true,
  "status": "$SYNC_STATUS",
  "warnings": $WARNINGS_JSON
}
EOF
mv "${STATUS_FILE}.tmp" "$STATUS_FILE"
if [ "$SYNC_STATUS" != "ok" ]; then
  log "Finished with status=$SYNC_STATUS (warnings=${SYNC_WARNINGS[*]:-none})."
  exit 2
fi
