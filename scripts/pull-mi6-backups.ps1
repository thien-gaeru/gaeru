[CmdletBinding()]
param(
    [string]$Mi6Host = "root@192.168.31.59",
    [string]$BackupRoot = "E:\GAERU_Backups\mi6",
    [int]$KeepDays = 30,
    [ValidateSet("yes", "accept-new")][string]$StrictHostKeyChecking = "yes"
)

$ErrorActionPreference = "Stop"
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$sshCommonArgs = @("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=$StrictHostKeyChecking")

$pgDir = Join-Path $BackupRoot "pg"
$mediaDir = Join-Path $BackupRoot "media"
$mailDir = Join-Path $BackupRoot "mail"
$kitDir = Join-Path $BackupRoot "recovery-kit"
$logFile = Join-Path $BackupRoot "pull.log"
$statusFile = Join-Path $BackupRoot "backup-status.json"

foreach ($d in @($BackupRoot, $pgDir, $mediaDir, $mailDir, $kitDir)) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}

function Write-PullLog([string]$Message) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Sync-RemoteDirectory {
    param(
        [string]$RemoteDir,
        [string]$Pattern,
        [string]$LocalDir,
        [string]$Label,
        [int]$MaxFiles = 6
    )

    $listCmd = "ls -1t $RemoteDir/$Pattern 2>/dev/null | head -n $MaxFiles"
    $previousEA = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $remoteFiles = & ssh @sshCommonArgs -o ConnectTimeout=10 $Mi6Host $listCmd 2>$null
        $sshExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEA
    }
    if ($sshExit -ne 0 -or -not $remoteFiles) {
        Write-PullLog "[$Label] No matching remote files or SSH unreachable."
        return $null
    }

    $newestLocal = $null
    foreach ($remotePath in ($remoteFiles -split "`r?`n" | Where-Object { $_.Trim() })) {
        $remotePath = $remotePath.Trim()
        if ($remotePath -match '\.sha256$') { continue }
        $fileName = [System.IO.Path]::GetFileName($remotePath)
        if ([string]::IsNullOrWhiteSpace($fileName) -or $fileName -eq '.' -or $fileName -eq '..') { continue }
        $localPath = Join-Path $LocalDir $fileName
        $remoteShaPath = "${remotePath}.sha256"
        $localShaPath = "${localPath}.sha256"

        $needsDownload = (-not (Test-Path -LiteralPath $localPath)) -or ($fileName -match '-latest\.')
        if ($needsDownload) {
            Write-PullLog "[$Label] Pulling $fileName..."
            $tmpLocal = "${localPath}.part"
            $previousEA = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & scp @sshCommonArgs -q "${Mi6Host}:${remotePath}" $tmpLocal
                $scpExit = $LASTEXITCODE
                & scp @sshCommonArgs -q "${Mi6Host}:${remoteShaPath}" $localShaPath 2>$null
            } finally {
                $ErrorActionPreference = $previousEA
            }
            if ($scpExit -ne 0) {
                Remove-Item -LiteralPath $tmpLocal -Force -ErrorAction SilentlyContinue
                throw "scp failed for $remotePath"
            }
            Move-Item -LiteralPath $tmpLocal -Destination $localPath -Force
        } elseif (-not (Test-Path -LiteralPath $localShaPath)) {
            $previousEA = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & scp @sshCommonArgs -q "${Mi6Host}:${remoteShaPath}" $localShaPath 2>$null
            } finally {
                $ErrorActionPreference = $previousEA
            }
        }

        if (Test-Path -LiteralPath $localShaPath) {
            $expectedLine = (Get-Content -LiteralPath $localShaPath -Raw).Trim()
            $expectedHash = ($expectedLine -split '\s+')[0].ToLowerInvariant()
            $actualHash = (Get-FileHash -LiteralPath $localPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expectedHash -and $expectedHash -ne $actualHash) {
                Remove-Item -LiteralPath $localPath -Force -ErrorAction SilentlyContinue
                throw "[$Label] SHA256 mismatch for $fileName (expected $expectedHash, got $actualHash)"
            }
            Write-PullLog "[$Label] Verified $fileName (sha256=$actualHash)"
        } else {
            throw "[$Label] Missing mandatory .sha256 companion file for $fileName"
        }

        if (-not $newestLocal -and ($fileName -notmatch '-latest\.') -and ($Label -ne 'PG-SQL' -or $fileName -notmatch '^gaeru_store-globals-')) {
            $newestLocal = $localPath
        }
    }
    return $newestLocal
}

Write-PullLog "Starting Mi6 offsite backup pull from $Mi6Host -> $BackupRoot"

$newestPg = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-pg-backups" -Pattern "gaeru_store-*.dump.gpg" -LocalDir $pgDir -Label "PG-DUMP" -MaxFiles 6
$newestPgSql = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-pg-backups" -Pattern "gaeru_store-*.sql.gz.gpg" -LocalDir $pgDir -Label "PG-SQL" -MaxFiles 6
$null = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-pg-backups" -Pattern "gaeru_store-globals-*.sql.gz.gpg" -LocalDir $pgDir -Label "PG-GLOBALS" -MaxFiles 6
$newestMedia = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-media-backups" -Pattern "gaeru-media-config-*.tar.gz.gpg" -LocalDir $mediaDir -Label "MEDIA" -MaxFiles 3
$newestMail = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-mail-backups" -Pattern "gaeru-mail-v04-*.tar.gz.gpg" -LocalDir $mailDir -Label "MAIL" -MaxFiles 4

