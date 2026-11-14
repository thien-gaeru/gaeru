<#
.SYNOPSIS
  Syncs committed GAERU code from the official Git repository (origin/gaeru) to Xiaomi Mi 6
  and triggers a safe cluster reload while preserving Mi 6 runtime configs, media, and secrets.
#>
param(
  [string]$Mi6Host = "root@192.168.31.59",
  [string]$Branch = "gaeru",
  [switch]$FullRestart,
  [switch]$SkipReload
)

$ErrorActionPreference = "Stop"

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevPref
  }
  if ($code -ne 0) {
    throw "Command failed with exit code ${code}: $FilePath $($Arguments -join ' ')"
  }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$dirty = (& git -C $RepoRoot status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "Failed to check git status in $RepoRoot" }
if ($dirty) {
  throw "Working tree is not clean. Commit or stash changes before running deploy:mi6:`n$($dirty -join "`n")"
}

$headSha = ((& git -C $RepoRoot rev-parse HEAD) | Select-Object -First 1).Trim()
if ($LASTEXITCODE -ne 0 -or $headSha -notmatch '^[0-9a-f]{40}$') {
  throw "Unable to resolve valid 40-char HEAD SHA in $RepoRoot"
}

Write-Host "[deploy:mi6] Pushing $headSha -> origin/$Branch ..."
Invoke-Native git @("-C", $RepoRoot, "push", "origin", "HEAD:$Branch")

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$tmpDir = Join-Path $env:TEMP ("gaeru-mi6-deploy-" + $stamp + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

$codeTarName = "gaeru-code-$stamp.tar.gz"
$gitTarName = "gaeru-git-$stamp.tar.gz"
$codeTar = Join-Path $tmpDir $codeTarName
$gitTar = Join-Path $tmpDir $gitTarName

try {
  Write-Host "[deploy:mi6] Packaging tracked files (git archive HEAD) and .git metadata ..."
  Invoke-Native git @("-C", $RepoRoot, "archive", "--format=tar.gz", "-o", $codeTar, "HEAD")
  Invoke-Native tar.exe @("-C", $RepoRoot, "--exclude=.git/index", "-czf", $gitTar, ".git")

  if (-not (Test-Path $codeTar) -or -not (Test-Path $gitTar)) {
    throw "Failed to create deployment archives."
  }

  Write-Host "[deploy:mi6] Uploading archives to $Mi6Host ..."
  Invoke-Native scp @("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", $codeTar, $gitTar, "${Mi6Host}:/tmp/")

  $reloadMode = if ($SkipReload) { "skip" } elseif ($FullRestart) { "restart" } else { "hup" }

  $remoteTemplate = @'
set -euo pipefail
APP_DIR="/storage/apps/gaeru"
CODE_TAR="/tmp/__CODE_TAR__"
GIT_TAR="/tmp/__GIT_TAR__"
EXPECTED_SHA="__EXPECTED_SHA__"
RELOAD_MODE="__RELOAD_MODE__"
OLD_LIST="/tmp/.gaeru-old-files.$$"
NEW_LIST="/tmp/.gaeru-new-files.$$"

cleanup() {
  rm -f -- "$CODE_TAR" "$GIT_TAR" "$OLD_LIST" "$NEW_LIST"
}
trap cleanup EXIT INT TERM

[ -d "$APP_DIR" ] || { echo "ERROR: Missing $APP_DIR" >&2; exit 1; }

OLD_NODE_CONF_SHA=$(sha256sum /etc/init/node-app.conf 2>/dev/null | awk '{print $1}' || true)
OLD_MASTER_SHA=$(sha256sum "$APP_DIR/src/cluster-master.js" 2>/dev/null | awk '{print $1}' || true)
OLD_CLUSTER_SHA=$(sha256sum "$APP_DIR/src/cluster.js" 2>/dev/null | awk '{print $1}' || true)

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" ls-files | sort > "$OLD_LIST"
else
  : > "$OLD_LIST"
fi

tar --warning=no-unknown-keyword --no-same-owner -xzf "$CODE_TAR" -C "$APP_DIR"
rm -rf "$APP_DIR/.git"
tar --warning=no-unknown-keyword --no-same-owner -xzf "$GIT_TAR" -C "$APP_DIR"

git -C "$APP_DIR" config core.filemode false
git -C "$APP_DIR" config core.autocrlf false
git -C "$APP_DIR" config core.ignorecase false
git -C "$APP_DIR" checkout -f HEAD >/dev/null
git -C "$APP_DIR" reset --mixed HEAD >/dev/null

git -C "$APP_DIR" ls-files | sort > "$NEW_LIST"
comm -23 "$OLD_LIST" "$NEW_LIST" | while IFS= read -r obsolete; do
  [ -n "$obsolete" ] || continue
  rm -f -- "$APP_DIR/$obsolete"
done

for legacy in scripts/mi6-connect.js scripts/mi6-setup-tunnel.js; do
  if [ -e "$APP_DIR/$legacy" ] && ! git -C "$APP_DIR" ls-files --error-unmatch "$legacy" >/dev/null 2>&1; then
    rm -f -- "$APP_DIR/$legacy"
  fi
done

chown -R www-data:www-data "$APP_DIR/.git"
git -C "$APP_DIR" ls-files -z | (cd "$APP_DIR" && xargs -0 chown www-data:www-data)
chown www-data:www-data "$APP_DIR"
for envf in "$APP_DIR/.env" "$APP_DIR/app.env"; do
  if [ -e "$envf" ]; then
    chown www-data:www-data "$envf"
    chmod 0640 "$envf"
  fi
done

find "$APP_DIR/scripts" -type f \( -name '*.sh' -o -name '*.conf' \) | while IFS= read -r f; do
  tr -d '\r' < "$f" > "${f}.lf.$$"
  if ! cmp -s "$f" "${f}.lf.$$"; then
    chown www-data:www-data "${f}.lf.$$"
    mv -f "${f}.lf.$$" "$f"
  else
    rm -f "${f}.lf.$$"
  fi
  case "$f" in
    *.sh) chmod 0755 "$f" ;;
    *.conf) chmod 0644 "$f" ;;
  esac
done

for s in "$APP_DIR"/scripts/mi6-backup/gaeru-*.sh; do
  [ -f "$s" ] || continue
  base=$(basename "$s")
  tr -d '\r' < "$s" > "/usr/local/sbin/$base"
  chown root:root "/usr/local/sbin/$base"
  chmod 0700 "/usr/local/sbin/$base"
  bash -n "/usr/local/sbin/$base"
done

tr -d '\r' < "$APP_DIR/scripts/node-app.conf" > /etc/init/node-app.conf
chown root:root /etc/init/node-app.conf
chmod 0644 /etc/init/node-app.conf

ACTUAL_SHA=$(git -C "$APP_DIR" rev-parse HEAD)
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "ERROR: Mi 6 HEAD ($ACTUAL_SHA) != expected ($EXPECTED_SHA)" >&2
  exit 1
fi
echo "GIT_HEAD_VERIFIED=$ACTUAL_SHA"

DIRTY_OUT=$(git -C "$APP_DIR" status --porcelain)
if [ -n "$DIRTY_OUT" ]; then
  echo "ERROR: Unclean git status on Mi 6:" >&2
  printf '%s\n' "$DIRTY_OUT" >&2
  exit 1
fi
echo "GIT_STATUS_CLEAN=true"

NEW_NODE_CONF_SHA=$(sha256sum /etc/init/node-app.conf 2>/dev/null | awk '{print $1}' || true)
NEW_MASTER_SHA=$(sha256sum "$APP_DIR/src/cluster-master.js" 2>/dev/null | awk '{print $1}' || true)
NEW_CLUSTER_SHA=$(sha256sum "$APP_DIR/src/cluster.js" 2>/dev/null | awk '{print $1}' || true)

if [ "$RELOAD_MODE" != "skip" ]; then
  MASTER_PID=$(pgrep -f 'node src/cluster\.js' | head -n 1 || true)
  if [ "$RELOAD_MODE" = "restart" ] || [ -z "$MASTER_PID" ] || \
     [ "$OLD_NODE_CONF_SHA" != "$NEW_NODE_CONF_SHA" ] || \
     [ "$OLD_MASTER_SHA" != "$NEW_MASTER_SHA" ] || \
     [ "$OLD_CLUSTER_SHA" != "$NEW_CLUSTER_SHA" ]; then
    echo "Restarting node-app (gaeru)..."
    initctl stop node-app APP=gaeru 2>/dev/null || true
    if [ -n "$MASTER_PID" ]; then
      w=0
      while [ "$w" -lt 12 ] && kill -0 "$MASTER_PID" 2>/dev/null; do
        sleep 0.5
        w=$((w + 1))
      done
    else
      sleep 2
    fi
    pkill -f '/storage/apps/gaeru/src/' 2>/dev/null || true
    sleep 1
    initctl start node-app APP=gaeru 2>/dev/null || true
    initctl status node-app APP=gaeru | grep -q 'start/running'
  else
    echo "Triggering zero-downtime rolling reload (SIGHUP -> PID $MASTER_PID)..."
    kill -HUP "$MASTER_PID"
    sleep 5
  fi

  HEALTH_OK=0
  for attempt in $(seq 1 20); do
    BODY=$(curl -fsS --max-time 3 http://127.0.0.1:3000/health 2>/dev/null || true)
    if printf '%s' "$BODY" | grep -q '"status":"ok"'; then
      echo "HEALTH_OK=$BODY (attempt $attempt)"
      HEALTH_OK=1
      break
    fi
    sleep 2
  done
  if [ "$HEALTH_OK" -ne 1 ]; then
    echo "ERROR: http://127.0.0.1:3000/health failed after reload" >&2
    exit 1
  fi
fi
'@

  $remoteScript = $remoteTemplate.
    Replace("__CODE_TAR__", $codeTarName).
    Replace("__GIT_TAR__", $gitTarName).
    Replace("__EXPECTED_SHA__", $headSha).
    Replace("__RELOAD_MODE__", $reloadMode)

  Write-Host "[deploy:mi6] Applying synced release on $Mi6Host ..."
  $prevPref = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $remoteScript | & ssh -o BatchMode=yes -o ConnectTimeout=10 $Mi6Host "tr -d '\r' | bash -s"
    $sshCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevPref
  }
  if ($sshCode -ne 0) {
    throw "Remote deployment script failed with exit code $sshCode"
  }
  Write-Host "[deploy:mi6] Completed cleanly at $headSha."
} finally {
  if (Test-Path $tmpDir) {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
