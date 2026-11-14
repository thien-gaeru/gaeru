#!/usr/bin/env bash
# GAERU Mail & Webmail Encrypted Backup Scheduler v0.4 (Production Complete Edition)
# Target: Xiaomi Mi 6, Ubuntu 16 host + Ubuntu 26 chroot.
# Scope: business@gaeru.com + all independent @gaeru.com Maildirs, Postfix, Dovecot,
#        Roundcube DB + WebPush DB + Inbound Sync DB + gaeru_webpush plugin + daemons.
# SECURITY: only the public GPG key is needed on the phone. Do not import the secret key.
set -Eeuo pipefail
unset LD_PRELOAD 2>/dev/null || true
umask 077

SELF=/usr/local/sbin/gaeru-mail-backup-v04.sh
CONFIG=/etc/gaeru-mail-backup-v04.conf
CRON=/etc/cron.d/gaeru-mail-backup-v04
OUT_DIR=/userdata/storage/gaeru-mail-backups
STATE_DIR=/var/lib/gaeru-mail-backup-v04
LOG=/var/lib/gaeru-mail-backup-v04/backup.log
CHROOT=/userdata/storage/ubuntu
PRIMARY_MAIL_DIR="$CHROOT/home/business/Maildir"
DB_IN_CHROOT=/opt/gaeru-webmail/data/roundcube.sqlite
WEBPUSH_DB_IN_CHROOT=/opt/gaeru-webmail/data/webpush.sqlite
SYNC_DB_ON_HOST=/var/lib/gaeru-mail/sync.sqlite
MAX_KEEP=14

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
GAERU Mail Backup Scheduler v0.4
  --check                     Read-only prerequisites, no changes
  --install                   Install this script (cron stays disabled)
  --configure-key FINGERPRINT Configure RSA public-key fingerprint (40 hex chars)
  --run                       Make one encrypted backup and SHA256 manifest
  --status                    Show existing configuration and backup metadata
  --enable                    Enable schedule (every 6h), only after recovery verification
  --disable                   Disable this scheduler, preserve backups

