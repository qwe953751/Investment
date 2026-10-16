using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

/// <summary>
/// 2026-10-16 事故的回歸測試：Codex 額度用完，Claude 卻一次都沒被呼叫，整批直接走 Tesseract。
/// 原本的測試把錯誤文字放在 stderr，但兩個 CLI 在 JSON 輸出模式下都把錯誤寫在 stdout 的 JSON 裡，
/// 所以測試全綠、實際卻抓不到。這裡改成把 CLI 實際會吐出的輸出形狀，原封不動交給真正的分類器
/// （<see cref="AgentCliResultClassifier"/>）與 Router，只是不啟動真實程序；
/// 驗證的是「換不換 Agent」這個決定本身，而不是某一段錯誤文字有沒有被認出來。
/// </summary>
public sealed class OcrAgentSwitchOnCliOutputTests
{
    private static readonly OcrAgentRequest Request = new("/tmp/image.png", "extract", "/tmp/schema.json", "/tmp");

    // Codex CLI 0.162（Mac，2026-10-16 實測）：模型被拒絕的真實 stdout，exit code 1，stderr 只有一行 stdin 提示。
    private const string CodexRejectedStdout = """
        {"type":"thread.started","thread_id":"01a144f6-3054-7bb1-b4be-4a8a24e306b1"}
        {"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `nonexistent-model-for-diagnosis` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
        {"type":"turn.started"}
        {"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'nonexistent-model-for-diagnosis' model is not supported when using Codex with a ChatGPT account.\"}}"}
        {"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'nonexistent-model-for-diagnosis' model is not supported when using Codex with a ChatGPT account.\"}}"}}
        """;

    // 事件格式與上面的實測輸出相同，訊息文字是模擬的：事故當時沒有保留到真正的額度錯誤文字。
    private const string CodexQuotaStdout = """
        {"type":"thread.started","thread_id":"01a144f6-3054-7bb1-b4be-4a8a24e306b1"}
        {"type":"turn.started"}
        {"type":"error","message":"You've hit your usage limit. Try again later."}
        {"type":"turn.failed","error":{"message":"You've hit your usage limit. Try again later."}}
        """;

    private const string CodexStdinHint = "Reading additional input from stdin...";

    // Claude Code 2.1.299（Mac，2026-10-16 實測）以 Worker 的參數執行、尚未登入：exit code 1，錯誤在 stdout 的 JSON，stderr 為空。
    // 節錄自實測輸出，保留判斷會用到的欄位。
    private const string ClaudeNotLoggedInStdout = """
        {"type":"result","subtype":"success","is_error":true,"api_error_status":null,"result":"Not logged in · Please run /login","terminal_reason":"api_error","num_turns":1,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{}}
        """;

    // Claude 的結構化輸出重試用盡：exit code 0，但沒有 structured_output。
    private const string ClaudeNoStructuredOutputStdout = """
        {"type":"result","subtype":"error_max_structured_output_retries","is_error":true,"result":"","num_turns":3}
        """;

    private const string ClaudeSuccessStdout = """
        {"type":"result","subtype":"success","is_error":false,"result":"","structured_output":{"schemaVersion":"1","promptVersion":"1","imageReadable":true,"visibleRowCount":0,"rows":[],"warnings":[]}}
        """;

    private const string CodexSuccessOutput =
        """{"schemaVersion":"1","promptVersion":"1","imageReadable":true,"visibleRowCount":0,"rows":[],"warnings":[]}""";

