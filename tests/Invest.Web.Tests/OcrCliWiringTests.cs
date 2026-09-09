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
    public void Worker收到喚醒後並行排空佇列且待命不輪詢()
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
        Assert.Contains("ClaimAndProcessJobsAsync(api, agentStates, options, dispatchState, cancellationToken)", worker, StringComparison.Ordinal);
        Assert.Contains("var job = await api.ClaimAsync(cancellationToken);", worker, StringComparison.Ordinal);
        Assert.Contains("await ProcessJobAsync(api, job, agentStates, options, cancellationToken);", worker, StringComparison.Ordinal);
        Assert.Contains("public async Task RunWakeListenerAsync(", api, StringComparison.Ordinal);
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
