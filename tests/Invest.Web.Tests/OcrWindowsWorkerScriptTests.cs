namespace Invest.Web.Tests;

public sealed class OcrWindowsWorkerScriptTests
{
    [Fact]
    public void Windows排程直接啟動自包含Exe而非常駐PowerShell()
    {
        var script = File.ReadAllText(Path.Combine(FindRepositoryRoot(), "scripts", "register-ocr-worker-task-windows.ps1"));

        Assert.Contains("New-ScheduledTaskAction -Execute $workerExecutable", script, StringComparison.Ordinal);
        Assert.Contains("-WorkingDirectory $PublishDirectory", script, StringComparison.Ordinal);
        Assert.DoesNotContain("-Execute 'powershell.exe'", script, StringComparison.OrdinalIgnoreCase);
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
