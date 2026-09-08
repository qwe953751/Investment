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
    public void Worker忙碌時持續回報心跳並在完成後補取下一張()
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

        Assert.Contains("BusyHeartbeatInterval = TimeSpan.FromSeconds(10)", worker, StringComparison.Ordinal);
        Assert.Contains("MaintainHeartbeatAsync(api, agentStates, heartbeatCancellation.Token)", worker, StringComparison.Ordinal);
        Assert.Contains("Enumerable.Range(0, options.MaxConcurrency)", worker, StringComparison.Ordinal);
        Assert.Contains("ClaimAndProcessJobsAsync(api, agentStates, options, dispatchState, cancellationToken)", worker, StringComparison.Ordinal);
        Assert.Contains("var job = await api.ClaimAsync(cancellationToken);", worker, StringComparison.Ordinal);
        Assert.Contains("await ProcessJobAsync(api, job, agentStates, options, cancellationToken);", worker, StringComparison.Ordinal);
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
