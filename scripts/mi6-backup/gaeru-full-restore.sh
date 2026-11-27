#!/bin/bash
# GAERU 1-Command Bare-Metal Disaster Recovery & Verification Tool (Xiaomi Mi 6 / Linux ARM64)
# Supports pulling encrypted backups from Google Drive (gdrive:GAERU_Backups),
# failing closed on missing/mismatched SHA-256 companions, and restoring DB, Media+Code, and Mail.
set -euo pipefail
unset LD_PRELOAD 2>/dev/null || true
export LANG=C.UTF-8 LC_ALL=C.UTF-8
unset LANGUAGE 2>/dev/null || true
umask 077

PG_DIR="/userdata/storage/gaeru-pg-backups"
MEDIA_DIR="/userdata/storage/gaeru-media-backups"
CHROOT="/userdata/storage/ubuntu"
CHROOT_STORAGE="/storage/ubuntu"

DEPLOY_LOCK="/run/gaeru-deploy.lock"
DEPLOY_LOCK_OWNED=0
GAERU_TMP_CLEANUP_FILES=()
GAERU_TMP_CLEANUP_DIRS=()
cleanup_temp_files() {
  local f d
  for f in "${GAERU_TMP_CLEANUP_FILES[@]:-}"; do
    [ -n "$f" ] && rm -f -- "$f" 2>/dev/null || true
  done
  for d in "${GAERU_TMP_CLEANUP_DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf -- "$d" 2>/dev/null || true
  done
}
cleanup_deploy_lock() {
  if [ "$DEPLOY_LOCK_OWNED" -eq 1 ]; then
    rm -f -- "$DEPLOY_LOCK" 2>/dev/null || true
    DEPLOY_LOCK_OWNED=0
  fi
}
RESTART_ON_EXIT=0
RESTORE_MODE="restore"
finish_restore() {
  local result=$?
  trap - EXIT
  if [ "$RESTART_ON_EXIT" -eq 1 ]; then
    if [ "$result" -ne 0 ]; then
      if [ "$RESTORE_MODE" = "db" ]; then
        printf '[%s] Restore did not complete (exit=%s); rolled back database transaction and restoring previous node-app service.\n' "$(date -Is)" "$result" >&2
      else
        printf '[%s] Restore (%s) did not complete (exit=%s); restarting node-app service.\n' "$(date -Is)" "$RESTORE_MODE" "$result" >&2
      fi
    fi
    initctl status node-app APP=gaeru 2>/dev/null | grep -q 'start/running' ||
      initctl start node-app APP=gaeru >&2 || result=1
  fi
  cleanup_temp_files
  cleanup_deploy_lock
  exit "$result"
}
trap finish_restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_deploy_lock() {
  [ "$DEPLOY_LOCK_OWNED" -eq 1 ] && return 0
  mkdir -p "$(dirname "$DEPLOY_LOCK")" 2>/dev/null || true
  exec 9>>"$DEPLOY_LOCK"
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || die "Another deploy or restore operation is holding $DEPLOY_LOCK"
  fi
  printf '%s\n' "$$" >&9
  DEPLOY_LOCK_OWNED=1
}

stop_gaeru_app() {
  say "Stopping node-app (APP=gaeru)..."
  initctl stop node-app APP=gaeru 2>/dev/null || true
  local w=0
  while [ "$w" -lt 20 ] && pgrep -f '/storage/apps/gaeru/src/' >/dev/null 2>&1; do
    sleep 0.5
    w=$((w + 1))
  done
  if pgrep -f '/storage/apps/gaeru/src/' >/dev/null 2>&1; then
    pkill -f '/storage/apps/gaeru/src/' 2>/dev/null || true
    sleep 1
  fi
}

start_gaeru_app() {
  say "Starting node-app (APP=gaeru)..."
  initctl start node-app APP=gaeru
  initctl status node-app APP=gaeru | grep -q 'start/running' || die "node-app APP=gaeru failed to reach start/running state"
}

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
      Verify SHA-256 + OpenPGP envelope integrity of newest PG and Media/Codebase backups.
  gaeru-full-restore.sh --pull-from-gdrive
      Download newest encrypted PG and Media backups from Google Drive (gdrive:GAERU_Backups).
  gaeru-full-restore.sh --restore-db <path/to/decrypted.dump|archive.dump.gpg>
      Restore PostgreSQL database gaeru_store cleanly (stops Node app first).
  gaeru-full-restore.sh --restore-media-code <path/to/decrypted.tar.gz|archive.tar.gz.gpg>
      Restore Web Codebase, AVIF Media Library, Admin Dashboard, and Server Configs (--numeric-owner).
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
  say "=== ALL ACTIVE ENCRYPTED BACKUP LAYERS VERIFIED INTACT (iCloud+ Mail active) ==="
}

