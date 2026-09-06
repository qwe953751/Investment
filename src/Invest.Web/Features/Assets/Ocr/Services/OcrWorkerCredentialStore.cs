using System.Security.Cryptography;
using System.Text.Json;

namespace Invest.Web.Features.Assets.Ocr.Services;

/// <summary>
/// Windows 工作排程直接啟動自包含 Worker 時，從目前使用者的 DPAPI 檔案讀取
/// Supabase Worker 憑證。解密只在記憶體內進行，不把密碼放到命令列或長期環境變數。
/// </summary>
public static class OcrWorkerCredentialStore
{
    private const string DefaultFileName = "ocr-worker-windows.credential.dpapi";

    public static string DefaultPath
        => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Investment",
            DefaultFileName);

    public static OcrWorkerCredentials? TryLoad()
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        var path = Environment.GetEnvironmentVariable("OCR_WORKER_CREDENTIAL_PATH");
        if (string.IsNullOrWhiteSpace(path))
        {
            path = DefaultPath;
        }

        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var protectedBytes = Convert.FromBase64String(File.ReadAllText(path).Trim());
            var clearBytes = ProtectedData.Unprotect(
                protectedBytes,
                optionalEntropy: null,
                DataProtectionScope.CurrentUser);
            // set-ocr-worker-windows-credential.ps1 writes lower-case JSON keys.
            // Keep the reader compatible with that PowerShell payload even though the
            // C# record uses PascalCase property names.
            var credentials = JsonSerializer.Deserialize<OcrWorkerCredentials>(
                clearBytes,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (credentials is null
                || string.IsNullOrWhiteSpace(credentials.Email)
                || string.IsNullOrWhiteSpace(credentials.Password))
            {
                throw new InvalidOperationException("credential_payload_empty");
            }

            return credentials;
        }
        catch (Exception exception) when (exception is FormatException
            or CryptographicException
            or JsonException
            or IOException
            or UnauthorizedAccessException
            or InvalidOperationException)
        {
            throw new InvalidOperationException(
                "Windows OCR Worker 的 DPAPI 憑證無法解密；請以 set-ocr-worker-windows-credential.ps1 重新建立。",
                exception);
        }
    }
}

public sealed record OcrWorkerCredentials(string Email, string Password);
