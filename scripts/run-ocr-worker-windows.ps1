param(
    [switch] $Once
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw '找不到目前 Windows 使用者的 LocalApplicationData；不會啟動 OCR Worker。'
}

$credentialDirectory = Join-Path $localAppData 'Investment'
$credentialPath = Join-Path $credentialDirectory 'ocr-worker-windows.credential.clixml'

if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw '找不到 Windows OCR Worker 的 DPAPI 憑證；請先以 set-ocr-worker-windows-credential.ps1 建立。'
}

$dotnetPath = $env:OCR_DOTNET_PATH
if ([string]::IsNullOrWhiteSpace($dotnetPath)) {
    $userDotnetPath = Join-Path $localAppData 'Microsoft\dotnet\dotnet.exe'
    $dotnetPath = if (Test-Path -LiteralPath $userDotnetPath -PathType Leaf) {
        $userDotnetPath
    }
    else {
        $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($null -eq $dotnetCommand) {
            throw '找不到 .NET SDK；請安裝 .NET 10 或設定 OCR_DOTNET_PATH。'
        }

        $dotnetCommand.Source
    }
}

$dotnetVersion = (& $dotnetPath --version).Trim()
if (-not $dotnetVersion.StartsWith('10.')) {
    throw "ocr-worker 只能用 .NET 10；目前是 $dotnetVersion。"
}

$workerCredential = Import-Clixml -LiteralPath $credentialPath
if ($workerCredential -isnot [System.Management.Automation.PSCredential]) {
    throw 'Windows OCR Worker 憑證格式不正確；請重新建立 DPAPI 憑證。'
}

$workerEmail = $workerCredential.UserName
$workerPassword = $workerCredential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($workerEmail) -or [string]::IsNullOrWhiteSpace($workerPassword)) {
    throw 'Windows OCR Worker 憑證沒有可用的帳號或密碼；請重新建立 DPAPI 憑證。'
}

$previousPassword = $env:OCR_WORKER_PASSWORD
$previousEmail = $env:OCR_WORKER_EMAIL
try {
    $env:OCR_WORKER_EMAIL = $workerEmail
    $env:OCR_WORKER_PASSWORD = $workerPassword
    if (-not $env:OCR_AGENT_PRIMARY) { $env:OCR_AGENT_PRIMARY = 'codex' }

    $workerArgs = @('run', '--project', 'src/Invest.Web', '-c', 'Release', '--', 'ocr-worker')
    if ($Once) { $workerArgs += '--once' }

    Push-Location $repoRoot
    try {
        & $dotnetPath @workerArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:OCR_WORKER_PASSWORD = $previousPassword
    $env:OCR_WORKER_EMAIL = $previousEmail
    $workerPassword = $null
    $workerCredential = $null
}