# Verify OpenPGP SQL.GZ dump envelope (and full decrypted completion footer when PC private key is unlocked)
$pgRestoreVerified = $false
if ($newestPgSql -and (Test-Path -LiteralPath $newestPgSql)) {
    $gpgExe = "C:\Program Files\GnuPG\bin\gpg.exe"
    if (Test-Path -LiteralPath $gpgExe) {
        function Invoke-GpgQuiet {
            param(
                [string]$ExePath,
                [string[]]$GpgArgs
            )
            $previousEA = $ErrorActionPreference
            $stdout = @()
            $exitCode = 1
            try {
                $ErrorActionPreference = "Continue"
                $stdout = @(& $ExePath @GpgArgs 2>$null)
                $exitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousEA
            }
            return [pscustomobject]@{
                ExitCode = $exitCode
                Output   = $stdout
            }
        }
        $packetRes = Invoke-GpgQuiet -ExePath $gpgExe -GpgArgs @('--batch', '--no-tty', '--pinentry-mode', 'cancel', '--list-only', '--list-packets', $newestPgSql)
        $packets = $packetRes.Output
        if (-not (($packets -join "`n") -match 'pubkey enc packet')) {
            throw "[PG-SQL] Invalid OpenPGP envelope in $newestPgSql"
        }
        $tmpGz = Join-Path $env:TEMP ("gaeru_pull_verify_" + [guid]::NewGuid().ToString("N") + ".sql.gz")
        try {
            $decryptRes = Invoke-GpgQuiet -ExePath $gpgExe -GpgArgs @('--batch', '--yes', '--no-tty', '--pinentry-mode', 'cancel', '--decrypt', '--output', $tmpGz, $newestPgSql)
            $gpgExit = $decryptRes.ExitCode
            if ($gpgExit -eq 0 -and (Test-Path -LiteralPath $tmpGz)) {
                $fs = [System.IO.File]::OpenRead($tmpGz)
                $gz = $null
                $sr = $null
                try {
                    $gz = New-Object System.IO.Compression.GZipStream($fs, [System.IO.Compression.CompressionMode]::Decompress)
                    $sr = New-Object System.IO.StreamReader($gz, [System.Text.Encoding]::UTF8)
                    $foundFooter = $false
                    while ($null -ne ($line = $sr.ReadLine())) {
                        if ($line -match "PostgreSQL database dump complete") {
                            $foundFooter = $true
                            break
                        }
                    }
                    if ($foundFooter) {
                        $pgRestoreVerified = $true
                        Write-PullLog "[PG-SQL] Decrypted & verified completion footer for $([IO.Path]::GetFileName($newestPgSql))"
                    } else {
                        throw "[PG-SQL] Missing completion footer in $newestPgSql"
                    }
                } finally {
                    if ($sr) { $sr.Dispose() }
                    if ($gz) { $gz.Dispose() }
                    $fs.Dispose()
                }
            } else {
                Write-PullLog "[PG-SQL] Verified SHA-256 + OpenPGP envelope for $([IO.Path]::GetFileName($newestPgSql)) (passphrase required for unattended decrypt)"
                $pgRestoreVerified = $false
            }
        } finally {
            Remove-Item -LiteralPath $tmpGz -Force -ErrorAction SilentlyContinue
        }
    } else {
        throw "[PG-SQL] GnuPG not found at $gpgExe to verify encrypted dump"
    }
}

# Copy newest encrypted mail archive to legacy C:\Users\imdot\GAERU-Encrypted-Backups as well
$legacyMailDir = Join-Path $env:USERPROFILE "GAERU-Encrypted-Backups"
if ($newestMail -and (Test-Path -LiteralPath $newestMail)) {
    New-Item -ItemType Directory -Path $legacyMailDir -Force | Out-Null
    Copy-Item -LiteralPath $newestMail -Destination (Join-Path $legacyMailDir ([IO.Path]::GetFileName($newestMail))) -Force
    if (Test-Path -LiteralPath "${newestMail}.sha256") {
        Copy-Item -LiteralPath "${newestMail}.sha256" -Destination (Join-Path $legacyMailDir "$([IO.Path]::GetFileName($newestMail)).sha256") -Force
    }
}

# Keep recovery kit scripts in E:\GAERU_Backups\mi6\recovery-kit
foreach ($relPath in @(
    "mi6-backup\gaeru-gpg-common.sh",
    "mi6-backup\gaeru-full-restore.sh",
    "mi6-backup\gaeru-gdrive-sync.sh",
    "mi6-backup\gaeru-pg-backup.sh",
    "mi6-backup\gaeru-media-backup.sh",
    "mi6-backup\gaeru-mail-backup-v04.sh",
    "failover-restore-to-pc.ps1"
)) {
    $f = Join-Path $scriptRoot $relPath
    if (Test-Path -LiteralPath $f) {
        Copy-Item -LiteralPath $f -Destination (Join-Path $kitDir ([IO.Path]::GetFileName($f))) -Force
    }
}

if ($KeepDays -gt 0) {
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    foreach ($d in @($pgDir, $mediaDir, $mailDir)) {
        Get-ChildItem -LiteralPath $d -File | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            Write-PullLog "Pruned old local copy: $($_.FullName)"
        }
    }
}

$statusObj = [ordered]@{
    lastPullLocalTime = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
    mi6Host           = $Mi6Host
    backupRoot        = $BackupRoot
    newestPg          = $(if ($newestPg) { [IO.Path]::GetFileName($newestPg) } else { $null })
    pgTocVerified     = $pgRestoreVerified
    newestMedia       = $(if ($newestMedia) { [IO.Path]::GetFileName($newestMedia) } else { $null })
    newestMail        = $(if ($newestMail) { [IO.Path]::GetFileName($newestMail) } else { $null })
    status            = $(if ($pgRestoreVerified) { "verified" } else { "envelope_verified" })
}
$statusObj | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusFile -Encoding UTF8

Write-PullLog "Mi6 offsite backup pull completed cleanly."
