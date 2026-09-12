namespace Invest.Web.Tests;

public sealed class OcrCliWiringTests
{
    [Fact]
    public void 健康檢查與實際Runner共用相同Cli路徑解析器()
    {
        var root = FindRepositoryRoot();
        var program = File.ReadAllText(Path.Combine(root, "src", "Invest.Web", "Program.cs"))
            .ReplaceLineEndings("\n");
        var worker = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Invest.Web",
            "Features",
            "Assets",
            "Ocr",
            "Services",
            "OcrWorkerRunner.cs"));

        Assert.Contains(
            "builder.Services.AddSingleton(_ => new ClaudeCodeCliRunner(\n    OcrAgentExecutableResolver.Resolve(OcrAgentKind.Claude))",
            program,
            StringComparison.Ordinal);
        Assert.Contains(
            "builder.Services.AddSingleton(_ => new CodexCliRunner(\n    OcrAgentExecutableResolver.Resolve(OcrAgentKind.Codex))",
            program,
            StringComparison.Ordinal);
        Assert.Contains(
            "OcrAgentExecutableResolver.Resolve(OcrAgentKind.Claude)",
            worker,
            StringComparison.Ordinal);
        Assert.Contains(
            "OcrAgentExecutableResolver.Resolve(OcrAgentKind.Codex)",
            worker,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Worker常駐槽持續平行運作不因單槽落空而提早結束()
    {
        var root = FindRepositoryRoot();
        var worker = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Invest.Web",
            "Features",
            "Assets",
            "Ocr",
            "Services",
            "OcrWorkerRunner.cs"));

        var api = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Invest.Web",
            "Features",
            "Assets",
            "Ocr",
            "Services",
            "OcrWorkerApiClient.cs"));

        Assert.Contains("WorkerHeartbeatInterval = TimeSpan.FromSeconds(60)", worker, StringComparison.Ordinal);
        Assert.Contains("RunWakeListenerAsync(", worker, StringComparison.Ordinal);
        Assert.Contains("var delay = wasAvailable ? WorkerHeartbeatInterval : WorkerHeartbeatRecoveryPollInterval;", worker, StringComparison.Ordinal);
        Assert.Contains("Enumerable.Range(0, options.MaxConcurrency)", worker, StringComparison.Ordinal);
        Assert.Contains(".Select(_ => RunSlotAsync(api, options, wakeSignals.Reader, workerCancellation.Token))", worker, StringComparison.Ordinal);
        Assert.Contains("var job = await api.ClaimAsync(cancellationToken);", worker, StringComparison.Ordinal);
        Assert.Contains("await ProcessJobAsync(api, job, _agentStates, options, cancellationToken);", worker, StringComparison.Ordinal);
        // 2026-09-12 修正的根因：舊版每個槽 claim 落空就直接 return，槽因此永久死掉；
        // 槽必須改成落空時等喚醒信號再繼續迴圈，才不會讓新工作卡在沒有槽可接的窘境。
        Assert.Contains("await WaitForWakeAsync(wakeReader, cancellationToken);", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("ClaimAndProcessJobsAsync", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.Delay(options.PollInterval, cancellationToken)", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void Agent探測失敗會在五秒內重試不會被單次抖動判定離線()
    {
        var root = FindRepositoryRoot();
        var worker = File.ReadAllText(Path.Combine(
            root,
            "src",
            "Invest.Web",
            "Features",
            "Assets",
            "Ocr",
            "Services",
            "OcrWorkerRunner.cs"));

        // 2026-09-12 根因：探測 CLI 登入狀態只跑一次，網路瞬斷等暫時性錯誤會被直接當成
        // 「未登入」寫進心跳快照，讓整批上傳在那 60 秒窗口內全部誤判為沒有可用 Agent、
        // 靜默改走 Tesseract；查證當下 Worker／Codex 其實都正常。改成 5 秒內最多重試
        // 5 次，任何一次判定已登入就採用，只有真的連續失敗才回報不可用。
        Assert.Contains("private const int ProbeRetryAttempts = 5;", worker, StringComparison.Ordinal);
        Assert.Contains("ProbeRetryDelay = TimeSpan.FromSeconds(1);", worker, StringComparison.Ordinal);
        Assert.Contains("private static async Task<OcrWorkerAgentState> ProbeWithRetryAsync(", worker, StringComparison.Ordinal);
        Assert.Contains("if (result.Authenticated || !result.Installed)", worker, StringComparison.Ordinal);
        Assert.Contains("await ProbeWithRetryAsync(", worker, StringComparison.Ordinal);
        // 探測快取原本會讓「探測更頻繁」的復原機制形同虛設（快取命中時不會真的重探）；
        // 現在只有 MaintainHeartbeatAsync 這一個呼叫端，快取已無意義且會妨礙快速復原偵測。
        Assert.DoesNotContain("_probeCache", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("ProbeCacheTtl", worker, StringComparison.Ordinal);
        // 沒有可用 Agent 時改用較短的心跳間隔加速重新探測，不必等到下一個完整 60 秒週期
        // 才發現額度／登入已經復原。
        Assert.Contains("WorkerHeartbeatRecoveryPollInterval = TimeSpan.FromSeconds(10);", worker, StringComparison.Ordinal);
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

        throw new InvalidOperationException("找不到 Invest.sln，無法驗證 OCR CLI 接線。");
    }
}