select_latest_complete_pg_set() {
  local chroot_dir="$1"
  local listing
  listing=$(env -u LD_PRELOAD chroot "$chroot_dir" /usr/bin/rclone --config /etc/gaeru-rclone/rclone.conf \
    lsf --files-only --format "tps" --separator "|" "gdrive:GAERU_Backups/pg" 2>/dev/null || true)
  # Pick the newest timestamp <STAMP> that has a COMPLETE non-empty pair of BOTH:
  #   gaeru_store-<STAMP>.dump.gpg (+ .sha256) AND gaeru_store-<STAMP>.sql.gz.gpg (+ .sha256)
  # Automatically falls back to the next older complete set if the newest upload is partial.
  printf '%s\n' "$listing" \
    | awk -F'|' '
        $3 + 0 > 0 { ts[$2] = $1; present[$2] = 1 }
        END {
          for (f in present) {
            if (f ~ /^gaeru_store-20.*\.dump\.gpg$/) {
              stamp = f
              sub(/^gaeru_store-/, "", stamp)
              sub(/\.dump\.gpg$/, "", stamp)
              dump_f = "gaeru_store-" stamp ".dump.gpg"
              sql_f = "gaeru_store-" stamp ".sql.gz.gpg"
              glob_f = "gaeru_store-globals-" stamp ".sql.gz.gpg"
              if (present[dump_f] && present[dump_f ".sha256"] && present[sql_f] && present[sql_f ".sha256"]) {
                g = (present[glob_f] && present[glob_f ".sha256"]) ? glob_f : ""
                print ts[dump_f] "|" stamp "|" dump_f "|" sql_f "|" g
              }
            }
          }
        }
      ' \
    | sort -r \
    | head -n 1 || true
}

select_latest_complete_media() {
  local chroot_dir="$1"
  local listing
  listing=$(env -u LD_PRELOAD chroot "$chroot_dir" /usr/bin/rclone --config /etc/gaeru-rclone/rclone.conf \
    lsf --files-only --format "tps" --separator "|" "gdrive:GAERU_Backups/media" 2>/dev/null || true)
  printf '%s\n' "$listing" \
    | awk -F'|' '
        $3 + 0 > 0 { ts[$2] = $1; present[$2] = 1 }
        END {
          for (f in present) {
            if (f ~ /^gaeru-media-config-.*\.tar\.gz\.gpg$/ && present[f ".sha256"]) {
              print ts[f] "|" f
            }
          }
        }
      ' \
    | sort -r \
    | head -n 1 || true
}

format_age_summary() {
  local iso_ts="$1"
  local now_s file_s diff_s hours days
  now_s=$(date +%s)
  file_s=$(date -d "$iso_ts" +%s 2>/dev/null || echo 0)
  if [ "$file_s" -le 0 ] || [ "$now_s" -lt "$file_s" ]; then
    printf 'unknown age'
    return
  fi
  diff_s=$((now_s - file_s))
  hours=$((diff_s / 3600))
  days=$((hours / 24))
  if [ "$days" -gt 0 ]; then
    printf '%dd %dh (%dh)' "$days" "$((hours % 24))" "$hours"
  else
    printf '%dh' "$hours"
  fi
}

pull_remote_pair() {
  local chroot_dir="$1"
  local remote_sub="$2"
  local local_chroot_dir="$3"
  local filename="$4"
  env -u LD_PRELOAD chroot "$chroot_dir" /usr/bin/rclone --config /etc/gaeru-rclone/rclone.conf \
    copy "gdrive:GAERU_Backups/${remote_sub}" "$local_chroot_dir" \
    --filter "+ ${filename}" \
    --filter "+ ${filename}.sha256" \
    --filter "- *" \
    --transfers 2
}

