using System.Security.Cryptography;
using System.Text;
using Invest.Web.Features.Assets.Ocr.Services;

namespace Invest.Web.Tests;

public sealed class OcrWindowsWorkerScriptTests
{
    [Fact]
    public void Windows排程使用隱藏啟動器並週期補啟動()
    {
        var script = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "scripts", "register-ocr-worker-task-windows.ps1"));

        Assert.Contains("New-ScheduledTaskAction -Execute 'powershell.exe'", script, StringComparison.Ordinal);
        Assert.Contains("-WindowStyle Hidden", script, StringComparison.Ordinal);
        Assert.Contains("run-ocr-worker-windows.ps1", script, StringComparison.Ordinal);
        Assert.Contains("-PublishDirectory", script, StringComparison.Ordinal);
        Assert.Contains("-WorkingDirectory $PublishDirectory", script, StringComparison.Ordinal);
        Assert.Contains("New-ScheduledTaskTrigger -Once", script, StringComparison.Ordinal);
        Assert.Contains("-RepetitionInterval (New-TimeSpan -Minutes 2)", script, StringComparison.Ordinal);
        Assert.DoesNotContain("-RepetitionDuration", script, StringComparison.Ordinal);
        Assert.Contains("-MultipleInstances IgnoreNew", script, StringComparison.Ordinal);
        Assert.DoesNotContain("New-ScheduledTaskAction -Execute $workerExecutable", script, StringComparison.Ordinal);
        Assert.Contains("ocr-worker-windows.credential.dpapi", script, StringComparison.Ordinal);
    }

    [Fact]
    public void WindowsCredentialStore使用目前使用者DPAPI()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "src",
            "Invest.Web",
            "Features",
            "Assets",
            "Ocr",
            "Services",
            "OcrWorkerCredentialStore.cs"));

        Assert.Contains("DataProtectionScope.CurrentUser", source, StringComparison.Ordinal);
        Assert.Contains("ProtectedData.Unprotect", source, StringComparison.Ordinal);
    }

    [Fact]
    public void WindowsCredentialStore接受PowerShell的小寫JSON欄位()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var path = Path.Combine(Path.GetTempPath(), $"investment-ocr-credential-{Guid.NewGuid():N}.dpapi");
        var previousPath = Environment.GetEnvironmentVariable("OCR_WORKER_CREDENTIAL_PATH");
        var clearBytes = Encoding.UTF8.GetBytes("{\"email\":\"worker@example.invalid\",\"password\":\"fixture-only\"}");
        var protectedBytes = ProtectedData.Protect(
            clearBytes,
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);

        try
        {
            File.WriteAllText(path, Convert.ToBase64String(protectedBytes), Encoding.ASCII);
            Environment.SetEnvironmentVariable("OCR_WORKER_CREDENTIAL_PATH", path);

            var credentials = OcrWorkerCredentialStore.TryLoad();

            Assert.NotNull(credentials);
            Assert.Equal("worker@example.invalid", credentials.Email);
            Assert.Equal("fixture-only", credentials.Password);
        }
        finally
        {
            Environment.SetEnvironmentVariable("OCR_WORKER_CREDENTIAL_PATH", previousPath);
            File.Delete(path);
        }
    }

    [Fact]
    public void Windows一次性腳本從發布目錄啟動自包含Exe()
    {
        var script = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "scripts", "run-ocr-worker-windows.ps1"));

        Assert.Contains("[string] $PublishDirectory", script, StringComparison.Ordinal);
        Assert.Contains("Push-Location $publishDirectory", script, StringComparison.Ordinal);
        Assert.Contains("& $workerExecutable @workerArgs", script, StringComparison.Ordinal);
        Assert.Contains("Pop-Location", script, StringComparison.Ordinal);
    }

    [Fact]
    public void OCR佇列以新鮮WindowsWorker為預設並保留其他Worker備援()
    {
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "supabase",
            "functions",
            "ocr-jobs",
            "index.js"));

        Assert.Contains("async function latestWorker(maxHeartbeatAgeMs = MAX_HEARTBEAT_AGE_MS)", source, StringComparison.Ordinal);
        Assert.Contains("&order=last_heartbeat_at.desc&limit=20", source, StringComparison.Ordinal);
        Assert.Contains("const preferredWindows = workers.find(worker =>", source, StringComparison.Ordinal);
        Assert.Contains("isWindowsWorker(worker) && workerIsFresh(worker, maxHeartbeatAgeMs)", source, StringComparison.Ordinal);
        Assert.Contains("return preferredWindows ?? workers[0] ?? null;", source, StringComparison.Ordinal);
        Assert.Contains("workerPlatform:", source, StringComparison.Ordinal);
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Invest.sln")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 Windows Worker 腳本。");
    }
}
