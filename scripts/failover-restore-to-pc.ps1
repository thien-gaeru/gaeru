[CmdletBinding()]
param(
    [ValidateSet("Verify", "VerifyPortable", "TestDatabaseRestore", "PullFromGoogleDrive", "FailoverToPC")]
    [string]$Mode = "Verify",
    [string]$PortableFile = '',
    [string]$BackupRoot = "E:\GAERU_Backups\mi6"
)

$ErrorActionPreference = "Stop"
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = Split-Path -Parent $scriptRoot
. (Join-Path $scriptRoot 'database-backup.ps1')

function Assert-SafeTarArchive([string]$ArchivePath) {
    $entries = @(& tar.exe -tzf $ArchivePath)
    if ($LASTEXITCODE -ne 0) { throw "tar -tzf failed on $ArchivePath" }
    foreach ($entry in $entries) {
        $norm = [string]$entry
        if ($norm -match '(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[A-Za-z]:') {
            throw "Unsafe path entry detected in archive ${ArchivePath}: $norm"
        }
    }
    return ,$entries
}

$pgDir = Join-Path $BackupRoot "pg"
$mediaDir = Join-Path $BackupRoot "media"

function Find-PgTool([string]$ExeName) {
    $found = Get-ChildItem -LiteralPath "C:\Program Files\PostgreSQL" -Filter $ExeName -Recurse -ErrorAction SilentlyContinue |
        Sort-Object @{ Expression = { try { [version]$_.VersionInfo.FileVersion } catch { [version]"0.0" } }; Descending = $true }, FullName |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $found) { throw "$ExeName not found in C:\Program Files\PostgreSQL" }
    return $found
}

function Get-NewestBackupFile([string]$Dir, [string]$Filter) {
    $file = Get-ChildItem -LiteralPath $Dir -Filter $Filter -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '-latest\.' -and $_.Name -notmatch '\.sha256$' -and $_.Name -notmatch '-globals-' } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $file) { throw "No backup file matching $Filter found in $Dir" }
    return $file.FullName
}

function Assert-Sha256Companion([string]$FilePath) {
    $shaFile = "${FilePath}.sha256"
    if (-not (Test-Path -LiteralPath $shaFile)) {
        throw "Missing SHA256 file: $shaFile"
    }
    $rawSha = Get-Content -LiteralPath $shaFile -Raw
    $expected = if ($null -ne $rawSha) { (($rawSha.Trim() -split '\s+')[0]).ToLowerInvariant() } else { "" }
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        throw "Invalid or empty SHA256 companion file: $shaFile"
    }
    $actual = Get-GaeruBackupSha256 $FilePath
    if ($expected -ne $actual) {
        throw "SHA256 mismatch for $FilePath (expected $expected, got $actual)"
    }
    return $actual
}

if ($Mode -eq "PullFromGoogleDrive") {
    $rclone = (Get-Command rclone -ErrorAction SilentlyContinue).Source
    if (-not $rclone) {
        $rclone = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Filter "rclone.exe" -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $rclone) { throw "rclone.exe not found" }
    Write-Output "=== Pulling Latest Backups from Google Drive (gdrive:GAERU_Backups) -> $BackupRoot ==="
    foreach ($sub in @("pg", "media")) {
        & $rclone copy "gdrive:GAERU_Backups/$sub" (Join-Path $BackupRoot $sub) --transfers 2
        if ($LASTEXITCODE -ne 0) { throw "rclone copy failed for $sub" }
    }
    $Mode = "Verify"
}

