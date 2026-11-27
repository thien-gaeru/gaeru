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
DEPLOY_LOCK="/run/gaeru-deploy.lock"

LOCK_OWNED=0
cleanup() {
  rm -f -- "$CODE_TAR" "$GIT_TAR" "$OLD_LIST" "$NEW_LIST"
  rm -rf -- "/storage/apps/.gaeru-npm-stage.$$" "$APP_DIR/.node_modules_old.$$" 2>/dev/null || true
  if [ "$LOCK_OWNED" -eq 1 ]; then
    rm -f -- "$DEPLOY_LOCK"
  fi
}
trap cleanup EXIT INT TERM
exec 9>"$DEPLOY_LOCK"
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || { echo "ERROR: Another deploy or restore is holding $DEPLOY_LOCK" >&2; exit 1; }
fi
LOCK_OWNED=1
printf '%s\n' "$$" >&9

[ -d "$APP_DIR" ] || { echo "ERROR: Missing $APP_DIR" >&2; exit 1; }

OLD_NODE_CONF_SHA=$(sha256sum /etc/init/node-app.conf 2>/dev/null | awk '{print $1}' || true)
OLD_MASTER_SHA=$(sha256sum "$APP_DIR/src/cluster-master.js" 2>/dev/null | awk '{print $1}' || true)
OLD_CLUSTER_SHA=$(sha256sum "$APP_DIR/src/cluster.js" 2>/dev/null | awk '{print $1}' || true)
OLD_LOCK_SHA=$(sha256sum "$APP_DIR/package-lock.json" 2>/dev/null | awk '{print $1}' || true)
OLD_GPU_CPP_SHA=$(sha256sum /storage/gpu-ai-build/gaeru-gpu-ai.cpp 2>/dev/null | awk '{print $1}' || true)
OLD_GPU_ICD_SHA=$(sha256sum /storage/gpu-ai-build/hybris_opencl_icd.c 2>/dev/null | awk '{print $1}' || true)

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" ls-files | sort > "$OLD_LIST"
else
  : > "$OLD_LIST"
fi

tar --warning=no-unknown-keyword --no-same-owner -xzf "$CODE_TAR" -C "$APP_DIR"
rm -rf "$APP_DIR/.git"
tar --warning=no-unknown-keyword --no-same-owner -xzf "$GIT_TAR" -C "$APP_DIR"

git -C "$APP_DIR" config --replace-all core.filemode false
git -C "$APP_DIR" config --replace-all core.autocrlf false
git -C "$APP_DIR" config --replace-all core.ignorecase false
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
if [ -e "$APP_DIR/.env" ]; then
  chown www-data:www-data "$APP_DIR/.env"
  chmod 0640 "$APP_DIR/.env"
fi
if [ -f "$APP_DIR/app.env" ] && [ ! -L "$APP_DIR/app.env" ]; then
  chown root:www-data "$APP_DIR/app.env"
  chmod 0640 "$APP_DIR/app.env"
fi

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

if [ -f "$APP_DIR/scripts/network_watchdog.sh" ]; then
  OLD_WATCHDOG_SHA=$(sha256sum /usr/local/bin/network_watchdog.sh 2>/dev/null | awk '{print $1}' || true)
  tr -d '\r' < "$APP_DIR/scripts/network_watchdog.sh" > /usr/local/bin/network_watchdog.sh
  chown root:root /usr/local/bin/network_watchdog.sh
  chmod 0755 /usr/local/bin/network_watchdog.sh
  bash -n /usr/local/bin/network_watchdog.sh
  NEW_WATCHDOG_SHA=$(sha256sum /usr/local/bin/network_watchdog.sh 2>/dev/null | awk '{print $1}' || true)
  if [ "$OLD_WATCHDOG_SHA" != "$NEW_WATCHDOG_SHA" ]; then
    initctl restart network-watchdog 2>/dev/null || (initctl stop network-watchdog 2>/dev/null || true; initctl start network-watchdog 2>/dev/null || true)
  fi
fi

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
NEW_LOCK_SHA=$(sha256sum "$APP_DIR/package-lock.json" 2>/dev/null | awk '{print $1}' || true)

