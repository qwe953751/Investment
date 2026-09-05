using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrEngineFallbackPolicyTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 5, 1, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Worker在線且至少一個Agent已登入時優先使用Ai()
    {
        var policy = CreatePolicy();
        var readiness = new OcrWorkerReadiness(
            Now.AddSeconds(-30),
            [OcrAgentKind.Codex]);

        var decision = policy.DecideBeforeAi(readiness);

        Assert.Equal(OcrRecognitionEngine.Ai, decision.Engine);
        Assert.Null(decision.FallbackReason);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Worker沒有心跳或心跳逾時時回退Tesseract(bool missingHeartbeat)
    {
        var policy = CreatePolicy();
        var readiness = new OcrWorkerReadiness(
            missingHeartbeat ? null : Now.AddMinutes(-3),
            [OcrAgentKind.Codex]);

        var decision = policy.DecideBeforeAi(readiness);

        Assert.True(decision.UsesTesseract);
        Assert.Equal(OcrTesseractFallbackReason.WorkerOffline, decision.FallbackReason);
    }

    [Fact]
    public void Worker在線但沒有已登入Agent時回退Tesseract()
    {
        var policy = CreatePolicy();
        var readiness = new OcrWorkerReadiness(Now, []);

        var decision = policy.DecideBeforeAi(readiness);

        Assert.True(decision.UsesTesseract);
        Assert.Equal(OcrTesseractFallbackReason.NoAvailableAgent, decision.FallbackReason);
    }

    [Fact]
    public void 兩個Agent額度都不足時回退Tesseract()
    {
        var policy = CreatePolicy();
        var exception = new OcrAllAgentsQuotaExhaustedException(
            OcrPassKind.Extraction,
            new Dictionary<OcrAgentKind, string>
            {
                [OcrAgentKind.Claude] = "quota_exhausted",
                [OcrAgentKind.Codex] = "quota_exhausted"
            });

        var handled = policy.TryCreateFallback(exception, out var decision);

        Assert.True(handled);
        Assert.True(decision.UsesTesseract);
        Assert.Equal(OcrTesseractFallbackReason.AllAgentsQuotaExhausted, decision.FallbackReason);
    }

    [Fact]
    public void 兩個Agent都未安裝或未登入時回退Tesseract()
    {
        var policy = CreatePolicy();
        var exception = new OcrNoAvailableAgentException(
            OcrPassKind.Extraction,
            new Dictionary<OcrAgentKind, string>
            {
                [OcrAgentKind.Claude] = "authentication_required",
                [OcrAgentKind.Codex] = "cli_unavailable"
            });

        var handled = policy.TryCreateFallback(exception, out var decision);

        Assert.True(handled);
        Assert.Equal(OcrRecognitionEngine.Tesseract, decision.Engine);
        Assert.Equal(OcrTesseractFallbackReason.NoAvailableAgent, decision.FallbackReason);
    }

    [Fact]
    public void 未分類程式錯誤不會被靜默轉成Tesseract成功()
    {
        var policy = CreatePolicy();

        var handled = policy.TryCreateFallback(
            new InvalidOperationException("unexpected"),
            out var decision);

        Assert.False(handled);
        Assert.Equal(OcrRecognitionEngine.Ai, decision.Engine);
    }

    private static OcrEngineFallbackPolicy CreatePolicy()
        => new(
            new FixedTimeProvider(Now),
            TimeSpan.FromMinutes(2));

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
