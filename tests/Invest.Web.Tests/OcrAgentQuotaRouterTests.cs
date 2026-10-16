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

    // 2026-10-16 事故：舊規則只有額度、登入、找不到 CLI 才換 Agent，Codex 的額度錯誤被判成一般失敗，
    // Claude 一次都沒試。新規則只看結果：沒成功就換，不論原因。每一種失敗狀態都要換。
    [Theory]
    [InlineData(OcrAgentRunStatus.QuotaExhausted)]
    [InlineData(OcrAgentRunStatus.AuthenticationRequired)]
    [InlineData(OcrAgentRunStatus.Unavailable)]
    [InlineData(OcrAgentRunStatus.TransientFailure)]
    [InlineData(OcrAgentRunStatus.InvalidOutput)]
    [InlineData(OcrAgentRunStatus.Fatal)]
    public async Task 主要Agent沒有成功時不論原因都改跑另一個Agent(OcrAgentRunStatus failure)
    {
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, failure, "primary_failed"));
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output: "{}"));

        var execution = await CreateRouter(OcrAgentKind.Codex, codex, claude).RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Equal(OcrAgentKind.Claude, execution.Agent);
        Assert.True(execution.UsedFallback);
        Assert.Single(codex.Requests);
        Assert.Single(claude.Requests);
    }

    [Fact]
    public async Task 主要Agent成功時不會呼叫另一個Agent()
    {
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: "{}"));
        var claude = new FakeRunner(OcrAgentKind.Claude);

        var execution = await CreateRouter(OcrAgentKind.Codex, codex, claude).RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Equal(OcrAgentKind.Codex, execution.Agent);
        Assert.False(execution.UsedFallback);
        Assert.Empty(claude.Requests);
    }

    // CLI 正常結束但輸出不是 JSON 物件，等於沒有辨識結果：之前會一路走到驗證器才失敗，而且不會換 Agent 或接力。
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("辨識完成")]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("123")]
    [InlineData("{\"rows\":[")]
    [InlineData("{\"type\":\"turn.started\"}\n{\"type\":\"turn.completed\"}")]
    public async Task CLI說成功但輸出不是JSON物件時視為失敗並改跑另一個Agent(string output)
    {
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.Success, output: output));
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output: "{\"rows\":[]}"));

        var execution = await CreateRouter(OcrAgentKind.Codex, codex, claude).RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Equal(OcrAgentKind.Claude, execution.Agent);
        Assert.Equal("{\"rows\":[]}", execution.Result.Output);
        Assert.Single(codex.Requests);
    }

    [Fact]
    public async Task 兩個Agent都沒有成功時丟出沒有可用Agent例外讓Worker接力給另一台()
    {
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.Fatal, "cli_failure"));
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.AuthenticationRequired, "authentication_required"));

        var exception = await Assert.ThrowsAsync<OcrNoAvailableAgentException>(
            () => CreateRouter(OcrAgentKind.Codex, codex, claude).RunPassAsync(OcrPassKind.Extraction, Request));

        Assert.Equal("cli_failure", exception.Reasons[OcrAgentKind.Codex]);
        Assert.Equal("authentication_required", exception.Reasons[OcrAgentKind.Claude]);
    }

    [Fact]
    public async Task 一個額度不足一個一般失敗時不算全部額度不足()
    {
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.QuotaExhausted, "quota_exhausted"));
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.Fatal, "cli_failure"));

        await Assert.ThrowsAsync<OcrNoAvailableAgentException>(
            () => CreateRouter(OcrAgentKind.Codex, codex, claude).RunPassAsync(OcrPassKind.Extraction, Request));
    }

    [Fact]
    public async Task 只有額度不足才記冷卻時間其他失敗不記()
    {
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.Fatal, "cli_failure"));
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.QuotaExhausted, "quota_exhausted"));
        var router = CreateRouter(OcrAgentKind.Codex, codex, claude, cooldown: TimeSpan.FromMinutes(30));

        await Assert.ThrowsAsync<OcrNoAvailableAgentException>(() => router.RunPassAsync(OcrPassKind.Extraction, Request));

        Assert.False(router.QuotaBlockedUntil.ContainsKey(OcrAgentKind.Codex), "一般失敗不該讓 Codex 進入冷卻。");
        Assert.True(router.QuotaBlockedUntil.ContainsKey(OcrAgentKind.Claude), "額度不足要記冷卻時間。");
    }

    [Fact]
    public async Task 額度冷卻中的Agent會被略過且另一個Agent照常執行()
    {
        var codex = new FakeRunner(
            OcrAgentKind.Codex,
            Result(OcrAgentKind.Codex, OcrAgentRunStatus.QuotaExhausted, "quota_exhausted"));
        var claude = new FakeRunner(OcrAgentKind.Claude);
        var router = CreateRouter(OcrAgentKind.Codex, codex, claude, cooldown: TimeSpan.FromMinutes(30));

        await router.RunPassAsync(OcrPassKind.Extraction, Request);
        await router.RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Single(codex.Requests);
        Assert.Equal(2, claude.Requests.Count);
    }

    [Fact]
    public async Task 背景評估只用主要Agent失敗時不去花另一個Agent的額度()
    {
        var codex = new FakeRunner(OcrAgentKind.Codex, Result(OcrAgentKind.Codex, OcrAgentRunStatus.Fatal, "cli_failure"));
        var claude = new FakeRunner(OcrAgentKind.Claude);
        var request = Request with { PrimaryAgentOnly = true };

        await Assert.ThrowsAsync<OcrNoAvailableAgentException>(
            () => CreateRouter(OcrAgentKind.Codex, codex, claude).RunPassAsync(OcrPassKind.Extraction, request));

        Assert.Single(codex.Requests);
        Assert.Empty(claude.Requests);
    }

    [Fact]
    public void Worker的背景評估請求只用主要Agent而使用者辨識請求不是()
    {
        var evaluation = OcrWorkerRunner.CreateEvaluationRequest("/tmp/a.png", "/tmp/s.json", "/tmp", "台股");
        var recognition = OcrWorkerRunner.CreateRequest("/tmp/a.png", "/tmp/s.json", "/tmp", "台股", "max");

        Assert.True(evaluation.PrimaryAgentOnly);
        Assert.Equal("low", evaluation.ReasoningEffort);
        Assert.False(recognition.PrimaryAgentOnly);
        Assert.Equal("max", recognition.ReasoningEffort);
    }

    [Fact]
    public async Task 使用者取消時直接停止不會改跑另一個Agent()
    {
        var codex = new ThrowingRunner(OcrAgentKind.Codex, new OperationCanceledException());
        var claude = new FakeRunner(OcrAgentKind.Claude);

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => CreateRouter(OcrAgentKind.Codex, codex, claude).RunPassAsync(OcrPassKind.Extraction, Request));

        Assert.Empty(claude.Requests);
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

    [Fact]
    public async Task 背景評估的Low設定會原樣傳給訂閱Agent()
    {
        var claude = new FakeRunner(OcrAgentKind.Claude, Result(OcrAgentKind.Claude, OcrAgentRunStatus.Success, output: "{}"));
        var request = Request with { ReasoningEffort = "low" };

        var execution = await CreateRouter(claude).RunPassAsync(OcrPassKind.Extraction, request);

        Assert.Equal("low", claude.Requests[0].ReasoningEffort);
        Assert.Equal("low", execution.ReasoningEffort);
        Assert.Equal("claude-test", execution.Model);
    }

    private static AgentQuotaRouter CreateRouter(params IAgentCliRunner[] runners)
        => CreateRouter(OcrAgentKind.Claude, TimeSpan.Zero, runners);

    private static AgentQuotaRouter CreateRouter(
        OcrAgentKind primary,
        IAgentCliRunner first,
        IAgentCliRunner second,
        TimeSpan? cooldown = null)
        => CreateRouter(primary, cooldown ?? TimeSpan.Zero, first, second);

    private static AgentQuotaRouter CreateRouter(OcrAgentKind primary, TimeSpan cooldown, params IAgentCliRunner[] runners)
        => new(runners, new OcrAgentRouterOptions(PrimaryAgent: primary, QuotaCooldown: cooldown, TimeProvider: TimeProvider.System, ClaudeModel: "claude-test", CodexModel: "codex-test"));

    private static OcrAgentRunResult Result(OcrAgentKind agent, OcrAgentRunStatus status, string? errorCode = null, string? output = null)
        => new(agent, status, output, errorCode, null, status == OcrAgentRunStatus.Success ? 0 : 1, TimeSpan.FromMilliseconds(1));

    private sealed class ThrowingRunner(OcrAgentKind agent, Exception exception) : IAgentCliRunner
    {
        public OcrAgentKind Agent { get; } = agent;
        public Task<OcrAgentRunResult> RunAsync(OcrAgentRequest request, CancellationToken cancellationToken = default)
            => Task.FromException<OcrAgentRunResult>(exception);
    }

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
