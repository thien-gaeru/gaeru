#!/bin/bash
set -euo pipefail
unset LD_PRELOAD 2>/dev/null || true
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=gaeru-gpg-common.sh
. "${SCRIPT_DIR}/gaeru-gpg-common.sh"

DEST=/userdata/storage/gaeru-media-backups
APP_DIR=/userdata/storage/apps/gaeru
MEDIA_DIR=/userdata/storage/apps/gaeru/media
MAX_KEEP=14
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT_GPG="$DEST/gaeru-media-config-${STAMP}.tar.gz.gpg"
TMP_TAR="$DEST/.gaeru-media-config-${STAMP}.tar.gz.tmp.$$"

cleanup() {
  rm -f -- "$TMP_TAR" "${OUT_GPG}.tmp."* 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec 200>/run/gaeru-media-backup.lock
flock -n 200 || { echo "$(date -Is) Media backup already running"; exit 0; }

# Fail closed before archiving configs if GPG recipient key is missing.
gaeru_load_gpg_recipient

mkdir -p "$DEST" && chmod 700 "$DEST"

if [ ! -d "$MEDIA_DIR" ]; then
  echo "$(date -Is) FAIL missing $MEDIA_DIR"
  exit 1
fi

CONFIG_CANDIDATES=(
  userdata/storage/admin
  etc/cloudflared
  etc/init.d/cloudflared
  etc/nginx
  etc/gaeru-webmail
  etc/gaeru-mail
  etc/gaeru-mail-backup-v04.conf
  etc/gaeru-backup-gpg.conf
  etc/init/node-app.conf
  etc/init/postgresql-chroot.conf
  etc/init/network-watchdog.conf
  etc/init/gaeru-health.conf
  etc/init/server-dashboard.conf
  etc/init/battery-limiter.conf
  etc/init/gaeru-mail.conf
  etc/init/gaeru-mail-sync.conf
  etc/init/gaeru-webmail-fpm.conf
  etc/init/gaeru-webmail-nginx.conf
  usr/local/bin/network_watchdog.sh
  usr/local/bin/hw_tune.sh
  usr/local/bin/battery_limiter.py
  usr/local/bin/gaeru-mail-sync.py
  usr/local/bin/gaeru-mail-account
  usr/local/bin/gaeru-media-sync.py
  usr/local/sbin/gaeru-gpg-common.sh
  usr/local/sbin/gaeru-pg-backup.sh
  usr/local/sbin/gaeru-media-backup.sh
  usr/local/sbin/gaeru-mail-backup-v04.sh
  usr/local/sbin/gaeru-gdrive-sync.sh
  usr/local/sbin/gaeru-full-restore.sh
  usr/local/sbin/gaeru-healthcheck.sh
  usr/local/sbin/ubuntu-mount.sh
  etc/cron.d
  etc/logrotate.d/gaeru-custom
)

EXISTING_CFGS=()
for rel in "${CONFIG_CANDIDATES[@]}"; do
  if [ -e "/$rel" ]; then
    EXISTING_CFGS+=("$rel")
  fi
done

tar --exclude='node_modules' \
    --exclude='.local-data' \
    --exclude='.tmp-test' \
    --exclude='.git' \
    --exclude='scratch' \
    --exclude='backups' \
    --exclude='.gaeru-*' \
    --exclude='*.tmp.*' \
    --exclude='logs/*.log' \
    -czf "$TMP_TAR" \
    -C / userdata/storage/apps/gaeru \
    "${EXISTING_CFGS[@]}"

[ -s "$TMP_TAR" ] || { echo "$(date -Is) FAIL empty archive"; exit 1; }

gzip -t "$TMP_TAR"
tar -tzf "$TMP_TAR" >/dev/null
gaeru_gpg_encrypt_and_wipe "$TMP_TAR" "$OUT_GPG"

# Fail-closed SHA-256 verification before pruning older backups or spawning offsite sync
(cd "$DEST" && sha256sum -c "$(basename "$OUT_GPG").sha256" >/dev/null)

# Remove any legacy unencrypted archives in DEST so plaintext secrets never leave via Drive
rm -f -- "$DEST"/gaeru-media-config-*.tar.gz "$DEST"/gaeru-media-config-*.tar.gz.sha256 2>/dev/null || true

gaeru_prune_old_files "$DEST" "gaeru-media-config-*.tar.gz.gpg" "$MAX_KEEP"

echo "$(date -Is) OK encrypted $OUT_GPG ($(stat -c%s "$OUT_GPG") bytes)"

# Push independently to Google Drive in background if configured
if [ -x /usr/local/sbin/gaeru-gdrive-sync.sh ]; then
  nohup /usr/local/sbin/gaeru-gdrive-sync.sh media >> /var/log/gaeru-gdrive-sync.log 2>&1 &
fi
