using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrAgentQuotaRouterTests
{
    private static readonly OcrAgentRequest Request = new("/tmp/image.png", "extract", "/tmp/schema.json", "/tmp");

    [Fact]
    public async Task 主要Agent額度不足時會自動改跑另一個Agent並套用固定設定()
    {
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.QuotaExhausted, "quota_exhausted"));
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: "{}"));
        var execution = await CreateRouter(claude, codex).RunPassAsync(OcrPassKind.Extraction, Request);
        Assert.Equal(OcrAgentKind.Codex, execution.Agent);
        Assert.True(execution.UsedFallback);
        Assert.Equal("codex-test", Assert.Single(codex.Requests).Model);
        Assert.Equal("max", codex.Requests[0].ReasoningEffort);
        Assert.Equal("priority", codex.Requests[0].ServiceTier);
    }

    [Fact]
    public async Task 兩個Agent額度都不足時丟出專用例外()
    {
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.QuotaExhausted, "claude_quota"));
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.QuotaExhausted, "codex_quota"));
        var exception = await Assert.ThrowsAsync<OcrAllAgentsQuotaExhaustedException>(() => CreateRouter(claude, codex).RunPassAsync(OcrPassKind.Extraction, Request));
        Assert.Equal("claude_quota", exception.Reasons[OcrAgentKind.Claude]);
        Assert.Equal("codex_quota", exception.Reasons[OcrAgentKind.Codex]);
    }

    [Fact]
    public async Task 非額度錯誤不會被當成額度而盲目切換()
    {
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.TransientFailure, "timeout"));
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: "codex"));
        var execution = await CreateRouter(claude, codex).RunPassAsync(OcrPassKind.Extraction, Request);
        Assert.Equal(OcrAgentRunStatus.TransientFailure, execution.Result.Status);
        Assert.Empty(codex.Requests);
    }

    [Fact]
    public async Task 單次辨識checkpoint不會再次呼叫Agent()
    {
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output: "{}"));
        var codex = new FakeRunner(OcrAgentKind.Codex);
        var router = CreateRouter(claude, codex);
        var orchestrator = new AiOcrOrchestrator(router, new InMemoryOcrPassCheckpointStore());
        var first = await orchestrator.RecognizeAsync(Request);
        var second = await orchestrator.RecognizeAsync(Request);
        Assert.Same(first.Execution, second.Execution);
        Assert.Single(claude.Requests);
        Assert.Empty(codex.Requests);
    }

    private static AgentQuotaRouter CreateRouter(params IAgentCliRunner[] runners)
        => new(runners, new OcrAgentRouterOptions(PrimaryAgent: OcrAgentKind.Claude, QuotaCooldown: TimeSpan.Zero, TimeProvider: TimeProvider.System, ClaudeModel: "claude-test", CodexModel: "codex-test"));

    private static OcrAgentRunResult Result(OcrAgentKind agent, OcrAgentRunStatus status, string? errorCode = null, string? output = null)
        => new(agent, status, output, errorCode, null, status == OcrAgentRunStatus.Success ? 0 : 1, TimeSpan.FromMilliseconds(1));

    private sealed class FakeRunner(OcrAgentKind agent, params OcrAgentRunResult[] results) : IAgentCliRunner
    {
        private readonly Queue<OcrAgentRunResult> _results = new(results);
        public OcrAgentKind Agent { get; } = agent;
        public List<OcrAgentRequest> Requests { get; } = [];
        public Task<OcrAgentRunResult> RunAsync(OcrAgentRequest request, CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            return Task.FromResult(_results.Count > 0 ? _results.Dequeue() : Result(Agent, OcrAgentRunStatus.Success, output: "{}"));
        }
    }
}