# #06: Keep production node_modules strictly synchronized with package-lock.json on ARM64 Mi 6
LOCK_STAMP="$APP_DIR/node_modules/.gaeru-lock-sha256"
NEED_NPM_CI=0
if [ ! -d "$APP_DIR/node_modules/express" ] || [ "$OLD_LOCK_SHA" != "$NEW_LOCK_SHA" ]; then
  NEED_NPM_CI=1
elif [ -f "$LOCK_STAMP" ] && [ "$(cat "$LOCK_STAMP" 2>/dev/null || true)" != "$NEW_LOCK_SHA" ]; then
  NEED_NPM_CI=1
fi
if [ "$NEED_NPM_CI" -eq 1 ]; then
  echo "Staging production node_modules (npm ci --omit=dev) in sibling directory for lock SHA $NEW_LOCK_SHA..."
  /usr/local/sbin/ubuntu-mount.sh 2>/dev/null || true
  NPM_STAGE="/storage/apps/.gaeru-npm-stage.$$"
  OLD_NM="$APP_DIR/.node_modules_old.$$"
  rm -rf "$NPM_STAGE" "$OLD_NM"
  mkdir -p "$NPM_STAGE"
  cp -f "$APP_DIR/package.json" "$APP_DIR/package-lock.json" "$NPM_STAGE/"
  chown -R www-data:www-data "$NPM_STAGE"
  env -u LD_PRELOAD chroot /storage/ubuntu runuser -u www-data -- /usr/bin/env -u LANGUAGE HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin \
    bash -euo pipefail -c "cd '$NPM_STAGE' && npm ci --omit=dev --no-audit --no-fund && node -e \"require('express'); require('pg');\""
  printf '%s\n' "$NEW_LOCK_SHA" > "$NPM_STAGE/node_modules/.gaeru-lock-sha256"
  chown www-data:www-data "$NPM_STAGE/node_modules/.gaeru-lock-sha256" 2>/dev/null || true
  if [ -d "$APP_DIR/node_modules" ]; then
    mv "$APP_DIR/node_modules" "$OLD_NM"
  fi
  mv "$NPM_STAGE/node_modules" "$APP_DIR/node_modules"
  rm -rf "$OLD_NM" "$NPM_STAGE"
fi
if [ -d "$APP_DIR/node_modules" ] && [ -n "$NEW_LOCK_SHA" ]; then
  printf '%s\n' "$NEW_LOCK_SHA" > "$LOCK_STAMP"
  chown www-data:www-data "$LOCK_STAMP" 2>/dev/null || true
fi

RELOAD_STATUS_FILE="$APP_DIR/logs/cluster-reload-status.json"

run_mi6_node() {
  if command -v node >/dev/null 2>&1; then
    node "$@"
  else
    env -u LD_PRELOAD chroot /storage/ubuntu /usr/local/bin/node "$@"
  fi
}

verify_workers_on_release() {
  local expected="$1"
  local min_seq="${2:-0}"
  local require_succeeded="${3:-0}"
  run_mi6_node -e '
    const fs = require("fs");
    const [statusPath, expectedSha, minSeqStr, reqSuccStr] = process.argv.slice(1);
    const minSeq = Number(minSeqStr) || 0;
    const reqSucc = reqSuccStr === "1";
    if (!fs.existsSync(statusPath)) process.exit(2);
    const data = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (reqSucc) {
      if ((Number(data.reloadSeq) || 0) <= minSeq) process.exit(3);
      if (data.status === "reloading") process.exit(3);
      if (data.status !== "succeeded") {
        console.error("RELOAD_FAILED_STATUS=" + data.status + " failedSlots=" + JSON.stringify(data.failedSlots || []));
        process.exit(4);
      }
    }
    const workers = Array.isArray(data.workers) ? data.workers : [];
    const expectedCount = Number(data.numWorkers) || 0;
    if (!expectedCount || workers.length < expectedCount) process.exit(3);
    const stale = workers.filter(w => !w.alive || !w.ready || w.releaseSha !== expectedSha || !w.pid);
    if (stale.length > 0) {
      if (reqSucc) console.error("STALE_WORKERS=" + JSON.stringify(stale));
      process.exit(reqSucc ? 5 : 3);
    }
    for (const w of workers) {
      try { process.kill(w.pid, 0); } catch (_) { process.exit(reqSucc ? 5 : 3); }
    }
    console.log("CLUSTER_RELEASE_VERIFIED=" + expectedSha + " workers=" + workers.length + " status=" + data.status);
  ' "$RELOAD_STATUS_FILE" "$expected" "$min_seq" "$require_succeeded"
}

