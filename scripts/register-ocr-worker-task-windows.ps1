param(
    [switch] $Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'Invest D+ OCR Worker'
$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\run-ocr-worker-windows.ps1'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw '找不到目前 Windows 使用者的 LocalApplicationData；不會建立 OCR Worker 排程。'
}

$credentialPath = Join-Path (Join-Path $localAppData 'Investment') 'ocr-worker-windows.credential.clixml'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "已移除 $taskName；不會刪除目前 Windows 使用者的 DPAPI 憑證。"
    exit 0
}

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw '尚未準備 Windows OCR Worker 的 DPAPI 憑證；不會建立無法啟動的 OCR Worker 排程。'
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "已註冊並啟動 $taskName（使用者：$user；MultipleInstances=IgnoreNew）。"
