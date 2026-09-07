param(
    [switch] $Once,
    [string] $PublishDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$publishDirectory = if ([string]::IsNullOrWhiteSpace($PublishDirectory)) {
    if ([string]::IsNullOrWhiteSpace($env:OCR_WORKER_PUBLISH_DIR)) {
        Join-Path $repoRoot 'publish\ocr-worker-win-x64'
    }
    else {
        $env:OCR_WORKER_PUBLISH_DIR
    }
}
else {
    $PublishDirectory
}
$workerExecutable = Join-Path $publishDirectory 'Invest.Web.exe'

# 比照 scripts/run-ocr-worker-macos.sh：主要 Agent 固定 Codex，並盡量固定絕對路徑，
# 避免排程以 -NoProfile 啟動時的 PATH 差異讓心跳與實際執行看到不同的可執行檔。
if ([string]::IsNullOrWhiteSpace($env:OCR_AGENT_PRIMARY)) {
    $env:OCR_AGENT_PRIMARY = 'codex'
}
if ([string]::IsNullOrWhiteSpace($env:OCR_CODEX_PATH)) {
    $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
    if ($null -ne $codexCommand) {
        $env:OCR_CODEX_PATH = $codexCommand.Source
    }
}
if ([string]::IsNullOrWhiteSpace($env:OCR_CLAUDE_PATH)) {
    $claudeCommand = Get-Command claude -ErrorAction SilentlyContinue
    if ($null -ne $claudeCommand) {
        $env:OCR_CLAUDE_PATH = $claudeCommand.Source
    }
}
Write-Output "OCR_AGENT_PRIMARY=$($env:OCR_AGENT_PRIMARY)"
Write-Output "OCR_CODEX_PATH=$($env:OCR_CODEX_PATH)"
Write-Output "OCR_CLAUDE_PATH=$($env:OCR_CLAUDE_PATH)"

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

# 發布目錄有 EXE 時正式排程與一次性診斷都使用自包含 EXE；以下 fallback 只保留給開發／診斷。
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
