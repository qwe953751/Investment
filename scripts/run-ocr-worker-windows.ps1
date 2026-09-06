param(
    [switch] $Once
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$publishDirectory = if ([string]::IsNullOrWhiteSpace($env:OCR_WORKER_PUBLISH_DIR)) {
    Join-Path $repoRoot 'publish\ocr-worker-win-x64'
}
else {
    $env:OCR_WORKER_PUBLISH_DIR
}
$workerExecutable = Join-Path $publishDirectory 'Invest.Web.exe'

if (Test-Path -LiteralPath $workerExecutable -PathType Leaf) {
    $workerArgs = @('ocr-worker')
    if ($Once) { $workerArgs += '--once' }
    $exitCode = 1
    Push-Location $publishDirectory
    try {
        & $workerExecutable @workerArgs
        $exitCode = $LASTEXITCODE
    }
    finally { Pop-Location }
    if ($exitCode -ne 0) { exit $exitCode }
    exit 0
}

# 只保留給開發／一次性診斷使用；正式排程直接啟動自包含 EXE，不會走這條路。
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$dotnetPath = $env:OCR_DOTNET_PATH
if ([string]::IsNullOrWhiteSpace($dotnetPath)) {
    $userDotnetPath = Join-Path $localAppData 'Microsoft\dotnet\dotnet.exe'
    $dotnetPath = if (Test-Path -LiteralPath $userDotnetPath -PathType Leaf) { $userDotnetPath }
    else {
        $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($null -eq $dotnetCommand) { throw '找不到 .NET SDK；請先執行 publish-ocr-worker-windows.ps1。' }
        $dotnetCommand.Source
    }
}

$dotnetVersion = (& $dotnetPath --version).Trim()
if (-not $dotnetVersion.StartsWith('10.')) { throw "ocr-worker 只能用 .NET 10；目前是 $dotnetVersion。" }
$workerArgs = @('run', '--project', 'src/Invest.Web', '-c', 'Release', '--', 'ocr-worker')
if ($Once) { $workerArgs += '--once' }
Push-Location $repoRoot
try {
    & $dotnetPath @workerArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally { Pop-Location }
