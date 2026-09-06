param(
    [Parameter(Mandatory)]
    [System.Management.Automation.PSCredential] $Credential
)

$ErrorActionPreference = 'Stop'
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw '找不到目前 Windows 使用者的 LocalApplicationData；不會建立 OCR Worker 憑證。'
}

$credentialDirectory = Join-Path $localAppData 'Investment'
$credentialPath = Join-Path $credentialDirectory 'ocr-worker-windows.credential.dpapi'
$workerPassword = $Credential.GetNetworkCredential().Password

try {
    if ([string]::IsNullOrWhiteSpace($Credential.UserName) -or [string]::IsNullOrWhiteSpace($workerPassword)) {
        throw 'Windows OCR Worker 憑證必須包含帳號與密碼。'
    }

    New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
    $payload = [ordered]@{
        email = $Credential.UserName
        password = $workerPassword
    } | ConvertTo-Json -Compress
    $clearBytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
        $clearBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [IO.File]::WriteAllText($credentialPath, [Convert]::ToBase64String($protectedBytes), [Text.Encoding]::ASCII)
    Write-Output '已在目前 Windows 使用者的 DPAPI 保護區建立 OCR Worker 憑證（.dpapi）。'
}
finally {
    $payload = $null
    $clearBytes = $null
    $protectedBytes = $null
    $workerPassword = $null
}
