[CmdletBinding()]
param(
    [string]$Mi6Host = "root@192.168.31.59",
    [string]$BackupRoot = "E:\GAERU_Backups\mi6",
    [int]$KeepDays = 30,
    [ValidateSet("yes", "accept-new")][string]$StrictHostKeyChecking = "yes",
    [string]$GpgExe = "C:\Program Files\GnuPG\bin\gpg.exe"
)

$ErrorActionPreference = "Stop"
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$sshCommonArgs = @("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=$StrictHostKeyChecking")

$pgDir = Join-Path $BackupRoot "pg"
$mediaDir = Join-Path $BackupRoot "media"
$kitDir = Join-Path $BackupRoot "recovery-kit"
$logFile = Join-Path $BackupRoot "pull.log"
$statusFile = Join-Path $BackupRoot "backup-status.json"

foreach ($d in @($BackupRoot, $pgDir, $mediaDir, $kitDir)) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}

function Write-PullLog([string]$Message) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

function Assert-ArchiveHash([string]$Archive, [string]$Companion) {
    $hashText = [string](Get-Content -LiteralPath $Companion -Raw)
    $expectedHash = ($hashText.Trim() -split '\s+')[0]
    if ($expectedHash -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $expectedHash) {
        throw "Invalid SHA256 companion or archive checksum for $Archive"
    }
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
        throw "[$Label] A dated, verified archive is required."
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
            $tmpShaLocal = "${localShaPath}.part"
            $previousEA = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & scp @sshCommonArgs -q "${Mi6Host}:${remotePath}" $tmpLocal
                $scpExit = $LASTEXITCODE
                & scp @sshCommonArgs -q "${Mi6Host}:${remoteShaPath}" $tmpShaLocal 2>$null
                $shaExit = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousEA
            }
            if ($scpExit -ne 0 -or $shaExit -ne 0) {
                Remove-Item -LiteralPath $tmpLocal -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $tmpShaLocal -Force -ErrorAction SilentlyContinue
                throw "scp failed for $remotePath or companion .sha256 (scp=$scpExit, sha=$shaExit)"
            }
            try {
                Assert-ArchiveHash $tmpLocal $tmpShaLocal
                Move-Item -LiteralPath $tmpLocal -Destination $localPath -Force
                Move-Item -LiteralPath $tmpShaLocal -Destination $localShaPath -Force
            } catch {
                Remove-Item -LiteralPath $tmpLocal -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $tmpShaLocal -Force -ErrorAction SilentlyContinue
                throw
            }
        } elseif (-not (Test-Path -LiteralPath $localShaPath)) {
            $tmpShaLocal = "${localShaPath}.part"
            $previousEA = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & scp @sshCommonArgs -q "${Mi6Host}:${remoteShaPath}" $tmpShaLocal 2>$null
                $shaExit = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousEA
            }
            if ($shaExit -eq 0 -and (Test-Path -LiteralPath $tmpShaLocal)) {
                Move-Item -LiteralPath $tmpShaLocal -Destination $localShaPath -Force
            } else {
                Remove-Item -LiteralPath $tmpShaLocal -Force -ErrorAction SilentlyContinue
            }
        }

        Assert-ArchiveHash $localPath $localShaPath
        Write-PullLog "[$Label] Verified $fileName"

        if (-not $newestLocal -and ($fileName -notmatch '-latest\.') -and ($Label -ne 'PG-SQL' -or $fileName -notmatch '^gaeru_store-globals-')) {
            $newestLocal = $localPath
        }
    }
    return $newestLocal
}

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

function Assert-OpenPgpEnvelope([string]$Archive) {
    if (-not (Test-Path -LiteralPath $GpgExe)) {
        throw "GnuPG not found at $GpgExe to verify encrypted archive $Archive"
    }
    $packetRes = Invoke-GpgQuiet -ExePath $GpgExe -GpgArgs @('--batch', '--no-tty', '--pinentry-mode', 'cancel', '--list-only', '--list-packets', $Archive)
    if (-not (($packetRes.Output -join "`n") -match 'pubkey enc packet')) {
        throw "Invalid OpenPGP envelope in $Archive"
    }
}