The secret key must remain on Windows, NEVER on the phone.
EOF
}
require_host() {
  [ "$(id -u)" -eq 0 ] || die 'Run as root on Ubuntu 16 host'
  [ -f /etc/os-release ] || die 'Missing /etc/os-release'
  grep -q '^VERSION_ID="16.04"' /etc/os-release || die 'This script is intended for the Ubuntu 16.04 host (not the Ubuntu 26 chroot)'
}
require_commands() {
  local cmd
  for cmd in bash tar gzip sha256sum flock gpg chroot python3 stat date find sort awk; do
    command -v "$cmd" >/dev/null 2>&1 || die "Missing tool: $cmd"
  done
}
required_paths() {
  local p
  for p in \
    /etc/init/gaeru-mail.conf \
    /etc/init/gaeru-webmail-fpm.conf \
    /etc/init/gaeru-webmail-nginx.conf \
    /etc/gaeru-webmail/nginx.conf \
    /usr/local/sbin/gaeru-mail-watch.sh \
    "$CHROOT/usr/bin/python3" \
    "$CHROOT/etc/postfix" \
    "$CHROOT/etc/dovecot" \
    "$CHROOT/etc/ssl/certs/gaeru-imap-lab.crt" \
    "$CHROOT/etc/ssl/private/gaeru-imap-lab.key" \
    "$CHROOT/etc/passwd" \
    "$CHROOT/etc/group" \
    "$CHROOT/etc/shadow" \
    "$CHROOT/etc/gshadow" \
    "$PRIMARY_MAIL_DIR" \
    "$CHROOT/opt/gaeru-webmail/php-fpm.conf" \
    "$CHROOT/opt/gaeru-webmail/roundcube/config/config.inc.php" \
    "$CHROOT/opt/gaeru-webmail/roundcubemail-1.7.6-complete.tar.gz" \
    "$CHROOT$DB_IN_CHROOT"; do
    [ -e "$p" ] || die "Required path absent: $p"
  done
}
validate_fpr() {
  local fpr="$1"
  [[ "$fpr" =~ ^[0-9A-Fa-f]{40}$ ]] || die 'Fingerprint must be exactly 40 hexadecimal characters'
}
public_key_is_present() {
  local fpr="$1"
  gpg --batch --no-tty --with-colons --fingerprint --list-keys "$fpr" 2>/dev/null | \
    awk -F: -v expect="$fpr" '$1=="fpr" && toupper($10)==toupper(expect) { found=1 } END { exit !found }'
}
secret_key_is_present() {
  local fpr="$1"
  gpg --batch --no-tty --with-colons --list-secret-keys "$fpr" 2>/dev/null | grep -q '^sec:'
}
load_key() {
  [ -r "$CONFIG" ] || die "Missing $CONFIG; run --configure-key FINGERPRINT first"
  local value
  value=$(sed -n 's/^GPG_FINGERPRINT=//p' "$CONFIG")
  validate_fpr "$value"
  GPG_FPR="$(printf '%s' "$value" | tr 'abcdef' 'ABCDEF')"
  public_key_is_present "$GPG_FPR" || die 'Configured GPG public key is absent'
  if secret_key_is_present "$GPG_FPR"; then
    die 'A matching SECRET key is on the phone. Remove it securely after ensuring you have the Windows copy; do not proceed with backups.'
  fi
}
check() {
  require_host
  require_commands
  required_paths
  [ -d "$CHROOT" ] || die 'Ubuntu 26 chroot missing'
  [ -r "$CHROOT$DB_IN_CHROOT" ] || die 'Roundcube database not readable'
  [ -d /userdata/storage ] || die 'Storage mount missing'
  say '=== GAERU BACKUP PREFLIGHT ==='
  date '+Host time: %Y-%m-%d %H:%M:%S %Z %z'
  df -h /userdata | tail -n 1
  say "Primary Maildir: $PRIMARY_MAIL_DIR"
  say "All Maildirs: $(find "$CHROOT/home" -mindepth 2 -maxdepth 2 -type d -name Maildir 2>/dev/null | tr '\n' ' ')"
  say "Roundcube DB: $DB_IN_CHROOT"
  say "GPG: $(gpg --version | sed -n '1p')"
  if [ -r "$CONFIG" ]; then
    load_key
    say "Public recipient: $GPG_FPR (no corresponding secret key on phone)"
  else
    say 'Public recipient: NOT CONFIGURED; this is expected before key import'
  fi
  if [ -f "$CRON" ]; then say 'Schedule: ENABLED'; else say 'Schedule: DISABLED'; fi
  say 'PREFLIGHT: OK'
}
install_self() {
  require_host
  require_commands
  required_paths
  [ -r "$0" ] || die 'Cannot read installer file'
  mkdir -p "$STATE_DIR" "$OUT_DIR"
  chmod 700 "$STATE_DIR" "$OUT_DIR"
  install -m 0700 "$0" "$SELF"
  say "INSTALLED: $SELF"
}
configure_key() {
  require_host
  require_commands
  [ "$#" -eq 1 ] || die 'Usage: --configure-key 40_HEX_FINGERPRINT'
  local fpr="$1"
  validate_fpr "$fpr"
  fpr=$(printf '%s' "$fpr" | tr 'abcdef' 'ABCDEF')
  public_key_is_present "$fpr" || die 'GPG public key not imported or fingerprint does not match'
  if secret_key_is_present "$fpr"; then die 'Matching private key must not be stored on the phone'; fi
  (umask 077; printf 'GPG_FINGERPRINT=%s\n' "$fpr" > "$CONFIG")
  chmod 600 "$CONFIG"
  say "PUBLIC KEY CONFIGURED: $fpr"
}
backup_run() {
  require_host
  require_commands
  required_paths
  load_key
  [ -x "$SELF" ] || die "Install script first using --install ($SELF)"

  mkdir -p "$OUT_DIR" "$STATE_DIR"
  chmod 700 "$OUT_DIR" "$STATE_DIR"
  exec 9>"$STATE_DIR/backup.lock"
  if ! flock -n 9; then
    say 'SKIP: another backup is already running'
    return 0
  fi

  local stamp snap_rc snap_rc_host snap_wp snap_wp_host snap_sync snap_sync_host filename final checksum bname bytes hash
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  snap_rc="/opt/gaeru-webmail/data/.gaeru-mail-v04-snapshot-$$.sqlite"
  snap_rc_host="$CHROOT$snap_rc"
  snap_wp="/opt/gaeru-webmail/data/.gaeru-webpush-v04-snapshot-$$.sqlite"
  snap_wp_host="$CHROOT$snap_wp"
  snap_sync="/opt/gaeru-webmail/data/.gaeru-sync-v04-snapshot-$$.sqlite"
  snap_sync_host="$CHROOT$snap_sync"
  filename="gaeru-mail-v04-$stamp.tar.gz.gpg"
  tmp="$OUT_DIR/.$filename.part.$$"
  final="$OUT_DIR/$filename"
  checksum="$OUT_DIR/$filename.sha256"

  cleanup() {
    rm -f -- "${snap_rc_host:-}" "${snap_wp_host:-}" "${snap_sync_host:-}"
    if [ -n "${tmp:-}" ]; then rm -f -- "$tmp"; fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  say "=== GAERU ENCRYPTED MAIL & WEBMAIL BACKUP $stamp ==="
  if [ -f "$SYNC_DB_ON_HOST" ]; then
    cp -f "$SYNC_DB_ON_HOST" "$snap_sync_host"
    chmod 600 "$snap_sync_host"
  fi
  # Make consistent online SQLite snapshots while Roundcube & Inbound Sync stay online.
  env -u LD_PRELOAD chroot "$CHROOT" /usr/bin/python3 - "$snap_rc" "$snap_wp" "$snap_sync" <<'PY'
import os, sqlite3, sys
os.umask(0o077)
def snapshot_db(src_file, dst_file, label):
    if not os.path.exists(src_file):
        return
    src = sqlite3.connect(f'file:{src_file}?mode=ro', uri=True, timeout=30)
    dst = sqlite3.connect(dst_file, timeout=30)
    try:
        src.backup(dst, pages=64, sleep=0.05)
        verdict = dst.execute('PRAGMA integrity_check').fetchone()[0]
        if verdict != 'ok':
            raise RuntimeError(f'{label} integrity_check failed: {verdict}')
        print(f'{label}: OK', flush=True)
    finally:
        dst.close()
        src.close()

snapshot_db('/opt/gaeru-webmail/data/roundcube.sqlite', sys.argv[1], 'ROUNDCUBE_SQLITE_SNAPSHOT')
snapshot_db('/opt/gaeru-webmail/data/webpush.sqlite', sys.argv[2], 'WEBPUSH_SQLITE_SNAPSHOT')
if os.path.exists(sys.argv[3]):
    conn = sqlite3.connect(sys.argv[3], timeout=30)
    verdict = conn.execute('PRAGMA integrity_check').fetchone()[0]
    conn.close()
    if verdict != 'ok':
        raise RuntimeError(f'SYNC_SQLITE_SNAPSHOT integrity_check failed: {verdict}')
    print('SYNC_SQLITE_SNAPSHOT: OK', flush=True)
PY

  local -a paths=(
    etc/init/gaeru-mail.conf
    etc/init/gaeru-webmail-fpm.conf
    etc/init/gaeru-webmail-nginx.conf
    etc/gaeru-webmail/nginx.conf
    usr/local/sbin/gaeru-mail-watch.sh
    userdata/storage/ubuntu/etc/postfix
    userdata/storage/ubuntu/etc/dovecot
    userdata/storage/ubuntu/etc/ssl/certs/gaeru-imap-lab.crt
    userdata/storage/ubuntu/etc/ssl/private/gaeru-imap-lab.key
    userdata/storage/ubuntu/etc/passwd
    userdata/storage/ubuntu/etc/group
    userdata/storage/ubuntu/etc/shadow
    userdata/storage/ubuntu/etc/gshadow
    userdata/storage/ubuntu/opt/gaeru-webmail/php-fpm.conf
    userdata/storage/ubuntu/opt/gaeru-webmail/roundcube/config
    userdata/storage/ubuntu/opt/gaeru-webmail/roundcubemail-1.7.6-complete.tar.gz
    "userdata/storage/ubuntu${snap_rc}"
  )

  # Include all Maildir folders (business + any custom independent mailboxes)
  local mdir
  while IFS= read -r mdir; do
    [ -n "$mdir" ] && paths+=("${mdir#/}")
  done < <(find "$CHROOT/home" -mindepth 2 -maxdepth 2 -type d -name Maildir 2>/dev/null | sort)

  # Include optional/new WebPush & Inbound Sync components
  local opt_rel
  for opt_rel in \
    etc/init/gaeru-mail-sync.conf \
    etc/gaeru-mail/config.json \
    usr/local/bin/gaeru-mail-sync.py \
    usr/local/bin/gaeru-mail-account \
    "userdata/storage/ubuntu${snap_wp}" \
    "userdata/storage/ubuntu${snap_sync}" \
    userdata/storage/ubuntu/opt/gaeru-webmail/roundcube/plugins/gaeru_webpush \
    userdata/storage/ubuntu/opt/gaeru-webmail/roundcube/program/lib/Roundcube/rcube_session.php \
    userdata/storage/ubuntu/opt/gaeru-webmail/roundcube/public_html/sw-push.js \
    userdata/storage/ubuntu/opt/gaeru-webmail/roundcube/public_html/skins/elastic/images; do
    if [ -e "/$opt_rel" ]; then
      paths+=("$opt_rel")
    fi
  done

  tar -C / -czpf - --numeric-owner "${paths[@]}" | \
    gpg --batch --no-tty --yes --trust-model always \
      --cipher-algo AES256 --compress-algo none \
      --encrypt --recipient "$GPG_FPR" --output "$tmp"

  [ -s "$tmp" ] || die 'Encrypted archive is empty'
  chmod 600 "$tmp"
  mv -- "$tmp" "$final"
  bname=$(basename "$final")
  (cd "$OUT_DIR" && sha256sum "$bname" > "$bname.sha256")
  (cd "$OUT_DIR" && sha256sum -c "$bname.sha256") || die 'Post-write SHA256 validation failed'
  bytes=$(stat -c%s "$final")
  hash=$(sha256sum "$final" | awk '{print $1}')
  printf 'timestamp_utc=%s\nfile=%s\nsize_bytes=%s\nsha256=%s\n' \
    "$stamp" "$final" "$bytes" "$hash" > "$STATE_DIR/.last-success.part.$$"
  mv "$STATE_DIR/.last-success.part.$$" "$STATE_DIR/last-success"
  chmod 600 "$STATE_DIR/last-success"
  say "BACKUP OK: $final ($bytes bytes)"
  say "SHA256: $hash"

  # Retain the 14 newest v0.4 files only
  local n=0 old
  while IFS= read -r old; do
    n=$((n+1))
    if [ "$n" -gt "$MAX_KEEP" ]; then
      rm -f -- "$OUT_DIR/$old" "$OUT_DIR/$old.sha256"
      say "ROTATED: $old"
    fi
  done < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'gaeru-mail-v04-*.tar.gz.gpg' -printf '%f\n' | sort -r)

  # Push independently to Google Drive in background if configured
  if [ -x /usr/local/sbin/gaeru-gdrive-sync.sh ]; then
    nohup /usr/local/sbin/gaeru-gdrive-sync.sh mail >> /var/log/gaeru-gdrive-sync.log 2>&1 &
  fi
  cleanup
  trap - EXIT INT TERM
}
status() {
  require_host
  say '=== GAERU MAIL BACKUP v0.4 STATUS ==='
  if [ -e "$SELF" ]; then say 'Installed: YES'; else say 'Installed: NO'; fi
  if [ -e "$CONFIG" ]; then say 'Public key configured: YES'; else say 'Public key configured: NO'; fi
  if [ -e "$CRON" ]; then say 'Schedule: ENABLED'; else say 'Schedule: DISABLED'; fi
  if [ -f "$STATE_DIR/last-success" ]; then cat "$STATE_DIR/last-success"; else say 'Last successful encrypted backup: NONE'; fi
  if [ -d "$OUT_DIR" ]; then
    say 'Newest encrypted backup files:'
    find "$OUT_DIR" -maxdepth 1 -type f -name 'gaeru-mail-v04-*.tar.gz.gpg' -printf '%TY-%Tm-%Td %TH:%TM %s %f\n' | sort -r | sed -n '1,5p'
  fi
}
enable() {
  require_host
  [ -x "$SELF" ] || die 'Install first using --install'
  [ -r "$STATE_DIR/last-success" ] || die 'Create and test an encrypted backup first'
  load_key
  cat > "$CRON" <<EOF
# GAERU Mail Backup v0.4; host timezone currently UTC+07 (runs every 6 hours).
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
20 3,9,15,21 * * * root $SELF --run >> $LOG 2>&1
EOF
  chmod 644 "$CRON"
  say 'CRON ENABLED: 03:20, 09:20, 15:20, 21:20 daily in Ubuntu 16 local timezone'
}
disable() {
  require_host
  if [ -f "$CRON" ]; then rm -- "$CRON"; say 'CRON DISABLED: backups preserved'; else say 'CRON already disabled'; fi
}

case "${1:---help}" in
  --help|-h) usage ;;
  --check) [ "$#" -eq 1 ] || die 'No extra arguments allowed'; check ;;
  --install) [ "$#" -eq 1 ] || die 'No extra arguments allowed'; install_self ;;
  --configure-key) shift; configure_key "$@" ;;
  --run) [ "$#" -eq 1 ] || die 'No extra arguments allowed'; backup_run ;;
  --status) [ "$#" -eq 1 ] || die 'No extra arguments allowed'; status ;;
  --enable) [ "$#" -eq 1 ] || die 'No extra arguments allowed'; enable ;;
  --disable) [ "$#" -eq 1 ] || die 'No extra arguments allowed'; disable ;;
  *) usage; die 'Unknown argument' ;;
esac
