[CmdletBinding()]
param(
    [switch]$SkipMi6Check,
    [switch]$RegisterPullTask = $true
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "Script nay phai duoc chay trong PowerShell voi quyen Administrator (Run as Administrator) de tat Scheduled Tasks he thong."
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogsDir = Join-Path $RepoRoot "logs"
$Mi6Host = "root@192.168.31.59"

Write-Output "=== [1/6] Kiem tra Cloudflare Tunnel tren Xiaomi Mi 6 ==="
if (-not $SkipMi6Check) {
    $readyRaw = & ssh -o BatchMode=yes -o ConnectTimeout=8 $Mi6Host "curl -sS http://127.0.0.1:20241/ready"
    if ($LASTEXITCODE -ne 0 -or -not $readyRaw) {
        throw "Khong kiem tra duoc Mi 6 cloudflared /ready qua SSH. Hay dam bao Mi 6 dang online truoc khi ngat PC."
    }
    $readyObj = $readyRaw | ConvertFrom-Json
    if ([int]$readyObj.readyConnections -lt 1) {
        throw "Mi 6 cloudflared chua co ket noi edge nao (readyConnections=$($readyObj.readyConnections)). Dung cutover de tranh gian doan."
    }
    Write-Output "Mi 6 cloudflared san sang: readyConnections=$($readyObj.readyConnections), connectorId=$($readyObj.connectorId)"
}

Write-Output "=== [2/6] Vo hieu hoa cac Scheduled Tasks cu tren PC ==="
foreach ($taskName in @("GAERU_Server_AutoStart", "GAERU_Database_AutoBackup_15m", "GAERU_Database_AutoBackup_E")) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        Write-Output "Disabled task: $taskName"
    }
}

if ($RegisterPullTask) {
    $pullScript = Join-Path $PSScriptRoot "pull-mi6-backups.ps1"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$pullScript`""
    $trigger = New-ScheduledTaskTrigger -Daily -At 04:15
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "GAERU_Mi6_Offsite_Backup_Pull" -Action $action -Trigger $trigger -Settings $settings -Description "Daily pull of verified PostgreSQL, media/config, and mail backups from Xiaomi Mi 6 to E:\GAERU_Backups\mi6" -Force | Out-Null
    Write-Output "Registered/updated task: GAERU_Mi6_Offsite_Backup_Pull (daily 04:15)"
}

Write-Output "=== [3/6] Dung supervisor va PC cloudflared de chuyen 100% traffic sang Mi 6 ==="
$envPath = Join-Path $RepoRoot ".env"
if (Test-Path -LiteralPath $envPath) {
    $envRaw = Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
    if ($envRaw -match '(?m)^ALLOW_PC_SUPERVISOR=') {
        $envRaw = $envRaw -replace '(?m)^ALLOW_PC_SUPERVISOR=.*', 'ALLOW_PC_SUPERVISOR=false'
        [System.IO.File]::WriteAllText($envPath, $envRaw, [System.Text.UTF8Encoding]::new($false))
    }
}
foreach ($pidFile in @("supervisor.pid", "cloudflared.pid")) {
    $p = Join-Path $LogsDir $pidFile
    if (Test-Path -LiteralPath $p) {
        $pidVal = (Get-Content -LiteralPath $p -Raw).Trim()
        if ($pidVal -match '^\d+$') {
            Stop-Process -Id ([int]$pidVal) -Force -ErrorAction SilentlyContinue
            Write-Output "Stopped $pidFile ($pidVal)"
        }
    }
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like "*watchdog-supervisor.js*" -and $_.CommandLine -like "*gaeru*"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped watchdog-supervisor PID=$($_.ProcessId)"
}

Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { -not $_.CommandLine -or $_.CommandLine -like "*gaeru*" -or $_.CommandLine -like "*tunnel*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped cloudflared.exe PID=$($_.ProcessId)"
}

Write-Output "Cho 6 giay de realtime-cluster-sync xa not hang doi ve Mi 6..."
Start-Sleep -Seconds 6

Write-Output "=== [4/6] Doi soat & hop nhat site_traffic tu PC sang Mi 6 ==="
$reconcileScript = Join-Path $PSScriptRoot "reconcile-pc-traffic-to-mi6.js"
if (Test-Path -LiteralPath $reconcileScript) {
    Push-Location $RepoRoot
    try {
        & node $reconcileScript --apply
    } finally {
        Pop-Location
    }
}

Write-Output "=== [5/6] Dung han Node server, worker va cluster-sync tren PC ==="
$stopSignal = Join-Path $LogsDir "stop.signal"
Set-Content -LiteralPath $stopSignal -Value "cutover $(Get-Date -Format o)" -Encoding UTF8
Start-Sleep -Seconds 3

foreach ($pidFile in @("cluster.pid", "server.pid", "cluster-sync.pid")) {
    $p = Join-Path $LogsDir $pidFile
    if (Test-Path -LiteralPath $p) {
        $pidVal = (Get-Content -LiteralPath $p -Raw).Trim()
        if ($pidVal -match '^\d+$') {
            Stop-Process -Id ([int]$pidVal) -Force -ErrorAction SilentlyContinue
        }
    }
}

Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like "*C:\Users\imdot\gaeru*" -and (
        $_.CommandLine -like "*cluster-master.js*" -or
        $_.CommandLine -like "*server.js*" -or
        $_.CommandLine -like "*realtime-cluster-sync.js*" -or
        $_.CommandLine -like "*watchdog-supervisor.js*"
    )
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped GAERU node PID=$($_.ProcessId)"
}

foreach ($f in @("supervisor.pid", "cloudflared.pid", "cluster.pid", "server.pid", "cluster-sync.pid", "stop.signal", "reload.signal")) {
    $fp = Join-Path $LogsDir $f
    if (Test-Path -LiteralPath $fp) {
        Remove-Item -LiteralPath $fp -Force -ErrorAction SilentlyContinue
    }
}

Write-Output "=== [6/6] Xac minh sau cutover ==="
Get-ScheduledTask -TaskName "GAERU*" | Select-Object TaskName, State | Format-Table -AutoSize
$pcListen3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
Write-Output ("PC port 3000 listening: " + [bool]$pcListen3000)

foreach ($url in @("https://gaeru.com/api/health", "https://mail.gaeru.com/")) {
    try {
        $resp = Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing
        Write-Output "PUBLIC $url -> $($resp.StatusCode)"
    } catch {
        Write-Warning "PUBLIC $url FAILED: $($_.Exception.Message)"
    }
}