function Remove-OldGroupCopies([string[]]$VerifiedArchives, [int]$RetentionDays) {
    if ($RetentionDays -le 0) { return }
    $cutoff = (Get-Date).AddDays(-$RetentionDays)
    foreach ($replacement in $VerifiedArchives) {
        if (-not $replacement -or -not (Test-Path -LiteralPath $replacement) -or -not (Test-Path -LiteralPath ($replacement + '.sha256'))) {
            continue
        }
        $name = [IO.Path]::GetFileName($replacement)
        $stampMatch = [regex]::Match($name, '20\d{6}T\d{6}Z')
        if (-not $stampMatch.Success) { continue }
        $stamp = $stampMatch.Value
        $pattern = '^' + [regex]::Escape($name).Replace($stamp, '(?<stamp>20\d{6}T\d{6}Z)') + '$'
        Get-ChildItem -LiteralPath (Split-Path -Parent $replacement) -File | Where-Object {
            $_.Name -match $pattern -and $Matches.stamp -lt $stamp -and $_.LastWriteTime -lt $cutoff
        } | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Force
            $companion = $_.FullName + '.sha256'
            if (Test-Path -LiteralPath $companion) { Remove-Item -LiteralPath $companion -Force }
            Write-PullLog "Pruned old local copy: $($_.FullName)"
        }
    }
}

function Write-StatusJson([System.Collections.IDictionary]$Obj) {
    $json = $Obj | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($statusFile, $json + "`n", [System.Text.UTF8Encoding]::new($false))
}

trap {
    Write-StatusJson ([ordered]@{ status = 'failed'; lastPullLocalTime = (Get-Date -Format o); error = $_.Exception.Message })
    break
}

Write-PullLog "Starting Mi6 offsite backup pull from $Mi6Host -> $BackupRoot"

$newestPg = $null
$newestPgSql = $null
$newestGlobals = $null
$newestMedia = $null
$pgGroupVerified = $false
$pgRestoreVerified = $false
$mediaGroupVerified = $false
$groupErrors = New-Object System.Collections.Generic.List[string]

