#!/bin/bash
# Shared OpenPGP (public-key-only) encryption helpers for GAERU Mi 6 autonomous backups.
# Secret keys MUST NOT reside on the phone; only the public recipient key is loaded.
export LANG=C.UTF-8 LC_ALL=C.UTF-8
unset LANGUAGE 2>/dev/null || true

GAERU_GPG_CONFIG_PRIMARY="/etc/gaeru-backup-gpg.conf"

gaeru_die() {
  echo "[$(date -Is)] ERROR: $*" >&2
  exit 1
}

gaeru_find_gpg() {
  if command -v gpg >/dev/null 2>&1; then
    command -v gpg
    return 0
  fi
  if command -v gpg2 >/dev/null 2>&1; then
    command -v gpg2
    return 0
  fi
  gaeru_die "gpg binary not found on host PATH"
}

gaeru_load_gpg_recipient() {
  local cfg="" fpr="" gpg_bin
  if [ -r "$GAERU_GPG_CONFIG_PRIMARY" ]; then
    cfg="$GAERU_GPG_CONFIG_PRIMARY"
  else
    gaeru_die "Missing GPG recipient config ($GAERU_GPG_CONFIG_PRIMARY); refusing unencrypted backup"
  fi

  fpr=$(sed -n 's/^GPG_FINGERPRINT=//p' "$cfg" | head -n 1 | tr -d '[:space:]')
  [[ "$fpr" =~ ^[0-9A-Fa-f]{40}$ ]] || gaeru_die "Invalid GPG_FINGERPRINT in $cfg (expected 40 hex chars)"
  fpr=$(printf '%s' "$fpr" | tr 'abcdef' 'ABCDEF')

  gpg_bin=$(gaeru_find_gpg)
  "$gpg_bin" --batch --no-tty --with-colons --fingerprint --list-keys "$fpr" 2>/dev/null | \
    awk -F: -v expect="$fpr" '$1=="fpr" && toupper($10)==toupper(expect) { found=1 } END { exit !found }' || \
    gaeru_die "Configured GPG public key $fpr is not imported in keyring"

  if "$gpg_bin" --batch --no-tty --with-colons --list-secret-keys "$fpr" 2>/dev/null | grep -q '^sec:'; then
    gaeru_die "Refusing backup: matching GPG secret key for $fpr MUST NOT be stored on Mi 6"
  fi

  GAERU_GPG_BIN="$gpg_bin"
  GAERU_GPG_FPR="$fpr"
}

# Encrypt src_file -> dst_gpg atomically (mode 600), write .sha256, and remove plaintext src_file.
gaeru_gpg_encrypt_and_wipe() {
  local src_file="$1"
  local dst_gpg="$2"
  local tmp_gpg="${dst_gpg}.tmp.$$"
  local dst_dir dst_base

  [ -s "$src_file" ] || gaeru_die "Cannot encrypt missing or empty file: $src_file"
  [ -n "${GAERU_GPG_FPR:-}" ] || gaeru_load_gpg_recipient

  umask 077
  rm -f -- "$tmp_gpg"
  "$GAERU_GPG_BIN" --batch --yes --no-tty --trust-model always \
    --cipher-algo AES256 --compress-algo 0 \
    --encrypt --recipient "$GAERU_GPG_FPR" \
    --output "$tmp_gpg" "$src_file"

  [ -s "$tmp_gpg" ] || { rm -f -- "$tmp_gpg"; gaeru_die "GPG encryption produced empty file: $dst_gpg"; }
  chmod 600 "$tmp_gpg"
  mv -f "$tmp_gpg" "$dst_gpg"

  dst_dir=$(dirname "$dst_gpg")
  dst_base=$(basename "$dst_gpg")
  (cd "$dst_dir" && sha256sum "$dst_base" > "${dst_base}.sha256" && chmod 600 "${dst_base}.sha256" && sha256sum -c "${dst_base}.sha256" >/dev/null)

  rm -f -- "$src_file"
}

gaeru_copy_latest_encrypted() {
  local src_gpg="$1"
  local latest_gpg="$2"
  local tmp_latest="${latest_gpg}.tmp.$$"
  local latest_dir latest_base

  umask 077
  cp -f "$src_gpg" "$tmp_latest"
  chmod 600 "$tmp_latest"
  mv -f "$tmp_latest" "$latest_gpg"
  latest_dir=$(dirname "$latest_gpg")
  latest_base=$(basename "$latest_gpg")
  (cd "$latest_dir" && sha256sum "$latest_base" > "${latest_base}.sha256" && chmod 600 "${latest_base}.sha256" && sha256sum -c "${latest_base}.sha256" >/dev/null)
}

gaeru_prune_old_files() {
  local dir="$1"
  local pattern="$2"
  local max_keep="$3"
  local count=0 f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    count=$((count + 1))
    if [ "$count" -gt "$max_keep" ]; then
      rm -f -- "$f" "${f}.sha256"
    fi
  done < <(ls -1t "$dir"/$pattern 2>/dev/null || true)
}

# Prune timestamped backups matching glob inside dir whose mtime is older than
# max_age_hours, while always keeping at least min_keep newest backups intact and
# never touching *-latest.* aliases. Prints count of removed archive files to stdout.
gaeru_prune_older_than_hours() {
  local dir="$1"
  local pattern="$2"
  local max_age_hours="${3:-48}"
  local min_keep="${4:-1}"

  [[ "$max_age_hours" =~ ^[0-9]+$ ]] && [ "$max_age_hours" -ge 1 ] || gaeru_die "Invalid max_age_hours: $max_age_hours"
  [[ "$min_keep" =~ ^[0-9]+$ ]] && [ "$min_keep" -ge 1 ] || gaeru_die "Invalid min_keep: $min_keep"
  [ -d "$dir" ] || { echo 0; return 0; }

  local now cutoff_epoch mtime f count=0 removed=0
  now=$(date +%s)
  # Refuse time-based pruning if RTC/NTP clock appears unsynced (before 2023-11-14 UTC).
  if [ "$now" -lt 1700000000 ]; then
    echo 0
    return 0
  fi
  cutoff_epoch=$((now - max_age_hours * 3600))

  while IFS=$'\t' read -r mtime f; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    count=$((count + 1))
    if [ "$count" -le "$min_keep" ]; then
      continue
    fi
    mtime="${mtime%%.*}"
    [[ "$mtime" =~ ^[0-9]+$ ]] || continue
    if [ "$mtime" -lt "$cutoff_epoch" ]; then
      rm -f -- "$f" "${f}.sha256"
      removed=$((removed + 1))
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name "$pattern" ! -name '*-latest.*' -printf '%Ts\t%p\n' 2>/dev/null | sort -t$'\t' -k1,1nr)

  # Remove orphaned *.gpg.sha256 checksums matching pattern whose .gpg file is gone.
  local sha target
  while IFS= read -r sha; do
    [ -n "$sha" ] && [ -f "$sha" ] || continue
    target="${sha%.sha256}"
    if [ ! -e "$target" ]; then
      rm -f -- "$sha"
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name "${pattern}.sha256" ! -name '*-latest.*' 2>/dev/null)

  echo "$removed"
}