if [ "$RELOAD_MODE" != "skip" ]; then
  MASTER_PID=$(pgrep -f 'node src/cluster(-master)?\.js' | head -n 1 || true)
  if [ "$RELOAD_MODE" = "restart" ] || [ -z "$MASTER_PID" ] || \
     [ "$OLD_NODE_CONF_SHA" != "$NEW_NODE_CONF_SHA" ] || \
     [ "$OLD_MASTER_SHA" != "$NEW_MASTER_SHA" ] || \
     [ "$OLD_CLUSTER_SHA" != "$NEW_CLUSTER_SHA" ]; then
    echo "Restarting node-app (gaeru)..."
    rm -f "$RELOAD_STATUS_FILE"
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
    VERIFIED=0
    for attempt in $(seq 1 30); do
      if verify_workers_on_release "$EXPECTED_SHA" 0 0; then
        VERIFIED=1
        break
      fi
      sleep 2
    done
    if [ "$VERIFIED" -ne 1 ]; then
      echo "ERROR: Not all restarted workers reported ready on $EXPECTED_SHA" >&2
      [ -f "$RELOAD_STATUS_FILE" ] && cat "$RELOAD_STATUS_FILE" >&2
      exit 1
    fi
  else
    # #07: Track reload sequence and fail deploy if rolling reload rolls back or leaves any stale worker
    PREV_SEQ=$(run_mi6_node -e 'const fs=require("fs"); try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(Number(d.reloadSeq)||0);}catch(_){console.log(0);}' "$RELOAD_STATUS_FILE")
    echo "Triggering zero-downtime rolling reload (SIGHUP -> PID $MASTER_PID, prevSeq=$PREV_SEQ)..."
    kill -HUP "$MASTER_PID"
    VERIFIED=0
    for attempt in $(seq 1 75); do
      set +e
      verify_workers_on_release "$EXPECTED_SHA" "$PREV_SEQ" 1
      rc=$?
      set -e
      if [ "$rc" -eq 0 ]; then
        VERIFIED=1
        break
      elif [ "$rc" -eq 4 ] || [ "$rc" -eq 5 ]; then
        echo "ERROR: Rolling reload did not cleanly upgrade all workers to $EXPECTED_SHA (rc=$rc)" >&2
        [ -f "$RELOAD_STATUS_FILE" ] && cat "$RELOAD_STATUS_FILE" >&2
        exit 1
      fi
      sleep 2
    done
    if [ "$VERIFIED" -ne 1 ]; then
      echo "ERROR: Timed out waiting for all workers to finish rolling reload onto $EXPECTED_SHA" >&2
      [ -f "$RELOAD_STATUS_FILE" ] && cat "$RELOAD_STATUS_FILE" >&2
      exit 1
    fi
  fi

  HEALTH_OK=0
  for attempt in $(seq 1 20); do
    BODY=$(curl -fsS --max-time 3 http://127.0.0.1:3000/health 2>/dev/null || true)
    if [ -n "$BODY" ] && printf '%s' "$BODY" | run_mi6_node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(d && d.status === "ok" ? 0 : 1);' 2>/dev/null; then
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

sync_host_file() {
  local src="$1" dst="$2" mode="$3" svc="${4:-}"
  [ -f "$src" ] || return 0
  local old_sha new_sha
  old_sha=$(sha256sum "$dst" 2>/dev/null | awk '{print $1}' || true)
  case "$src" in
    *.png|*.ico|*.webp|*.avif|*.jpg|*.jpeg|*.gif|*.woff2)
      cp -f "$src" "${dst}.tmp.$$"
      ;;
    *)
      tr -d '\r' < "$src" > "${dst}.tmp.$$"
      ;;
  esac
  chown root:root "${dst}.tmp.$$"
  chmod "$mode" "${dst}.tmp.$$"
  mv -f "${dst}.tmp.$$" "$dst"
  new_sha=$(sha256sum "$dst" 2>/dev/null | awk '{print $1}' || true)
  if [ -n "$svc" ] && [ "$old_sha" != "$new_sha" ]; then
    initctl restart "$svc" 2>/dev/null || true
  fi
}