pull_from_gdrive() {
  local chroot_dir
  /usr/local/sbin/ubuntu-mount.sh
  chroot_dir=$(resolve_chroot)
  [ -d "$chroot_dir" ] || die "Missing chroot"
  mkdir -p "$PG_DIR" "$MEDIA_DIR"
  chmod 700 "$PG_DIR" "$MEDIA_DIR"
  say "Inspecting newest complete encrypted backups on Google Drive (gdrive:GAERU_Backups)..."

  local pg_set media_entry
  pg_set=$(select_latest_complete_pg_set "$chroot_dir")
  media_entry=$(select_latest_complete_media "$chroot_dir")

  [ -n "$pg_set" ] || die "No complete PostgreSQL backup set (.dump.gpg + .sql.gz.gpg + .sha256) found on gdrive:GAERU_Backups/pg"
  [ -n "$media_entry" ] || die "No complete Media+Config backup (.tar.gz.gpg + .sha256) found on gdrive:GAERU_Backups/media"

  local pg_ts pg_stamp pg_dump_file pg_sql_file pg_globals_file media_ts media_file
  IFS='|' read -r pg_ts pg_stamp pg_dump_file pg_sql_file pg_globals_file <<< "$pg_set"
  media_ts="${media_entry%%|*}"; media_file="${media_entry#*|}"

  say "Selected complete PG set [${pg_stamp}]: ${pg_dump_file} + ${pg_sql_file} (timestamp=${pg_ts}, age=$(format_age_summary "$pg_ts"))"
  say "Selected complete Media/Code: ${media_file} (timestamp=${media_ts}, age=$(format_age_summary "$media_ts"))"

  pull_remote_pair "$chroot_dir" "pg" "/storage/gaeru-pg-backups" "$pg_dump_file"
  pull_remote_pair "$chroot_dir" "pg" "/storage/gaeru-pg-backups" "$pg_sql_file"
  if [ -n "$pg_globals_file" ]; then
    pull_remote_pair "$chroot_dir" "pg" "/storage/gaeru-pg-backups" "$pg_globals_file"
  fi
  pull_remote_pair "$chroot_dir" "media" "/storage/gaeru-media-backups" "$media_file"
  verify_all
}

restore_db() {
  local raw_input="${1:-}"
  if [ -z "$raw_input" ]; then
    raw_input=$(ls -1t "$PG_DIR"/gaeru_store-20*.dump.gpg 2>/dev/null | head -n 1 || true)
  fi
  [ -n "$raw_input" ] || die "Specify dump file (.dump or .dump.gpg)"

  RESTORE_MODE="db"
  local tmp_base="/var/tmp"
  if [ -d "$PG_DIR" ] && [ -w "$PG_DIR" ]; then
    tmp_base="$PG_DIR"
  elif [ -d "/userdata/storage" ] && [ -w "/userdata/storage" ]; then
    tmp_base="/userdata/storage"
  fi
  local tmp_dir
  tmp_dir=$(mktemp -d "${tmp_base}/.gaeru-restore-db.XXXXXX")
  chmod 700 "$tmp_dir"
  GAERU_TMP_CLEANUP_DIRS+=("$tmp_dir")
  local tmp_plain="${tmp_dir}/restore-db.dump"
  GAERU_TMP_CLEANUP_FILES+=("$tmp_plain")
  local dump_file
  dump_file=$(prepare_restore_input "$raw_input" "$tmp_plain")

  /usr/local/sbin/ubuntu-mount.sh
  local chroot_dir
  chroot_dir=$(resolve_chroot)

  acquire_deploy_lock
  say "Verifying dump TOC before restore: $dump_file"
  chroot "$chroot_dir" /usr/bin/env -u LANGUAGE LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/pg_restore -l < "$dump_file" >/dev/null
  if initctl status node-app APP=gaeru 2>/dev/null | grep -q 'start/running'; then
    RESTART_ON_EXIT=1
  fi
  stop_gaeru_app
  say "Restoring database gaeru_store from $dump_file ..."
  # Only the producer can emit COMMIT, after pg_restore has read the entire archive.
  # A truncated stream, SQL error or interrupted writer rolls back the connection.
  {
    printf 'BEGIN;\n' &&
    chroot "$chroot_dir" /usr/bin/env -u LANGUAGE LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/pg_restore --clean --if-exists --no-owner --no-privileges --file=- < "$dump_file" &&
    cat <<'EOSQL'
RESET search_path;
GRANT ALL PRIVILEGES ON SCHEMA public TO webuser;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO webuser;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO webuser;
GRANT pg_read_all_stats TO webuser;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO webuser;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO webuser;
SELECT count(*) FROM public.products;
SELECT count(*) FROM public.orders;
SELECT count(*) FROM public.media_upload_originals;
COMMIT;
EOSQL
  } | chroot "$chroot_dir" runuser -u postgres -- /usr/bin/env -u LANGUAGE LANG=C.UTF-8 LC_ALL=C.UTF-8 psql -X -v ON_ERROR_STOP=1 -d gaeru_store
  start_gaeru_app
  RESTART_ON_EXIT=0
  say "Database restore completed successfully."
}

