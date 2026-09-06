param(
    [switch] $Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'Invest D+ OCR Worker'
$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\run-ocr-worker-windows.ps1'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "已移除 $taskName；不會刪除 SecretManagement 密碼。"
    exit 0
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType InteractiveToken -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "已註冊並啟動 $taskName（使用者：$user；MultipleInstances=IgnoreNew）。"
