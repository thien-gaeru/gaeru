function Get-GaeruBackupConnection {
    param([Parameter(Mandatory = $true)][string]$EnvFile)

    if (!(Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
        throw 'Database configuration file is missing.'
    }
    $content = [System.IO.File]::ReadAllText($EnvFile)
    $assignments = [regex]::Matches($content, '(?m)^\s*(?:export\s+)?DATABASE_URL\s*=\s*([^\r\n]*)')
    if ($assignments.Count -eq 0) { throw 'DATABASE_URL is missing.' }
    $value = $assignments[$assignments.Count - 1].Groups[1].Value.Trim()
    if ($value.StartsWith('"') -or $value.StartsWith("'") -or $value.StartsWith('`')) {
        $quote = [regex]::Escape($value.Substring(0, 1))
        $quoted = [regex]::Match($value, ('^' + $quote + '(.*)' + $quote + '\s*(?:#.*)?$'))
        if (!$quoted.Success) { throw 'DATABASE_URL has invalid quoting.' }
        $value = $quoted.Groups[1].Value
    } else {
        $value = ($value -split '#', 2)[0].Trim()
    }
    $uri = $null
    if (![System.Uri]::TryCreate($value, [System.UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('postgres', 'postgresql') -or !$uri.Host -or $uri.Fragment) {
        throw 'DATABASE_URL must be a PostgreSQL connection URL.'
    }
    $credentials = $uri.UserInfo -split ':', 2
    $database = [System.Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    if (!$credentials[0] -or !$database) { throw 'DATABASE_URL must specify a user and database.' }
    $connection = @{
        PGHOST = $uri.Host.Trim('[', ']')
        PGPORT = $(if ($uri.Port -gt 0) { [string]$uri.Port } else { '5432' })
        PGUSER = [System.Uri]::UnescapeDataString($credentials[0])
        PGPASSWORD = $(if ($credentials.Count -gt 1) { [System.Uri]::UnescapeDataString($credentials[1]) } else { '' })
        PGDATABASE = $database
        PGCONNECT_TIMEOUT = '15'
        PGAPPNAME = 'gaeru_database_backup'
    }
    $queryEnvironment = @{
        sslmode = 'PGSSLMODE'; sslrootcert = 'PGSSLROOTCERT'; sslcert = 'PGSSLCERT'
        sslkey = 'PGSSLKEY'; sslcrl = 'PGSSLCRL'; sslcrldir = 'PGSSLCRLDIR'
        ssl_min_protocol_version = 'PGSSLMINPROTOCOLVERSION'; ssl_max_protocol_version = 'PGSSLMAXPROTOCOLVERSION'
        application_name = 'PGAPPNAME'; connect_timeout = 'PGCONNECT_TIMEOUT'; options = 'PGOPTIONS'
        target_session_attrs = 'PGTARGETSESSIONATTRS'; channel_binding = 'PGCHANNELBINDING'
        gssencmode = 'PGGSSENCMODE'; krbsrvname = 'PGKRBSRVNAME'; require_auth = 'PGREQUIREAUTH'
        sslnegotiation = 'PGSSLNEGOTIATION'; load_balance_hosts = 'PGLOADBALANCEHOSTS'
    }
    foreach ($part in $uri.Query.TrimStart('?').Split('&')) {
        if (!$part) { continue }
        $pair = $part -split '=', 2
        $key = [System.Uri]::UnescapeDataString($pair[0])
        $option = $(if ($pair.Count -gt 1) { [System.Uri]::UnescapeDataString($pair[1]) } else { '' })
        if ($key -eq 'ssl' -and $option -in @('true', 'false')) {
            $connection.PGSSLMODE = $(if ($option -eq 'true') { 'require' } else { 'disable' })
        } elseif ($queryEnvironment.ContainsKey($key)) {
            $connection[$queryEnvironment[$key]] = $option
        } else {
            throw 'DATABASE_URL contains an unsupported backup connection option.'
        }
    }
    return $connection
}

function Invoke-GaeruDatabaseBackup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$BackupDir,
        [Parameter(Mandatory = $true)][string]$EnvFile,
        [string]$PgDumpPath,
        [int]$RetentionHours = 0
    )
    $ErrorActionPreference = 'Stop'
    $connection = Get-GaeruBackupConnection -EnvFile $EnvFile
    if (!$PgDumpPath) {
        $pgDumpCandidates = Get-ChildItem -LiteralPath 'C:\Program Files\PostgreSQL' -Filter 'pg_dump.exe' -Recurse -ErrorAction SilentlyContinue |
            Sort-Object @{ Expression = { try { [version]$_.VersionInfo.FileVersion } catch { [version]'0.0' } }; Descending = $true }, FullName
        $PgDumpPath = $pgDumpCandidates | Select-Object -First 1 -ExpandProperty FullName
    }
    if (!$PgDumpPath -or !(Test-Path -LiteralPath $PgDumpPath -PathType Leaf)) {
        throw 'pg_dump is unavailable.'
    }
    [System.IO.Directory]::CreateDirectory($BackupDir) | Out-Null
    $timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $outputFile = Join-Path $BackupDir "gaeru_store_$timestamp.sql"
    if (Test-Path -LiteralPath $outputFile) { throw 'A backup with this timestamp already exists.' }
    $partialFile = "$outputFile.$([guid]::NewGuid().ToString('N')).partial"
    $savedEnvironment = @{}
    $promoted = $false
    try {
        # Do not inherit another database's libpq settings or expose credentials in argv.
        $environmentNames = @((Get-ChildItem Env: | Where-Object { $_.Name -like 'PG*' } | Select-Object -ExpandProperty Name)) + @($connection.Keys)
        foreach ($name in ($environmentNames | Select-Object -Unique)) {
            $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        foreach ($name in $connection.Keys) {
            [Environment]::SetEnvironmentVariable($name, $connection[$name], 'Process')
        }
        # Native diagnostics may contain connection information; report only a safe summary.
        $ErrorActionPreference = 'Continue'
        & $PgDumpPath '--no-password' '--format=plain' '--lock-wait-timeout=30s' "--file=$partialFile" 2>$null | Out-Null
        $dumpExitCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($dumpExitCode -ne 0) { throw 'pg_dump did not finish successfully.' }
        if (!(Test-Path -LiteralPath $partialFile -PathType Leaf) -or (Get-Item -LiteralPath $partialFile).Length -eq 0) {
            throw 'pg_dump did not produce a backup.'
        }
        $footer = Get-Content -LiteralPath $partialFile -Tail 24
        if (!($footer -match '^-- PostgreSQL database dump complete\s*$')) {
            throw 'The backup completion footer is missing.'
        }
        Move-Item -LiteralPath $partialFile -Destination $outputFile -ErrorAction Stop
        $promoted = $true
        # Retention runs only after a complete dump has been atomically published.
        if ($RetentionHours -gt 0) {
            Get-ChildItem -LiteralPath $BackupDir -Filter '*.sql' -File |
                Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-$RetentionHours) } |
                ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop }
        }
        return $outputFile
    } finally {
        $ErrorActionPreference = 'Stop'
        foreach ($name in $savedEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
        if (!$promoted -and (Test-Path -LiteralPath $partialFile)) {
            Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
        }
    }
}