restore_media_code() {
  local raw_input="${1:-}"
  if [ -z "$raw_input" ]; then
    raw_input=$(ls -1t "$MEDIA_DIR"/gaeru-media-config-*.tar.gz.gpg 2>/dev/null | head -n 1 || true)
  fi
  [ -n "$raw_input" ] || die "Specify Media/Config archive (.tar.gz or .tar.gz.gpg)"

  RESTORE_MODE="media-code"
  local tmp_base="/var/tmp"
  if [ -d "$MEDIA_DIR" ] && [ -w "$MEDIA_DIR" ]; then
    tmp_base="$MEDIA_DIR"
  elif [ -d "/userdata/storage" ] && [ -w "/userdata/storage" ]; then
    tmp_base="/userdata/storage"
  fi
  local tmp_dir
  tmp_dir=$(mktemp -d "${tmp_base}/.gaeru-restore-media.XXXXXX")
  chmod 700 "$tmp_dir"
  GAERU_TMP_CLEANUP_DIRS+=("$tmp_dir")
  local tmp_plain="${tmp_dir}/restore-media.tar.gz"
  GAERU_TMP_CLEANUP_FILES+=("$tmp_plain")
  local archive
  archive=$(prepare_restore_input "$raw_input" "$tmp_plain")

  acquire_deploy_lock
  say "Testing archive integrity: $archive"
  gzip -t "$archive"
  say "Extracting Media, Codebase, Admin Dashboard, and Server Configs to / ..."
  if (set +o pipefail; tar -tzf "$archive" | grep -qE '(^|/)\.\.(/|$)|^/'); then
    die "Unsafe path traversal or absolute entry detected in archive: $archive"
  fi
  if initctl status node-app APP=gaeru 2>/dev/null | grep -q 'start/running'; then
    RESTART_ON_EXIT=1
  fi
  stop_gaeru_app
  tar -xzpf "$archive" -C / --numeric-owner
  # #06: Restore production node_modules matching package-lock.json on clean hosts (archive excludes node_modules)
  /usr/local/sbin/ubuntu-mount.sh
  local chroot_dir lock_sha stamp_file
  chroot_dir=$(resolve_chroot)
  if [ -f /userdata/storage/apps/gaeru/package-lock.json ]; then
    lock_sha=$(sha256sum /userdata/storage/apps/gaeru/package-lock.json | awk '{print $1}')
    stamp_file="/userdata/storage/apps/gaeru/node_modules/.gaeru-lock-sha256"
    if [ ! -d /userdata/storage/apps/gaeru/node_modules/express ] || [ ! -f "$stamp_file" ] || [ "$(cat "$stamp_file" 2>/dev/null || true)" != "$lock_sha" ]; then
      [ -d "$chroot_dir" ] || die "Missing Ubuntu chroot to install Node.js production dependencies"
      say "Staging ARM64 Node.js production dependencies (npm ci --omit=dev) matching package-lock.json..."
      local stage_dir="/userdata/storage/apps/.gaeru-npm-stage.$$"
      local old_nm="/userdata/storage/apps/gaeru/.node_modules_old.$$"
      GAERU_TMP_CLEANUP_DIRS+=("$stage_dir" "$old_nm")
      mkdir -p "$stage_dir"
      cp -f /userdata/storage/apps/gaeru/package.json /userdata/storage/apps/gaeru/package-lock.json "$stage_dir/"
      chown -R 33:33 "$stage_dir"
      env -u LD_PRELOAD chroot "$chroot_dir" runuser -u www-data -- /usr/bin/env -u LANGUAGE HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin \
        bash -euo pipefail -c "cd '/storage/apps/.gaeru-npm-stage.$$' && npm ci --omit=dev --no-audit --no-fund && node -e \"require('express'); require('pg');\""
      printf '%s\n' "$lock_sha" > "$stage_dir/node_modules/.gaeru-lock-sha256"
      chown 33:33 "$stage_dir/node_modules/.gaeru-lock-sha256"
      if [ -d /userdata/storage/apps/gaeru/node_modules ]; then
        mv /userdata/storage/apps/gaeru/node_modules "$old_nm"
      fi
      mv "$stage_dir/node_modules" /userdata/storage/apps/gaeru/node_modules
      rm -rf "$old_nm" "$stage_dir"
    fi
    env -u LD_PRELOAD chroot "$chroot_dir" runuser -u www-data -- /usr/bin/env -u LANGUAGE PATH=/usr/local/bin:/usr/bin:/bin \
      bash -euo pipefail -c "cd /storage/apps/gaeru && node -e \"require('./src/config'); require('express'); require('pg');\""
  fi
  start_gaeru_app
  RESTART_ON_EXIT=0
  cleanup_deploy_lock
  say "Media + Codebase + System Configs restored cleanly."
}

case "${1:---help}" in
  --verify) verify_all ;;
  --pull-from-gdrive) pull_from_gdrive ;;
  --restore-db) shift; restore_db "${1:-}" ;;
  --restore-media-code) shift; restore_media_code "${1:-}" ;;
  *) usage; exit 1 ;;
esac