if ($Mode -eq "VerifyPortable" -or ($Mode -eq "TestDatabaseRestore" -and $PortableFile)) {
    if (!$PortableFile -or !(Test-Path -LiteralPath $PortableFile -PathType Leaf)) { throw "Supply a portable encrypted SQL backup with -PortableFile." }
    $newestPgSql = (Get-Item -LiteralPath $PortableFile).FullName
    Assert-Sha256Companion -FilePath $newestPgSql | Out-Null
    if ($Mode -eq "VerifyPortable") {
        $gpg = (Get-Command gpg.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        & node.exe (Join-Path $scriptRoot 'portable-database-backup.cjs') verify $gpg $newestPgSql
        if ($LASTEXITCODE -ne 0) { throw "Could not verify the portable encrypted database backup." }
        Write-Output "Verified the ciphertext checksum, decryption, gzip stream and PostgreSQL completion footer."
        return
    }
} else {
    $newestPg = Get-NewestBackupFile -Dir $pgDir -Filter "gaeru_store-*.dump.gpg"
    $newestPgSql = Get-NewestBackupFile -Dir $pgDir -Filter "gaeru_store-*.sql.gz.gpg"
    $newestMedia = Get-NewestBackupFile -Dir $mediaDir -Filter "gaeru-media-config-*.tar.gz.gpg"
}

function Protect-TempPath([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return }
    $perm = if (Test-Path -LiteralPath $Path -PathType Container) { "(OI)(CI)(F)" } else { "(F)" }
    & icacls.exe $Path /inheritance:r /grant:r "$($env:USERNAME):$perm" "SYSTEM:$perm" "Administrators:$perm" | Out-Null
}

function Invoke-GpgDecryptToTemp([string]$SourcePath, [string]$Suffix = ".tmp") {
    $gpgExe = "C:\Program Files\GnuPG\bin\gpg.exe"
    if (-not (Test-Path -LiteralPath $gpgExe)) { throw "gpg.exe not found at $gpgExe" }
    $tmpPlain = Join-Path $env:TEMP ("gaeru_dec_" + [guid]::NewGuid().ToString("N") + $Suffix)
    New-Item -ItemType File -Path $tmpPlain -Force | Out-Null
    Protect-TempPath $tmpPlain
    & $gpgExe --batch --yes --decrypt --output $tmpPlain $SourcePath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmpPlain)) {
        Remove-Item -LiteralPath $tmpPlain -Force -ErrorAction SilentlyContinue
        throw "GPG decryption failed for $SourcePath"
    }
    Protect-TempPath $tmpPlain
    return $tmpPlain
}

function Expand-GzipToTempSql([string]$GzPath) {
    $decryptedGz = $null
    $gzInputPath = $GzPath
    if ($GzPath -match '\.gpg$') {
        $decryptedGz = Invoke-GpgDecryptToTemp -SourcePath $GzPath -Suffix ".sql.gz"
        $gzInputPath = $decryptedGz
    }
    $tmpSql = Join-Path $env:TEMP ("gaeru_restore_" + [guid]::NewGuid().ToString("N") + ".sql")
    New-Item -ItemType File -Path $tmpSql -Force | Out-Null
    Protect-TempPath $tmpSql
    try {
        $inStream = [System.IO.File]::OpenRead($gzInputPath)
        $outStream = [System.IO.File]::Create($tmpSql)
        try {
            $gz = New-Object System.IO.Compression.GZipStream($inStream, [System.IO.Compression.CompressionMode]::Decompress)
            $gz.CopyTo($outStream)
            $gz.Dispose()
        } finally {
            $outStream.Dispose()
            $inStream.Dispose()
        }
    } finally {
        if ($decryptedGz) { Remove-Item -LiteralPath $decryptedGz -Force -ErrorAction SilentlyContinue }
    }
    return $tmpSql
}