sync_host_file "$APP_DIR/infra/mi6/sbin/gaeru-healthcheck.sh" /usr/local/sbin/gaeru-healthcheck.sh 0755 gaeru-health
sync_host_file "$APP_DIR/infra/mi6/sbin/gaeru-screen.py" /usr/local/sbin/gaeru-screen.py 0755 gaeru-screen
sync_host_file "$APP_DIR/infra/mi6/bin/hw_tune.sh" /usr/local/bin/hw_tune.sh 0755 ""
sync_host_file "$APP_DIR/infra/mi6/bin/battery_limiter.py" /usr/local/bin/battery_limiter.py 0755 battery-limiter
sync_host_file "$APP_DIR/scripts/pty_helper.py" /userdata/storage/admin/pty_helper.py 0700 ""
for asset in index.html logo.png favicon.ico favicon-16x16.png favicon-32x32.png apple-touch-icon.png icon-192.png icon-512.png manifest.webmanifest; do
  sync_host_file "$APP_DIR/infra/mi6/admin/public/$asset" "/userdata/storage/admin/public/$asset" 0644 ""
done
sync_host_file "$APP_DIR/infra/mi6/admin/server.js" /userdata/storage/admin/server.js 0600 server-dashboard
sync_host_file "$APP_DIR/infra/mi6/gpu-ai/gaeru-gpu-ai.cpp" /storage/gpu-ai-build/gaeru-gpu-ai.cpp 0644 ""
sync_host_file "$APP_DIR/infra/mi6/gpu-ai/hybris_opencl_icd.c" /storage/gpu-ai-build/hybris_opencl_icd.c 0644 ""

# #17: Rebuild, install, and restart GPU AI binaries automatically whenever C/C++ sources change or diverge from built stamps
NEW_GPU_CPP_SHA=$(sha256sum /storage/gpu-ai-build/gaeru-gpu-ai.cpp 2>/dev/null | awk '{print $1}' || true)
NEW_GPU_ICD_SHA=$(sha256sum /storage/gpu-ai-build/hybris_opencl_icd.c 2>/dev/null | awk '{print $1}' || true)
GPU_ICD_STAMP="/storage/gpu-ai-build/.built-icd.sha256"
GPU_CPP_STAMP="/storage/gpu-ai-build/.built-gpu-ai.sha256"
GPU_ICD_BIN="/storage/ubuntu/usr/local/lib/libHybrisOpenCL.so"
GPU_AI_BIN="/storage/ubuntu/usr/local/bin/gaeru-gpu-ai"
REBUILD_ICD=0
REBUILD_GPU_CPP=0

if [ -n "$NEW_GPU_ICD_SHA" ] && [ -f /storage/gpu-ai-build/hybris_opencl_icd.c ]; then
  if [ ! -f "$GPU_ICD_BIN" ] || [ "$OLD_GPU_ICD_SHA" != "$NEW_GPU_ICD_SHA" ]; then
    REBUILD_ICD=1
  elif [ -f "$GPU_ICD_STAMP" ] && [ "$(cat "$GPU_ICD_STAMP" 2>/dev/null || true)" != "$NEW_GPU_ICD_SHA" ]; then
    REBUILD_ICD=1
  elif [ ! -f "$GPU_ICD_STAMP" ] && [ -f "$GPU_ICD_BIN" ]; then
    printf '%s\n' "$NEW_GPU_ICD_SHA" > "$GPU_ICD_STAMP"
  fi
fi

if [ -n "$NEW_GPU_CPP_SHA" ] && [ -f /storage/gpu-ai-build/gaeru-gpu-ai.cpp ]; then
  if [ ! -x "$GPU_AI_BIN" ] || [ "$OLD_GPU_CPP_SHA" != "$NEW_GPU_CPP_SHA" ]; then
    REBUILD_GPU_CPP=1
  elif [ -f "$GPU_CPP_STAMP" ] && [ "$(cat "$GPU_CPP_STAMP" 2>/dev/null || true)" != "$NEW_GPU_CPP_SHA" ]; then
    REBUILD_GPU_CPP=1
  elif [ ! -f "$GPU_CPP_STAMP" ] && [ -x "$GPU_AI_BIN" ]; then
    printf '%s\n' "$NEW_GPU_CPP_SHA" > "$GPU_CPP_STAMP"
  fi
