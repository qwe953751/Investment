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
        Assert.Contains("await Task.Delay(WorkerHeartbeatInterval, cancellationToken)", worker, StringComparison.Ordinal);
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
