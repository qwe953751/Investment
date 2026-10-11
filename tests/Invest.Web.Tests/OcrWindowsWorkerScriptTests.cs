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
    public void OCR佇列以Windows為預設Mac只拿已標記略過Windows的工作()
    {
        // 平台分流在 SQL RPC 裡。2026-10-11 起 db/062 重新定義 ocr_claim_job()／ocr_relay_agent_failure()：
        // 不再用 ocr_worker_alive() 猜 Windows／Mac 是否在線，改由 Edge 指名詢問後在工作上明確標記
        // （windows_attempt_failed_at），所以驗證對象是 PostgreSQL create or replace 後實際生效的 062。
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "db",
            "062_ocr_worker_probe.sql")).ReplaceLineEndings("\n");

        Assert.Contains("create or replace function ocr_claim_job(", source, StringComparison.Ordinal);
        Assert.Contains("v_is_windows := coalesce(v_worker_platform, '') ilike '%windows%';", source, StringComparison.Ordinal);
        Assert.Contains("(v_is_windows and windows_attempt_failed_at is null)", source, StringComparison.Ordinal);
        Assert.Contains("(not v_is_windows and windows_attempt_failed_at is not null)", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function ocr_relay_agent_failure(", source, StringComparison.Ordinal);
        Assert.DoesNotContain("v_other_fresh", source, StringComparison.Ordinal);
        Assert.DoesNotContain("public.ocr_worker_alive(w)", source, StringComparison.Ordinal);
        // 舊的寫死 120 秒門檻不應該回來。
        Assert.DoesNotContain("w.last_heartbeat_at > now() - interval '120 seconds'", source, StringComparison.Ordinal);
    }

    [Fact]
    public void OCR在線判定只有指名詢問一個入口()
    {
        // readinessHeartbeatAgeMs 的 Number(null)=0 被 clamp 成 15 秒是 2026-09-13 事故的根因；
        // 之後的旗標加時間退路仍是「猜」。現在 readiness 只呼叫 selectTarget()（先問 Windows 後問 Mac），
        // submit 只讀 readiness 的路由決定，批次中與 relay 各自指名詢問負責的機器。
        var edgeFunctionSource = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "supabase", "functions", "ocr-jobs", "index.js")).ReplaceLineEndings("\n");

        Assert.DoesNotContain("function readinessHeartbeatAgeMs(", edgeFunctionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("function latestWorker(", edgeFunctionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("function checkAvailableWorkers(", edgeFunctionSource, StringComparison.Ordinal);
        Assert.Contains("const selection = await selectTarget();", edgeFunctionSource, StringComparison.Ordinal);
        // 所有詢問都經過 probeWorker()：用出現次數把關，不允許別處另寫一份判定。
        var probeCallSites = CountOccurrences(edgeFunctionSource, "await probeWorker(")
            + CountOccurrences(edgeFunctionSource, "await probeOrBusy(");
        Assert.True(probeCallSites >= 4, $"預期 selectTarget、decideRoute、maintainJobRoute、handleRelay 都經過 probeWorker()／probeOrBusy()，實際 {probeCallSites} 處。");

        var migrationSource = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "db", "062_ocr_worker_probe.sql")).ReplaceLineEndings("\n");

        Assert.Contains("create or replace function public.ocr_begin_probe(", migrationSource, StringComparison.Ordinal);
        Assert.DoesNotContain("create or replace function public.ocr_stall_to_fallback(", migrationSource, StringComparison.Ordinal);
    }

    private static int CountOccurrences(string source, string needle)
    {
        var count = 0;
        var index = 0;
        while ((index = source.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
        {
            count += 1;
            index += needle.Length;
        }

        return count;
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
