using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrAgentQuotaRouterTests
{
    private static readonly OcrAgentRequest Request = new(
        "/tmp/image.png",
        "extract",
        "/tmp/schema.json",
        "/tmp");

    [Fact]
    public async Task 主要Agent額度不足時會自動改跑另一個Agent()
    {
        var claude = new FakeRunner(
            OcrAgentKind.Claude,
            Result(OcrAgentKind.Claude, OcrAgentRunStatus.QuotaExhausted, "quota_exhausted"));
        var codex = new FakeRunner(
            OcrAgentKind.Codex,
            Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: "{}"));
        var router = CreateRouter(claude, codex);

        var execution = await router.RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Equal(OcrAgentKind.Codex, execution.Agent);
        Assert.True(execution.UsedFallback);
        Assert.Single(claude.Requests);
        Assert.Single(codex.Requests);
    }

    [Fact]
    public async Task 兩個Agent額度都不足時丟出專用例外()
    {
        var claude = new FakeRunner(
            OcrAgentKind.Claude,
            Result(OcrAgentKind.Claude, OcrAgentRunStatus.QuotaExhausted, "claude_quota"));
        var codex = new FakeRunner(
            OcrAgentKind.Codex,
            Result(OcrAgentKind.Codex, OcrAgentRunStatus.QuotaExhausted, "codex_quota"));
        var router = CreateRouter(claude, codex);

        var exception = await Assert.ThrowsAsync<OcrAllAgentsQuotaExhaustedException>(
            () => router.RunPassAsync(OcrPassKind.Extraction, Request));

        Assert.Equal(OcrPassKind.Extraction, exception.Pass);
        Assert.Equal("claude_quota", exception.Reasons[OcrAgentKind.Claude]);
        Assert.Equal("codex_quota", exception.Reasons[OcrAgentKind.Codex]);
    }

    [Fact]
    public async Task 稽核遍預設先用另一個Agent交叉檢查()
    {
        var claude = new FakeRunner(
            OcrAgentKind.Claude,
            Result(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output: "claude"));
        var codex = new FakeRunner(
            OcrAgentKind.Codex,
            Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: "codex"));
        var router = CreateRouter(claude, codex);

        var execution = await router.RunPassAsync(OcrPassKind.Audit, Request);

        Assert.Equal(OcrAgentKind.Codex, execution.Agent);
        Assert.Empty(claude.Requests);
        Assert.Single(codex.Requests);
    }

    [Fact]
    public async Task 非額度錯誤不會被當成額度而盲目切換()
    {
        var claude = new FakeRunner(
            OcrAgentKind.Claude,
            Result(OcrAgentKind.Claude, OcrAgentRunStatus.TransientFailure, "timeout"));
        var codex = new FakeRunner(
            OcrAgentKind.Codex,
            Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: "codex"));
        var router = CreateRouter(claude, codex);

        var execution = await router.RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Equal(OcrAgentRunStatus.TransientFailure, execution.Result.Status);
        Assert.Empty(codex.Requests);
    }

    [Fact]
    public async Task 已完成擷取checkpoint時額度恢復後只續跑稽核()
    {
        var claude = new FakeRunner(
            OcrAgentKind.Claude,
            Result(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output: "extraction"),
            Result(OcrAgentKind.Claude, OcrAgentRunStatus.QuotaExhausted, "claude_quota"),
            Result(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output: "audit"));
        var codex = new FakeRunner(
            OcrAgentKind.Codex,
            Result(OcrAgentKind.Codex, OcrAgentRunStatus.QuotaExhausted, "codex_quota"),
            Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: "audit-after-reset"));
        var router = CreateRouter(claude, codex);
        var checkpoints = new InMemoryOcrPassCheckpointStore();
        var orchestrator = new AiOcrOrchestrator(router, checkpoints);

        await Assert.ThrowsAsync<OcrAllAgentsQuotaExhaustedException>(
            () => orchestrator.RecognizeAsync(Request, Request));

        var result = await orchestrator.RecognizeAsync(Request, Request);

        Assert.Equal(OcrAgentKind.Claude, result.Extraction.Agent);
        Assert.Equal(OcrAgentKind.Codex, result.Audit.Agent);
        Assert.Equal(2, claude.Requests.Count);
        Assert.Equal(2, codex.Requests.Count);
    }

    private static AgentQuotaRouter CreateRouter(
        params IAgentCliRunner[] runners)
        => new(
            runners,
            new OcrAgentRouterOptions(
                PrimaryAgent: OcrAgentKind.Claude,
                QuotaCooldown: TimeSpan.Zero,
                TimeProvider: TimeProvider.System,
                ClaudeModel: "claude-test",
                CodexModel: "codex-test"));

    private static OcrAgentRunResult Result(
        OcrAgentKind agent,
        OcrAgentRunStatus status,
        string? errorCode = null,
        string? output = null)
        => new(
            agent,
            status,
            output,
            errorCode,
            null,
            status == OcrAgentRunStatus.Success ? 0 : 1,
            TimeSpan.FromMilliseconds(1));

    private sealed class FakeRunner(
        OcrAgentKind agent,
        params OcrAgentRunResult[] results)
        : IAgentCliRunner
    {
        private readonly Queue<OcrAgentRunResult> _results = new(results);

        public OcrAgentKind Agent { get; } = agent;

        public List<OcrAgentRequest> Requests { get; } = [];

        public Task<OcrAgentRunResult> RunAsync(
            OcrAgentRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests.Add(request);
            if (_results.Count == 0)
            {
                throw new InvalidOperationException($"FakeRunner {Agent} 沒有預期結果。");
            }

            return Task.FromResult(_results.Dequeue());
        }
    }
}