# 1. PostgreSQL group (isolated: failure never triggers PG pruning and still allows Media sync)
try {
    $newestPg = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-pg-backups" -Pattern "gaeru_store-20*.dump.gpg" -LocalDir $pgDir -Label "PG-DUMP" -MaxFiles 6
    $newestPgSql = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-pg-backups" -Pattern "gaeru_store-20*.sql.gz.gpg" -LocalDir $pgDir -Label "PG-SQL" -MaxFiles 6
    $newestGlobals = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-pg-backups" -Pattern "gaeru_store-globals-20*.sql.gz.gpg" -LocalDir $pgDir -Label "PG-GLOBALS" -MaxFiles 6

    $pgSet = @($newestPg, $newestPgSql, $newestGlobals)
    foreach ($archive in $pgSet) {
        if (-not $archive -or [IO.Path]::GetFileName($archive) -notmatch '-(20\d{6}T\d{6}Z)\.') {
            throw "Incomplete dated PostgreSQL backup set. Local PG archives retained."
        }
    }
    $pgStamps = @($pgSet | ForEach-Object { [regex]::Match([IO.Path]::GetFileName($_), '20\d{6}T\d{6}Z').Value } | Sort-Object -Unique)
    if ($pgStamps.Count -ne 1) { throw "PostgreSQL backup components belong to different runs. Local PG archives retained." }

    foreach ($archive in $pgSet) {
        Assert-OpenPgpEnvelope $archive
    }

    $tmpGz = Join-Path $env:TEMP ("gaeru_pull_verify_" + [guid]::NewGuid().ToString("N") + ".sql.gz")
    try {
        $decryptRes = Invoke-GpgQuiet -ExePath $GpgExe -GpgArgs @('--batch', '--yes', '--no-tty', '--pinentry-mode', 'cancel', '--decrypt', '--output', $tmpGz, $newestPgSql)
        if ($decryptRes.ExitCode -eq 0 -and (Test-Path -LiteralPath $tmpGz)) {
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
    $pgGroupVerified = $true
} catch {
    $msg = "PG: $($_.Exception.Message)"
    Write-PullLog "[ERROR] $msg"
    $groupErrors.Add($msg)
}

# 2. Media group (isolated: failure never triggers Media pruning and does not discard verified PG pull)
try {
    $newestMedia = Sync-RemoteDirectory -RemoteDir "/userdata/storage/gaeru-media-backups" -Pattern "gaeru-media-config-20*.tar.gz.gpg" -LocalDir $mediaDir -Label "MEDIA" -MaxFiles 3
    if (-not $newestMedia -or [IO.Path]::GetFileName($newestMedia) -notmatch '-(20\d{6}T\d{6}Z)\.') {
        throw "Incomplete dated Media backup. Local Media archives retained."
    }
    Assert-OpenPgpEnvelope $newestMedia
    $mediaGroupVerified = $true
} catch {
    $msg = "MEDIA: $($_.Exception.Message)"
    Write-PullLog "[ERROR] $msg"
    $groupErrors.Add($msg)
}

# Keep recovery kit scripts in E:\GAERU_Backups\mi6\recovery-kit
foreach ($relPath in @(
    "mi6-backup\gaeru-gpg-common.sh",
    "mi6-backup\gaeru-full-restore.sh",
    "mi6-backup\gaeru-gdrive-sync.sh",
    "mi6-backup\gaeru-pg-backup.sh",
    "mi6-backup\gaeru-media-backup.sh",
    "mi6-backup\gaeru-backup-prune.sh",
    "database-backup.ps1",
    "portable-database-backup.cjs",
    "watchdog-supervisor.js",
    "failover-restore-to-pc.ps1"
)) {
    $f = Join-Path $scriptRoot $relPath
    if (Test-Path -LiteralPath $f) {
        Copy-Item -LiteralPath $f -Destination (Join-Path $kitDir ([IO.Path]::GetFileName($f))) -Force
    }
}

# Prune ONLY groups that have a verified dated replacement set (always keeping newest archive + .sha256).
if ($KeepDays -gt 0 -and $pgGroupVerified) {
    Remove-OldGroupCopies -VerifiedArchives @($newestPg, $newestPgSql, $newestGlobals) -RetentionDays $KeepDays
}
if ($KeepDays -gt 0 -and $mediaGroupVerified) {
    Remove-OldGroupCopies -VerifiedArchives @($newestMedia) -RetentionDays $KeepDays
}

if ($groupErrors.Count -gt 0) {
    $errSummary = ($groupErrors -join "; ")
    Write-StatusJson ([ordered]@{
        lastPullLocalTime   = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
        mi6Host             = $Mi6Host
        backupRoot          = $BackupRoot
        newestPg            = $(if ($pgGroupVerified -and $newestPg) { [IO.Path]::GetFileName($newestPg) } else { $null })
        pgTocVerified       = $false
        portableSqlVerified = $pgRestoreVerified
        newestMedia         = $(if ($mediaGroupVerified -and $newestMedia) { [IO.Path]::GetFileName($newestMedia) } else { $null })
        mailProvider        = "iCloud+ Custom Email Domain"
        status              = "failed"
        error               = $errSummary
    })
    throw "Backup pull incomplete ($errSummary). Local copies of failed group(s) retained."
}

$statusObj = [ordered]@{
    lastPullLocalTime   = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK")
    mi6Host             = $Mi6Host
    backupRoot          = $BackupRoot
    newestPg            = $(if ($newestPg) { [IO.Path]::GetFileName($newestPg) } else { $null })
    pgTocVerified       = $false
    portableSqlVerified = $pgRestoreVerified
    newestMedia         = $(if ($newestMedia) { [IO.Path]::GetFileName($newestMedia) } else { $null })
    mailProvider        = "iCloud+ Custom Email Domain"
    status              = $(if ($pgRestoreVerified) { "verified" } else { "envelope_verified" })
}
Write-StatusJson $statusObj

Write-PullLog "Mi6 offsite backup pull completed cleanly (status=$($statusObj.status))."
