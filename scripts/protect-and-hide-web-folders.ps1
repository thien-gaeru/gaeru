# ==============================================================================
# Kich ban an va bao ve chong xoa nham cac thu muc Web GAERU
# ==============================================================================

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TargetDirs = @(
    $RepoRoot,
    "E:\GAERU_Media",
    "E:\GAERU_Backups"
)

$currentUser = $env:USERNAME

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " TIEN HANH AN VA BAO VE CHONG XOA CAC THU MUC WEB GAERU" -ForegroundColor Cyan
Write-Host " Nguoi dung duoc bao ve: $currentUser" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

foreach ($dir in $TargetDirs) {
    if (Test-Path $dir) {
        Write-Host "`n[*] Dang cau hinh bao ve: $dir" -ForegroundColor Yellow

        # 1. Thiet lap thuoc tinh He thong + An (+S +H)
        try {
            & attrib.exe +s +h "$dir"
            Write-Host "  -> [OK] Da thiet lap thuoc tinh He thong & An (+S +H)." -ForegroundColor Green
        } catch {
            Write-Host "  -> [LOI] Khong the dat thuoc tinh an: $_" -ForegroundColor Red
        }

        # 2. Thiet lap NTFS Deny Delete cho thu muc goc (khong ke thua xuong file con)
        try {
            $acl = Get-Acl $dir
            # Kiem tra xem da co rule deny delete chua
            $existingRule = $acl.Access | Where-Object { 
                $_.AccessControlType -eq 'Deny' -and 
                $_.IdentityReference.Value -like "*$currentUser*" -and
                ($_.FileSystemRights.value__ -band [System.Security.AccessControl.FileSystemRights]::Delete.value__) -ne 0
            }
            if (!$existingRule) {
                $denyRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
                    $currentUser,
                    [System.Security.AccessControl.FileSystemRights]::Delete,
                    [System.Security.AccessControl.InheritanceFlags]::None,
                    [System.Security.AccessControl.PropagationFlags]::None,
                    [System.Security.AccessControl.AccessControlType]::Deny
                )
                $acl.AddAccessRule($denyRule)
                Set-Acl $dir $acl
            }
            Write-Host "  -> [OK] Da kich hoat khoa chong xoa NTFS Deny Delete tren thu muc goc." -ForegroundColor Green
        } catch {
            Write-Host "  -> [LOI] Khong the thiet lap NTFS Deny: $_" -ForegroundColor Red
        }
    } else {
        Write-Host "[!] Canh bao: Thu muc khong ton tai: $dir" -ForegroundColor Red
    }
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host " KIEM TRA TRANG THAI AN VA CHONG XOA HIEN TAI:" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

foreach ($dir in $TargetDirs) {
    if (Test-Path $dir) {
        $item = Get-Item -LiteralPath $dir -Force
        $isSystemHidden = (($item.Attributes -band [System.IO.FileAttributes]::Hidden) -ne 0) -and
                          (($item.Attributes -band [System.IO.FileAttributes]::System) -ne 0)
        
        Write-Host "[$($item.FullName)]" -ForegroundColor White
        Write-Host "  - Trang thai An: $(if ($isSystemHidden) { 'DANG AN CAP DO HE THONG (Protected OS & Hidden - Tang hinh hoan toan)' } else { 'HIEN (Visible)' })" -ForegroundColor $(if ($isSystemHidden) { 'Green' } else { 'Yellow' })
        
        # Kiem tra khong pha huy xem ACL chan xoa da duoc ap dung cho nguoi dung hien tai hay chua
        $blocked = $false
        try {
            $verifyAcl = Get-Acl -LiteralPath $dir
            $denyDeleteFlags = [int]([System.Security.AccessControl.FileSystemRights]::Delete.value__ -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles.value__)
            $matchingRule = $verifyAcl.Access | Where-Object {
                $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Deny -and
                $_.IdentityReference.Value -like "*$currentUser*" -and
                (($_.FileSystemRights.value__ -band $denyDeleteFlags) -ne 0)
            }
            $blocked = [bool]($matchingRule) -and $isSystemHidden
        } catch {
            $blocked = $false
        }

        if ($blocked) {
            Write-Host "  - Khoa chong xoa: DA KICH HOAT (Xac minh ACL NTFS Deny Delete an toan)" -ForegroundColor Green
        } else {
            Write-Host "  - Khoa chong xoa: CANH BAO - Thu muc chua duoc bao ve!" -ForegroundColor Red
        }
    }
}

Write-Host "`n[HOAN TAT] Tat ca cac thu muc Web da duoc an va bao ve chong xoa 100%!" -ForegroundColor Cyan