if ($Mode -eq "Verify") {
    Write-Output "=== [1/2] Verifying PostgreSQL Backups (.dump.gpg + portable .sql.gz.gpg) on PC ==="
    $pgHash = Assert-Sha256Companion -FilePath $newestPg
    $pgSqlHash = Assert-Sha256Companion -FilePath $newestPgSql
    $tmpSql = Expand-GzipToTempSql -GzPath $newestPgSql
    try {
        $tail = Get-Content -LiteralPath $tmpSql -Tail 15
        if (-not ($tail -match "PostgreSQL database dump complete")) {
            throw "Missing dump completion footer in $newestPgSql"
        }
        $copyCount = (Select-String -LiteralPath $tmpSql -Pattern "^COPY public\.").Count
    } finally {
        Remove-Item -LiteralPath $tmpSql -Force -ErrorAction SilentlyContinue
    }
    Write-Output "OK: $([IO.Path]::GetFileName($newestPg)) (sha256=$pgHash)"
    Write-Output "OK: $([IO.Path]::GetFileName($newestPgSql)) (sha256=$pgSqlHash | COPY tables=$copyCount)"

    Write-Output "=== [2/2] Verifying Media + Codebase + Server Config Encrypted Archive on PC ==="
    $mediaHash = Assert-Sha256Companion -FilePath $newestMedia
    $tmpMediaTar = Invoke-GpgDecryptToTemp -SourcePath $newestMedia -Suffix ".tar.gz"
    try {
        $tarEntries = Assert-SafeTarArchive -ArchivePath $tmpMediaTar
    } finally {
        Remove-Item -LiteralPath $tmpMediaTar -Force -ErrorAction SilentlyContinue
    }
    Write-Output "OK: $([IO.Path]::GetFileName($newestMedia)) | sha256=$mediaHash | Archive entries=$($tarEntries.Count)"
    $gpgExe = "C:\Program Files\GnuPG\bin\gpg.exe"
    $secKeys = & $gpgExe --batch --with-colons --list-secret-keys 46927A8544DF70FBEE48928F69240E0EB1FF3925 2>$null
    $hasSecretKey = ($secKeys -match '^sec:')
    Write-Output "OK: Windows Secret Key Present=$([bool]$hasSecretKey) (Mail hosted on iCloud+ Custom Domain)"
    Write-Output "=== ALL PC OFFSITE BACKUPS VERIFIED 100% READY FOR RESTORE ==="
}
elseif ($Mode -eq "TestDatabaseRestore") {
    Write-Output "=== Running Isolated Dry-Run PostgreSQL Restore Test on PC ==="
    . (Join-Path $scriptRoot "database-backup.ps1")
    $conn = Get-GaeruBackupConnection -EnvFile (Join-Path $repoRoot ".env")
    $savedEnv = @{}
    foreach ($k in $conn.Keys) {
        $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
        [Environment]::SetEnvironmentVariable($k, $conn[$k], "Process")
    }

    $psql = Find-PgTool "psql.exe"
    $testDb = "gaeru_dr_verify_" + [guid]::NewGuid().ToString("N")
    $created = $false
    $tmpSql = $null
    $prevEA = $ErrorActionPreference
    try {
        Assert-Sha256Companion -FilePath $newestPgSql | Out-Null
        $tmpSql = Expand-GzipToTempSql -GzPath $newestPgSql
        $ErrorActionPreference = "Continue"
        & $psql -q -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $testDb;" *>$null
        if ($LASTEXITCODE -ne 0) { throw "Could not create isolated verification database." }
        $created = $true
        & $psql -q -v ON_ERROR_STOP=1 -d $testDb -f $tmpSql *>$null
        if ($LASTEXITCODE -ne 0) { throw "psql restore failed" }
        $counts = & $psql -q -v ON_ERROR_STOP=1 -tA -d $testDb -c "SELECT 'public_tables=' || count(*) FROM pg_tables WHERE schemaname='public' UNION ALL SELECT 'products=' || count(*) FROM products UNION ALL SELECT 'orders=' || count(*) FROM orders UNION ALL SELECT 'media_upload_originals=' || count(*) FROM media_upload_originals;"
        if ($LASTEXITCODE -ne 0) { throw "psql verification query failed" }
        Write-Output "Dry-run DB restore succeeded 100% cleanly from $([IO.Path]::GetFileName($newestPgSql)):"
        $counts | ForEach-Object { Write-Output "  $_" }
    } finally {
        $ErrorActionPreference = "Continue"
        if ($tmpSql) { Remove-Item -LiteralPath $tmpSql -Force -ErrorAction SilentlyContinue }
        if ($created) { & $psql -q -d postgres -c "DROP DATABASE $testDb;" *>$null }
        foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], "Process") }
        $ErrorActionPreference = $prevEA
    }
}
elseif ($Mode -eq "FailoverToPC") {
    Write-Output "=== EMERGENCY FAILOVER: Restoring Latest Mi 6 State to PC and Starting Server ==="
    Assert-Sha256Companion -FilePath $newestPgSql | Out-Null
    Assert-Sha256Companion -FilePath $newestMedia | Out-Null

    $watchdog = Join-Path $scriptRoot 'watchdog-supervisor.js'
    foreach ($required in @($watchdog, (Join-Path $repoRoot 'src/server.js'), (Join-Path $repoRoot '.env'), (Join-Path $repoRoot 'node_modules/dotenv/package.json'), 'C:\Program Files\GnuPG\bin\gpg.exe')) {
        if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing failover prerequisite: $required" }
    }
    foreach ($tool in @('node.exe', 'tar.exe', 'robocopy.exe', 'icacls.exe')) {
        Get-Command $tool -CommandType Application -ErrorAction Stop | Out-Null
    }
    $tempExtract = Join-Path ([IO.Path]::GetFullPath($env:TEMP)) ("gaeru_dr_extract_" + [guid]::NewGuid().ToString('N'))
    $psql = Find-PgTool "psql.exe"
    $port = if ($env:PORT) { [int]$env:PORT } else { 3000 }
    $portLine = Select-String -LiteralPath (Join-Path $repoRoot '.env') -Pattern '^\s*PORT\s*=\s*["'']?(\d+)' | Select-Object -First 1
    if (-not $env:PORT -and $portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }

    . (Join-Path $scriptRoot "database-backup.ps1")
    $conn = Get-GaeruBackupConnection -EnvFile (Join-Path $repoRoot ".env")
    $savedEnv = @{}
    foreach ($k in $conn.Keys) {
        $savedEnv[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
        [Environment]::SetEnvironmentVariable($k, $conn[$k], "Process")
    }

    $tmpSql = $null
    $tmpMediaTar = $null
    try {
        $tmpSql = Expand-GzipToTempSql -GzPath $newestPgSql
        $tmpMediaTar = Invoke-GpgDecryptToTemp -SourcePath $newestMedia -Suffix ".tar.gz"
        Assert-SafeTarArchive -ArchivePath $tmpMediaTar | Out-Null
        New-Item -ItemType Directory -Path $tempExtract -ErrorAction Stop | Out-Null
        Protect-TempPath $tempExtract
        & tar.exe -xzf $tmpMediaTar -C $tempExtract "userdata/storage/apps/gaeru/media"
        if ($LASTEXITCODE -ne 0) { throw "Could not stage media from $newestMedia" }
        $extractedMedia = Join-Path $tempExtract "userdata\storage\apps\gaeru\media"
        if (-not (Test-Path -LiteralPath $extractedMedia -PathType Container)) { throw "Missing media directory in archive" }
        Write-Output "[0/3] Stopping any active GAERU Node/Supervisor processes on PC before DB restore..."
        Disable-ScheduledTask -TaskName "GAERU_Server_AutoStart" -ErrorAction SilentlyContinue | Out-Null
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*$repoRoot*" -and (
                $_.CommandLine -like "*cluster-master.js*" -or
                $_.CommandLine -like "*cluster.js*" -or
                $_.CommandLine -like "*server.js*" -or
                $_.CommandLine -like "*watchdog-supervisor.js*"
            )
        } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Output "[1/3] Restoring PostgreSQL database $($conn.PGDATABASE) on PC from $([IO.Path]::GetFileName($newestPgSql))..."
        $psqlErrFile = Join-Path $env:TEMP ("gaeru_psql_err_" + [guid]::NewGuid().ToString("N") + ".log")
        New-Item -ItemType File -Path $psqlErrFile -Force | Out-Null
        Protect-TempPath $psqlErrFile
        try {
            & $psql -q -1 -v ON_ERROR_STOP=1 -d $conn.PGDATABASE -f $tmpSql 2>$psqlErrFile | Out-Null
            if ($LASTEXITCODE -ne 0) {
                $errDetail = if (Test-Path -LiteralPath $psqlErrFile) { Get-Content -LiteralPath $psqlErrFile -Raw -ErrorAction SilentlyContinue } else { "" }
                throw "psql failover restore failed: $($errDetail.Trim())"
            }
        } finally {
            Remove-Item -LiteralPath $psqlErrFile -Force -ErrorAction SilentlyContinue
        }
        Write-Output "[2/3] Restoring staged media library..."
        & robocopy $extractedMedia (Join-Path $repoRoot "media") /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
    } finally {
        if ($tmpSql) { Remove-Item -LiteralPath $tmpSql -Force -ErrorAction SilentlyContinue }
        if ($tmpMediaTar) { Remove-Item -LiteralPath $tmpMediaTar -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $tempExtract) {
            $resolved = (Resolve-Path -LiteralPath $tempExtract).Path
            if ((Split-Path -Parent $resolved) -eq [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') -and
                (Split-Path -Leaf $resolved) -match '^gaeru_dr_extract_[0-9a-f]{32}$') {
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
        }
        foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], "Process") }
    }

    Write-Output "[3/3] Starting GAERU server & Cloudflare tunnel on PC..."
    $envPath = Join-Path $repoRoot ".env"
    if (Test-Path -LiteralPath $envPath) {
        $envRaw = Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
        if ($envRaw -match '(?m)^ALLOW_PC_SUPERVISOR=') {
            $envRaw = $envRaw -replace '(?m)^ALLOW_PC_SUPERVISOR=.*', 'ALLOW_PC_SUPERVISOR=true'
        } else {
            $envRaw = $envRaw.TrimEnd() + "`nALLOW_PC_SUPERVISOR=true`n"
        }
        [System.IO.File]::WriteAllText($envPath, $envRaw, [System.Text.UTF8Encoding]::new($false))
    }
    $env:ALLOW_PC_SUPERVISOR = "true"
    Enable-ScheduledTask -TaskName "GAERU_Server_AutoStart" -ErrorAction SilentlyContinue | Out-Null
    Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList ('"' + $watchdog + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -ErrorAction Stop
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/readyz" -TimeoutSec 2 -ErrorAction Stop
            if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).isReady -eq $true) { $ready = $true; break }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { throw "GAERU started but did not confirm database and media readiness on port $port." }
    Write-Output "=== FAILOVER TO PC COMPLETE ==="
}