    [Theory]
    [InlineData(CodexRejectedStdout)]
    [InlineData(CodexQuotaStdout)]
    public async Task Codex在JSON模式下只寫在stdout的失敗仍會改跑Claude(string codexStdout)
    {
        var codex = new ReplayRunner(OcrAgentKind.Codex, exitCode: 1, codexStdout, CodexStdinHint);
        var claude = new ReplayRunner(OcrAgentKind.Claude, exitCode: 0, ClaudeSuccessStdout);

        var execution = await CreateRouter(codex, claude).RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.NotEqual(OcrAgentRunStatus.Success, codex.LastResult!.Status);
        Assert.Equal(1, codex.Calls);
        Assert.Equal(1, claude.Calls);
        Assert.Equal(OcrAgentKind.Claude, execution.Agent);
        Assert.True(execution.UsedFallback);
        Assert.Contains("\"rows\"", execution.Result.Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Codex成功時不會呼叫Claude()
    {
        var codex = new ReplayRunner(OcrAgentKind.Codex, exitCode: 0, CodexSuccessOutput);
        var claude = new ReplayRunner(OcrAgentKind.Claude, exitCode: 0, ClaudeSuccessStdout);

        var execution = await CreateRouter(codex, claude).RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Equal(OcrAgentKind.Codex, execution.Agent);
        Assert.False(execution.UsedFallback);
        Assert.Equal(0, claude.Calls);
    }

    [Fact]
    public async Task Codex正常結束但只有事件串流沒有辨識結果時視為失敗並改跑Claude()
    {
        // 沒有 -o 輸出檔時，ProcessCliRunnerBase 會退回使用 stdout；事件串流不是辨識結果。
        var codex = new ReplayRunner(OcrAgentKind.Codex, exitCode: 0, CodexRejectedStdout);
        var claude = new ReplayRunner(OcrAgentKind.Claude, exitCode: 0, ClaudeSuccessStdout);

        var execution = await CreateRouter(codex, claude).RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.Equal(OcrAgentKind.Claude, execution.Agent);
        Assert.Equal(1, codex.Calls);
    }

    [Fact]
    public async Task Claude正常結束但沒有structured_output時視為失敗並改跑Codex()
    {
        var claude = new ReplayRunner(OcrAgentKind.Claude, exitCode: 0, ClaudeNoStructuredOutputStdout);
        var codex = new ReplayRunner(OcrAgentKind.Codex, exitCode: 0, CodexSuccessOutput);

        var execution = await CreateRouter(claude, codex, primary: OcrAgentKind.Claude)
            .RunPassAsync(OcrPassKind.Extraction, Request);

        Assert.NotEqual(OcrAgentRunStatus.Success, claude.LastResult!.Status);
        Assert.Equal(OcrAgentKind.Codex, execution.Agent);
    }

    [Fact]
    public async Task 兩個Agent的真實失敗輸出都走完後Worker會改走接力而不是直接Tesseract()
    {
        var codex = new ReplayRunner(OcrAgentKind.Codex, exitCode: 1, CodexRejectedStdout, CodexStdinHint);
        var claude = new ReplayRunner(OcrAgentKind.Claude, exitCode: 1, ClaudeNotLoggedInStdout);
        var router = CreateRouter(codex, claude);
        var coordinator = new OcrExecutionCoordinator(
            new OcrEngineFallbackPolicy(),
            new AiOcrOrchestrator(router, new InMemoryOcrPassCheckpointStore()));

        var result = await coordinator.RecognizeAsync(
            new OcrWorkerReadiness(DateTimeOffset.UtcNow, [OcrAgentKind.Codex, OcrAgentKind.Claude]),
            Request);

        // Worker 在 UsesTesseract 時呼叫 RelayOrFallbackAsync：Windows 會先問 Mac，Mac 也不行才走瀏覽器 Tesseract。
        Assert.True(result.UsesTesseract);
        Assert.Equal(OcrTesseractFallbackReason.NoAvailableAgent, result.FallbackReason);
        Assert.Equal(1, codex.Calls);
        Assert.Equal(1, claude.Calls);
    }

    private static AgentQuotaRouter CreateRouter(
        IAgentCliRunner first,
        IAgentCliRunner second,
        OcrAgentKind primary = OcrAgentKind.Codex)
        => new([first, second], new OcrAgentRouterOptions(
            PrimaryAgent: primary,
            QuotaCooldown: TimeSpan.FromMinutes(30),
            ClaudeModel: "claude-test",
            CodexModel: "codex-test"));

    /// <summary>
    /// 走與 <see cref="ProcessCliRunnerBase"/> 相同的後處理：CLI 的 exit code、stdout、stderr 交給真正的分類器，
    /// Claude 再多一步取出 structured_output（<see cref="ClaudeCodeCliRunner"/> 的做法）。只是不啟動真實程序。
    /// </summary>
    private sealed class ReplayRunner(OcrAgentKind agent, int exitCode, string stdout, string stderr = "") : IAgentCliRunner
    {
        public OcrAgentKind Agent { get; } = agent;
        public int Calls { get; private set; }
        public OcrAgentRunResult? LastResult { get; private set; }

        public Task<OcrAgentRunResult> RunAsync(OcrAgentRequest request, CancellationToken cancellationToken = default)
        {
            Calls++;
            var result = AgentCliResultClassifier.Classify(Agent, exitCode, stdout, stderr, TimeSpan.FromSeconds(1));
            if (Agent == OcrAgentKind.Claude && result.Status == OcrAgentRunStatus.Success)
            {
                result = ClaudeCodeCliRunner.UnwrapStructuredOutput(result);
            }

            LastResult = result;
            return Task.FromResult(result);
        }
    }
}
