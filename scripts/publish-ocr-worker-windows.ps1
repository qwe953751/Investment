param(
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'publish\ocr-worker-win-x64'
}

$dotnetPath = $env:OCR_DOTNET_PATH
if ([string]::IsNullOrWhiteSpace($dotnetPath)) {
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $userDotnetPath = Join-Path $localAppData 'Microsoft\dotnet\dotnet.exe'
    $dotnetPath = if (Test-Path -LiteralPath $userDotnetPath -PathType Leaf) { $userDotnetPath }
    else {
        $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
        if ($null -eq $dotnetCommand) { throw '找不到 .NET SDK；請安裝 .NET 10 或設定 OCR_DOTNET_PATH。' }
        $dotnetCommand.Source
    }
}

$dotnetVersion = (& $dotnetPath --version).Trim()
if (-not $dotnetVersion.StartsWith('10.')) {
    throw "Worker 只能用 .NET 10；目前是 $dotnetVersion。"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Push-Location $repoRoot
try {
    & $dotnetPath publish 'src\Invest.Web\Invest.Web.csproj' -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $OutputDirectory
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish 失敗（exit code $LASTEXITCODE）。" }
}
finally { Pop-Location }

Write-Output "Windows D+ OCR Worker 已發布：$(Join-Path $OutputDirectory 'Invest.Web.exe')"
