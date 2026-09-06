param(
    [switch] $Once
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workerEmail = if ($env:OCR_WORKER_EMAIL) { $env:OCR_WORKER_EMAIL } else { 'ocr-worker@investment.local' }

if (-not (Get-Command Get-Secret -ErrorAction SilentlyContinue)) {
    throw '請先安裝並註冊 Microsoft.PowerShell.SecretManagement vault，再以名稱 InvestOcrWorkerPassword 保存 Worker 密碼。'
}

$dotnetVersion = (& dotnet --version).Trim()
if (-not $dotnetVersion.StartsWith('10.')) {
    throw "ocr-worker 只能用 .NET 10；目前是 $dotnetVersion。"
}

$workerPassword = Get-Secret -Name 'InvestOcrWorkerPassword' -AsPlainText
if ([string]::IsNullOrWhiteSpace($workerPassword)) {
    throw 'Secret vault 找不到 InvestOcrWorkerPassword。'
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
        & dotnet @workerArgs
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
}
