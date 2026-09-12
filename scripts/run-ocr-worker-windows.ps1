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
if ([string]::IsNullOrWhiteSpace($env:OCR_MAX_REASONING_EFFORT)) {
    $env:OCR_MAX_REASONING_EFFORT = 'max'
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
Write-Output "OCR_MAX_REASONING_EFFORT=$($env:OCR_MAX_REASONING_EFFORT)"
Write-Output "OCR_CODEX_PATH=$($env:OCR_CODEX_PATH)"
Write-Output "OCR_CLAUDE_PATH=$($env:OCR_CLAUDE_PATH)"

if (Test-Path -LiteralPath $workerExecutable -PathType Leaf) {
    $workerArgs = @('ocr-worker')
    if ($Once) { $workerArgs += '--once' }

    if ($Once) {
        # 診斷用途：手動在互動式終端機執行，維持原本直接印在畫面上，不寫 log 檔。
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

    # 常駐排程用途：排程以 -WindowStyle Hidden 執行，stdout/stderr 原本沒有導向任何地方，
    # 2026-09-12 一次「AI 明明正常卻整批走 Tesseract」的事故就是因為完全沒有 log 可查，
    # 只能事後用 Supabase 資料反推。改用 Start-Process 分別導向兩個檔案，避免 PowerShell
    # 5.1 對原生程式 stderr 用 2>&1 時會把每行包成 NativeCommandError 的已知問題。
    # 一次啟動對應一組檔案（而非同一檔案持續 append），保留最近 30 天，長期常駐不會無限累積。
    $logDirectory = Join-Path $repoRoot 'logs'
    if (-not (Test-Path -LiteralPath $logDirectory)) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $logDirectory -Filter 'ocr-worker-*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    $runTimestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $logDirectory "ocr-worker-$runTimestamp.out.log"
    $stderrLog = Join-Path $logDirectory "ocr-worker-$runTimestamp.err.log"
    Write-Output "常駐輸出導向：$stdoutLog"

    $process = Start-Process -FilePath $workerExecutable -ArgumentList $workerArgs `
        -WorkingDirectory $publishDirectory -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    if ($process.ExitCode -ne 0) { exit $process.ExitCode }
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
