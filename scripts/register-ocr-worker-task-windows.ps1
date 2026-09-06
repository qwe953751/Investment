param(
    [switch] $Unregister,
    [string] $PublishDirectory
)

$ErrorActionPreference = 'Stop'
$taskName = 'Invest D+ OCR Worker'
$repoRoot = Split-Path -Parent $PSScriptRoot
$PublishDirectory = if ([string]::IsNullOrWhiteSpace($PublishDirectory)) {
    if ([string]::IsNullOrWhiteSpace($env:OCR_WORKER_PUBLISH_DIR)) {
        Join-Path $repoRoot 'publish\ocr-worker-win-x64'
    }
    else { $env:OCR_WORKER_PUBLISH_DIR }
}
else { $PublishDirectory }
$workerExecutable = Join-Path $PublishDirectory 'Invest.Web.exe'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw '找不到目前 Windows 使用者的 LocalApplicationData；不會建立 OCR Worker 排程。'
}

$credentialPath = Join-Path (Join-Path $localAppData 'Investment') 'ocr-worker-windows.credential.dpapi'

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output "已移除 $taskName；不會刪除目前 Windows 使用者的 DPAPI 憑證。"
    exit 0
}

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw '尚未準備 Windows OCR Worker 的 DPAPI 憑證；請先以 set-ocr-worker-windows-credential.ps1 建立。'
}
if (-not (Test-Path -LiteralPath $workerExecutable -PathType Leaf)) {
    throw "找不到已發布的 Worker：$workerExecutable；請先執行 publish-ocr-worker-windows.ps1。"
}

# 註冊時才執行 PowerShell；常駐期間工作排程直接啟動 EXE，關閉 PowerShell 視窗不會影響 Worker。
$action = New-ScheduledTaskAction -Execute $workerExecutable -Argument 'ocr-worker' -WorkingDirectory $PublishDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 9 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "已註冊並啟動 $taskName（使用者：$user；直接啟動 $workerExecutable；MultipleInstances=IgnoreNew）。"
