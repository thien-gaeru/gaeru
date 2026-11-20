[CmdletBinding()]
param(
    [string]$BackupDir = 'E:\GAERU_Backups\database_15m',
    [string]$EnvFile = '',
    [string]$PgDumpPath,
    [string]$Recipient = $env:GAERU_BACKUP_GPG_RECIPIENT
)

$ErrorActionPreference = 'Stop'
if (!$EnvFile) { $EnvFile = Join-Path (Split-Path -Parent $PSScriptRoot) '.env' }
try {
    . (Join-Path $PSScriptRoot 'database-backup.ps1')
    $backupFile = Invoke-GaeruDatabaseBackup -BackupDir $BackupDir -EnvFile $EnvFile -PgDumpPath $PgDumpPath -Recipient $Recipient -RetentionHours 48
    Write-Host "Da sao luu thanh cong tai: $backupFile"
} catch {
    Write-Error 'Sao luu that bai. Khong xoa ban sao luu cu. Kiem tra cau hinh va dung luong dia.' -ErrorAction Continue
    exit 1
}