fi

if [ "$REBUILD_ICD" -eq 1 ] || [ "$REBUILD_GPU_CPP" -eq 1 ]; then
  /usr/local/sbin/ubuntu-mount.sh 2>/dev/null || true
  if [ "$REBUILD_ICD" -eq 1 ]; then
    echo "Rebuilding libHybrisOpenCL.so for source SHA $NEW_GPU_ICD_SHA..."
    chroot /storage/ubuntu bash -euo pipefail -c '
      gcc -O2 -fPIC -shared -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
        -o /storage/gpu-ai-build/libHybrisOpenCL.so.new \
        /storage/gpu-ai-build/hybris_opencl_icd.c \
        /usr/lib/aarch64-linux-gnu/libhybris-common.so.1 -lpthread -ldl -lm
      chmod 0755 /storage/gpu-ai-build/libHybrisOpenCL.so.new
      mv -f /storage/gpu-ai-build/libHybrisOpenCL.so.new /usr/local/lib/libHybrisOpenCL.so
    '
    printf '%s\n' "$NEW_GPU_ICD_SHA" > "$GPU_ICD_STAMP"
  fi
  if [ "$REBUILD_GPU_CPP" -eq 1 ]; then
    echo "Rebuilding gaeru-gpu-ai for source SHA $NEW_GPU_CPP_SHA..."
    chroot /storage/ubuntu bash -euo pipefail -c '
      g++ -O2 -std=c++17 -Wall -Wextra -Wno-unused-parameter -pthread \
        -I/storage/gpu-ai-build/MNN/include \
        -I/storage/gpu-ai-build/llama.cpp/vendor/cpp-httplib \
        -I/storage/gpu-ai-build/llama.cpp/vendor/nlohmann \
        /storage/gpu-ai-build/gaeru-gpu-ai.cpp \
        /storage/gpu-ai-build/httplib.o \
        -o /storage/gpu-ai-build/gaeru-gpu-ai.new \
        -L/usr/local/lib -Wl,-rpath,/usr/local/lib -lMNN -lOpenCL -lpthread
      chmod 0755 /storage/gpu-ai-build/gaeru-gpu-ai.new
      mv -f /storage/gpu-ai-build/gaeru-gpu-ai.new /usr/local/bin/gaeru-gpu-ai
    '
    printf '%s\n' "$NEW_GPU_CPP_SHA" > "$GPU_CPP_STAMP"
  fi
  echo "Restarting gaeru-gpu-ai to activate rebuilt GPU binaries..."
  initctl restart gaeru-gpu-ai 2>/dev/null || (initctl stop gaeru-gpu-ai 2>/dev/null || true; initctl start gaeru-gpu-ai)
  GPU_OK=0
  for attempt in $(seq 1 20); do
    GPU_BODY=$(curl -fsS --max-time 3 http://127.0.0.1:3100/health 2>/dev/null || true)
    if [ -n "$GPU_BODY" ] && printf '%s' "$GPU_BODY" | run_mi6_node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(d && (d.ok === true || d.status === "ok") ? 0 : 1);' 2>/dev/null; then
      echo "GPU_AI_REBUILT_AND_HEALTHY=true (attempt $attempt)"
      GPU_OK=1
      break
    fi
    sleep 2
  done
  if [ "$GPU_OK" -ne 1 ]; then
    echo "ERROR: gaeru-gpu-ai failed health check after C/C++ rebuild" >&2
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
  $prevOutEnc = $OutputEncoding
  $ErrorActionPreference = "Continue"
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  try {
    $remoteScript | & ssh -o BatchMode=yes -o ConnectTimeout=10 $Mi6Host "sed '1s/^\xEF\xBB\xBF//' | tr -d '\r' | bash -s"
    $sshCode = $LASTEXITCODE
  } finally {
    $OutputEncoding = $prevOutEnc
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
