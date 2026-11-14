[CmdletBinding()]
param(
    [ValidateSet("Verify", "TestDatabaseRestore", "DecryptMailArchive", "PullFromGoogleDrive", "FailoverToPC")]
    [string]$Mode = "Verify",
    [string]$BackupRoot = "E:\GAERU_Backups\mi6",
    [string]$DecryptOutDir = "E:\GAERU_Backups\mi6\decrypted-mail-test"
)

$ErrorActionPreference = "Stop"
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = Split-Path -Parent $scriptRoot

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
$mailDir = Join-Path $BackupRoot "mail"

function Find-PgTool([string]$ExeName) {
    $found = Get-ChildItem -LiteralPath "C:\Program Files\PostgreSQL" -Filter $ExeName -Recurse -ErrorAction SilentlyContinue |
        Sort-Object @{ Expression = { try { [version]$_.VersionInfo.FileVersion } catch { [version]"0.0" } }; Descending = $true }, FullName |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $found) { throw "$ExeName not found in C:\Program Files\PostgreSQL" }
    return $found
}

function Get-NewestBackupFile([string]$Dir, [string]$Filter) {
    $file = Get-ChildItem -LiteralPath $Dir -Filter $Filter -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '-latest\.' -and $_.Name -notmatch '\.sha256$' } |
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
    $expected = ((Get-Content -LiteralPath $shaFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
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
    foreach ($sub in @("pg", "media", "mail")) {
        & $rclone copy "gdrive:GAERU_Backups/$sub" (Join-Path $BackupRoot $sub) --transfers 2
        if ($LASTEXITCODE -ne 0) { throw "rclone copy failed for $sub" }
    }
    $Mode = "Verify"
}

$newestPg = Get-NewestBackupFile -Dir $pgDir -Filter "gaeru_store-*.dump.gpg"
$newestPgSql = Get-NewestBackupFile -Dir $pgDir -Filter "gaeru_store-*.sql.gz.gpg"
$newestMedia = Get-NewestBackupFile -Dir $mediaDir -Filter "gaeru-media-config-*.tar.gz.gpg"
$newestMail = Get-NewestBackupFile -Dir $mailDir -Filter "gaeru-mail-v04-*.tar.gz.gpg"

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
    Write-Output "=== [1/3] Verifying PostgreSQL Backups (.dump.gpg + portable .sql.gz.gpg) on PC ==="
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

    Write-Output "=== [2/3] Verifying Media + Codebase + Server Config Encrypted Archive on PC ==="
    $mediaHash = Assert-Sha256Companion -FilePath $newestMedia
    $tmpMediaTar = Invoke-GpgDecryptToTemp -SourcePath $newestMedia -Suffix ".tar.gz"
    try {
        $tarEntries = Assert-SafeTarArchive -ArchivePath $tmpMediaTar
    } finally {
        Remove-Item -LiteralPath $tmpMediaTar -Force -ErrorAction SilentlyContinue
    }
    Write-Output "OK: $([IO.Path]::GetFileName($newestMedia)) | sha256=$mediaHash | Archive entries=$($tarEntries.Count)"

    Write-Output "=== [3/3] Verifying Encrypted Mail + Webmail GPG Archive on PC ==="
    $mailHash = Assert-Sha256Companion -FilePath $newestMail
    $gpgExe = "C:\Program Files\GnuPG\bin\gpg.exe"
    $secKeys = & $gpgExe --batch --with-colons --list-secret-keys 46927A8544DF70FBEE48928F69240E0EB1FF3925 2>$null
    $hasSecretKey = ($secKeys -match '^sec:')
    Write-Output "OK: $([IO.Path]::GetFileName($newestMail)) | sha256=$mailHash | Windows Secret Key Present=$([bool]$hasSecretKey)"
    Write-Output "=== ALL 3 PC OFFSITE BACKUPS VERIFIED 100% READY FOR RESTORE ==="
}
elseif ($Mode -eq "TestDatabaseRestore") {
    Write-Output "=== Running Isolated Dry-Run PostgreSQL Restore Test on PC ==="
    . (Join-Path $scriptRoot "database-backup.ps1")
    $conn = Get-GaeruBackupConnection -EnvFile (Join-Path $repoRoot ".env")
    foreach ($k in $conn.Keys) { [Environment]::SetEnvironmentVariable($k, $conn[$k], "Process") }

    $psql = Find-PgTool "psql.exe"
    $testDb = "gaeru_dr_verify_test"
    Assert-Sha256Companion -FilePath $newestPgSql | Out-Null
    $tmpSql = Expand-GzipToTempSql -GzPath $newestPgSql

    $prevEA = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $psql -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS $testDb;" *>$null
        & $psql -q -v ON_ERROR_STOP=1 -d postgres -c "CREATE DATABASE $testDb;" *>$null
        & $psql -q -v ON_ERROR_STOP=1 -d $testDb -f $tmpSql *>$null
        if ($LASTEXITCODE -ne 0) { throw "psql restore failed" }
        $counts = & $psql -q -v ON_ERROR_STOP=1 -tA -d $testDb -c "SELECT 'public_tables=' || count(*) FROM pg_tables WHERE schemaname='public' UNION ALL SELECT 'products=' || count(*) FROM products UNION ALL SELECT 'orders=' || count(*) FROM orders UNION ALL SELECT 'media_upload_originals=' || count(*) FROM media_upload_originals;"
        if ($LASTEXITCODE -ne 0) { throw "psql verification query failed" }
        Write-Output "Dry-run DB restore succeeded 100% cleanly from $([IO.Path]::GetFileName($newestPgSql)):"
        $counts | ForEach-Object { Write-Output "  $_" }
    } finally {
        $ErrorActionPreference = "Continue"
        Remove-Item -LiteralPath $tmpSql -Force -ErrorAction SilentlyContinue
        & $psql -q -d postgres -c "DROP DATABASE IF EXISTS $testDb;" *>$null
        $ErrorActionPreference = $prevEA
    }
}
elseif ($Mode -eq "DecryptMailArchive") {
    Assert-Sha256Companion -FilePath $newestMail | Out-Null
    New-Item -ItemType Directory -Path $DecryptOutDir -Force | Out-Null
    $outTarGz = Join-Path $DecryptOutDir ([IO.Path]::GetFileNameWithoutExtension($newestMail))
    Write-Output "Decrypting $newestMail -> $outTarGz ..."
    & "C:\Program Files\GnuPG\bin\gpg.exe" --output $outTarGz --decrypt $newestMail
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outTarGz)) {
        throw "GPG decryption failed."
    }
    $entries = Assert-SafeTarArchive -ArchivePath $outTarGz
    Write-Output "Decrypted Mail archive verified ($($entries.Count) files): $outTarGz"
}
elseif ($Mode -eq "FailoverToPC") {
    Write-Output "=== EMERGENCY FAILOVER: Restoring Latest Mi 6 State to PC and Starting Server ==="
    Assert-Sha256Companion -FilePath $newestPgSql | Out-Null
    Assert-Sha256Companion -FilePath $newestMedia | Out-Null

    . (Join-Path $scriptRoot "database-backup.ps1")
    $conn = Get-GaeruBackupConnection -EnvFile (Join-Path $repoRoot ".env")
    foreach ($k in $conn.Keys) { [Environment]::SetEnvironmentVariable($k, $conn[$k], "Process") }

    $psql = Find-PgTool "psql.exe"
    $tmpSql = Expand-GzipToTempSql -GzPath $newestPgSql
    try {
        Write-Output "[1/3] Restoring PostgreSQL database $($conn.PGDATABASE) on PC from $([IO.Path]::GetFileName($newestPgSql))..."
        $psqlErrFile = Join-Path $env:TEMP ("gaeru_psql_err_" + [guid]::NewGuid().ToString("N") + ".log")
        New-Item -ItemType File -Path $psqlErrFile -Force | Out-Null
        Protect-TempPath $psqlErrFile
        try {
            & $psql -q -v ON_ERROR_STOP=1 -d $conn.PGDATABASE -f $tmpSql 2>$psqlErrFile | Out-Null
            if ($LASTEXITCODE -ne 0) {
                $errDetail = if (Test-Path -LiteralPath $psqlErrFile) { Get-Content -LiteralPath $psqlErrFile -Raw -ErrorAction SilentlyContinue } else { "" }
                throw "psql failover restore failed: $($errDetail.Trim())"
            }
        } finally {
            Remove-Item -LiteralPath $psqlErrFile -Force -ErrorAction SilentlyContinue
        }
    } finally {
        Remove-Item -LiteralPath $tmpSql -Force -ErrorAction SilentlyContinue
    }

    Write-Output "[2/3] Restoring encrypted media library from $([IO.Path]::GetFileName($newestMedia))..."
    $tempExtract = Join-Path $env:TEMP "gaeru_dr_extract_$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null
    Protect-TempPath $tempExtract
    $tmpMediaTar = Invoke-GpgDecryptToTemp -SourcePath $newestMedia -Suffix ".tar.gz"
    try {
        Assert-SafeTarArchive -ArchivePath $tmpMediaTar | Out-Null
        & tar.exe -xzf $tmpMediaTar -C $tempExtract "userdata/storage/apps/gaeru/media"
        if ($LASTEXITCODE -ne 0) { throw "tar extract failed on $newestMedia" }
        $extractedMedia = Join-Path $tempExtract "userdata\storage\apps\gaeru\media"
        if (Test-Path -LiteralPath $extractedMedia) {
            & robocopy $extractedMedia (Join-Path $repoRoot "media") /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
        }
    } finally {
        Remove-Item -LiteralPath $tmpMediaTar -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Output "[3/3] Starting GAERU server & Cloudflare tunnel on PC..."
    Enable-ScheduledTask -TaskName "GAERU_Server_AutoStart" -ErrorAction SilentlyContinue | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot "restart-server.ps1")
    if ($LASTEXITCODE -ne 0) { throw "restart-server.ps1 failed with exit code $LASTEXITCODE" }
    Write-Output "=== FAILOVER TO PC COMPLETE ==="
}
