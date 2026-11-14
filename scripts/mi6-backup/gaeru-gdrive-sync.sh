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

sync_pg() {
  local src_host="/userdata/storage/gaeru-pg-backups"
  local src_chroot="/storage/gaeru-pg-backups"
  [ -d "$src_host" ] || return 0
  log "Pushing encrypted PostgreSQL backups to ${REMOTE_ROOT}/pg ..."
  local filter_args=(
    --filter "+ gaeru_store-latest.sql.gz.gpg"
    --filter "+ gaeru_store-latest.sql.gz.gpg.sha256"
    --filter "+ gaeru_store-latest.dump.gpg"
    --filter "+ gaeru_store-latest.dump.gpg.sha256"
    --filter "+ gaeru_store-globals-latest.sql.gz.gpg"
    --filter "+ gaeru_store-globals-latest.sql.gz.gpg.sha256"
  )
  local current_hour
  current_hour=$(date +%H)
  if [ "$MODE" = "all" ] || [ "$current_hour" = "03" ]; then
    local newest newest_sql newest_globals
    newest=$(ls -1t "$src_host"/gaeru_store-20*.dump.gpg 2>/dev/null | head -n 1 || true)
    newest_sql=$(ls -1t "$src_host"/gaeru_store-20*.sql.gz.gpg 2>/dev/null | head -n 1 || true)
    newest_globals=$(ls -1t "$src_host"/gaeru_store-globals-20*.sql.gz.gpg 2>/dev/null | head -n 1 || true)
    [ -n "$newest" ] && filter_args+=(--filter "+ $(basename "$newest")" --filter "+ $(basename "$newest").sha256")
    [ -n "$newest_sql" ] && filter_args+=(--filter "+ $(basename "$newest_sql")" --filter "+ $(basename "$newest_sql").sha256")
    [ -n "$newest_globals" ] && filter_args+=(--filter "+ $(basename "$newest_globals")" --filter "+ $(basename "$newest_globals").sha256")
  fi
  filter_args+=(--filter "- *")

  run_rclone copy "$src_chroot" "${REMOTE_ROOT}/pg" "${filter_args[@]}" "${COMMON_FLAGS[@]}"
  prune_remote_subdir "pg" --filter "- *-latest.*" --filter "- *-latest.*.*"
  log "Encrypted PostgreSQL backup push to Google Drive OK."
}

prune_remote_subdir() {
  local subdir="$1"
  shift || true
  run_rclone delete "${REMOTE_ROOT}/${subdir}" --min-age "$REMOTE_RETENTION_AGE" "$@" || true
}

sync_mail() {
  local src_host="/userdata/storage/gaeru-mail-backups"
  local src_chroot="/storage/gaeru-mail-backups"
  [ -d "$src_host" ] || return 0
  local newest
  newest=$(ls -1t "$src_host"/gaeru-mail-v04-*.tar.gz.gpg 2>/dev/null | head -n 1 || true)
  [ -n "$newest" ] || return 0
  log "Pushing Encrypted Mail & Webmail backups to ${REMOTE_ROOT}/mail ..."
  run_rclone copy "$src_chroot" "${REMOTE_ROOT}/mail" \
    --filter "+ $(basename "$newest")" \
    --filter "+ $(basename "$newest").sha256" \
    --filter "- *" \
    "${COMMON_FLAGS[@]}"
  prune_remote_subdir "mail"
  log "Encrypted Mail backup push to Google Drive OK."
}

sync_media() {
  local src_host="/userdata/storage/gaeru-media-backups"
  local src_chroot="/storage/gaeru-media-backups"
  [ -d "$src_host" ] || return 0
  log "Pushing encrypted Media + Codebase + System Config backups to ${REMOTE_ROOT}/media ..."
  local newest
  newest=$(ls -1t "$src_host"/gaeru-media-config-*.tar.gz.gpg 2>/dev/null | head -n 1 || true)
  if [ -n "$newest" ]; then
    run_rclone copy "$src_chroot" "${REMOTE_ROOT}/media" \
      --filter "+ $(basename "$newest")" \
      --filter "+ $(basename "$newest").sha256" \
      --filter "- *" \
      "${COMMON_FLAGS[@]}"
  fi
  prune_remote_subdir "media"
  log "Encrypted Media + Codebase backup push to Google Drive OK."
}

case "$MODE" in
  pg) sync_pg ;;
  mail) sync_mail ;;
  media) sync_media ;;
  all)
    sync_pg
    sync_mail
    sync_media
    ;;
  *)
    echo "Usage: $0 {all|pg|mail|media|status}" >&2
    exit 1
    ;;
esac

STAMP_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "${STATUS_FILE}.tmp" <<EOF
{
  "last_sync_utc": "$STAMP_UTC",
  "mode": "$MODE",
  "remote": "$REMOTE_ROOT",
  "encrypted_only": true,
  "status": "ok"
}
EOF
mv "${STATUS_FILE}.tmp" "$STATUS_FILE"
