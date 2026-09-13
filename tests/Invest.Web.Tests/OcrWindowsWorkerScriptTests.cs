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
        // 2026-09-13 治本一重構：Windows 優先／其他 Worker 備援的分流邏輯本來就在
        // db/049_ocr_agent_relay.sql 的 ocr_claim_job()／ocr_relay_agent_failure()
        // 這兩個 SQL RPC 裡（不是 edge function 裡一個從未被 claim 流程呼叫的
        // latestWorker() —— 那個函式只用於 readiness/submit 的存在性檢查，
        // 已經在本次重構中刪除，改用 checkAvailableWorkers() 這個單一判定入口）。
        // db/054 重新定義了這兩個 RPC，把寫死的 120 秒門檻換成 ocr_worker_alive()，
        // 分流語意完全不變，故驗證對象改成 054（PostgreSQL create or replace 後
        // 實際生效的版本）。
        var source = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(),
            "db",
            "054_ocr_worker_availability.sql"));

        Assert.Contains("create or replace function ocr_claim_job(", source, StringComparison.Ordinal);
        Assert.Contains("v_is_windows := coalesce(v_worker_platform, '') ilike '%windows%';", source, StringComparison.Ordinal);
        Assert.Contains("(v_is_windows and windows_attempt_failed_at is null)", source, StringComparison.Ordinal);
        Assert.Contains("(not v_is_windows and (windows_attempt_failed_at is not null or not v_other_fresh))", source, StringComparison.Ordinal);
        Assert.Contains("create or replace function ocr_relay_agent_failure(", source, StringComparison.Ordinal);
        Assert.Contains("public.ocr_worker_alive(w)", source, StringComparison.Ordinal);
        // 舊的寫死 120 秒門檻不應該還留在這兩個函式裡，否則又長出一份不同步的判定。
        Assert.DoesNotContain("w.last_heartbeat_at > now() - interval '120 seconds'", source, StringComparison.Ordinal);
    }

    [Fact]
    public void OCR可用性判定收斂成單一真相來源()
    {
        // readinessHeartbeatAgeMs 的 Number(null)=0 被 clamp 成 15 秒是 2026-09-13
        // 事故的根因（Worker 心跳週期 67 秒，15/67≈22% 命中率）。這個函式與
        // handleSubmit 各自維護一份門檻常數的舊實作已刪除，兩者都改呼叫
        // checkAvailableWorkers()，保證不可能互相矛盾。
        var edgeFunctionSource = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "supabase", "functions", "ocr-jobs", "index.js"));

        // 只檢查函式定義本身不存在；程式裡保留一句說明性註解交代「這個函式曾經
        // 存在、已被刪除、為什麼」是合理的維護紀錄，不該被這個斷言擋下來。
        Assert.DoesNotContain("function readinessHeartbeatAgeMs(", edgeFunctionSource, StringComparison.Ordinal);
        Assert.DoesNotContain("function latestWorker(", edgeFunctionSource, StringComparison.Ordinal);
        Assert.Contains("async function checkAvailableWorkers()", edgeFunctionSource, StringComparison.Ordinal);
        // handleReadiness／handleSubmit 都必須呼叫 checkAvailableWorkers()；
        // 用出現次數把關，確保兩者共用同一入口而不是各自重新實作一份判定
        // （這正是本次事故「五處判定各自為政」的結構性根因）。
        var callSiteCount = CountOccurrences(edgeFunctionSource, "await checkAvailableWorkers()");
        Assert.True(callSiteCount >= 2, $"預期至少 2 處呼叫 checkAvailableWorkers()（handleReadiness 與 handleSubmit），實際 {callSiteCount} 處。");

        var migrationSource = File.ReadAllText(Path.Combine(
            FindRepositoryRoot(), "db", "054_ocr_worker_availability.sql"));

        Assert.Contains("create or replace function public.ocr_worker_alive(w public.ocr_workers)", migrationSource, StringComparison.Ordinal);
        Assert.Contains("create or replace function public.ocr_stall_to_fallback(", migrationSource, StringComparison.Ordinal);
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
