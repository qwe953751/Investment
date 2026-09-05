using Invest.Web.Features.Assets.Ocr.Services;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Tests;

public sealed class OcrExecutionCoordinatorTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 5, 1, 0, 0, TimeSpan.Zero);
    private static readonly OcrAgentRequest Request = new(
        "/tmp/image.png",
        "extract",
        "/tmp/schema.json",
        "/tmp");

    [Fact]
    public async Task Worker離線時不上AI直接要求Tesseract()
    {
        var recognizer = new SpyRecognizer();
        var coordinator = CreateCoordinator(recognizer);

        var result = await coordinator.RecognizeAsync(null, Request, Request);

        Assert.True(result.UsesTesseract);
        Assert.Equal(OcrTesseractFallbackReason.WorkerOffline, result.FallbackReason);
        Assert.Equal(0, recognizer.CallCount);
    }

    [Fact]
    public async Task Worker在線且有登入Agent時執行AI()
    {
        var aiResult = CreateAiResult();
        var recognizer = new SpyRecognizer(aiResult);
        var coordinator = CreateCoordinator(recognizer);
        var readiness = new OcrWorkerReadiness(Now.AddSeconds(-30), [OcrAgentKind.Codex]);

        var result = await coordinator.RecognizeAsync(readiness, Request, Request);

        Assert.Equal(OcrExecutionMode.Ai, result.Mode);
        Assert.Same(aiResult, result.AiResult);
        Assert.Equal(1, recognizer.CallCount);
    }

    [Fact]
    public async Task 雙Agent額度不足時轉成TesseractFallback()
    {
        var recognizer = new ThrowingRecognizer(
            new OcrAllAgentsQuotaExhaustedException(
                OcrPassKind.Extraction,
                new Dictionary<OcrAgentKind, string>
                {
                    [OcrAgentKind.Claude] = "quota_exhausted",
                    [OcrAgentKind.Codex] = "quota_exhausted"
                }));
        var coordinator = CreateCoordinator(recognizer);
        var readiness = new OcrWorkerReadiness(Now, [OcrAgentKind.Claude, OcrAgentKind.Codex]);

        var result = await coordinator.RecognizeAsync(readiness, Request, Request);

        Assert.True(result.UsesTesseract);
        Assert.Equal(OcrTesseractFallbackReason.AllAgentsQuotaExhausted, result.FallbackReason);
    }

    [Fact]
    public async Task 未知錯誤不會被轉成Tesseract()
    {
        var recognizer = new ThrowingRecognizer(new InvalidOperationException("unexpected"));
        var coordinator = CreateCoordinator(recognizer);
        var readiness = new OcrWorkerReadiness(Now, [OcrAgentKind.Codex]);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => coordinator.RecognizeAsync(readiness, Request, Request));
    }

    private static OcrExecutionCoordinator CreateCoordinator(IAiOcrRecognizer recognizer)
        => new(
            new OcrEngineFallbackPolicy(
                new FixedTimeProvider(Now),
                TimeSpan.FromMinutes(2)),
            recognizer);

    private static OcrTwoPassResult CreateAiResult()
    {
        var extraction = new OcrAgentExecution(
            OcrPassKind.Extraction,
            OcrAgentKind.Codex,
            new OcrAgentRunResult(
                OcrAgentKind.Codex,
                OcrAgentRunStatus.Success,
                "{}",
                null,
                null,
                0,
                TimeSpan.FromMilliseconds(1)),
            false);
        return new(extraction, extraction with { Pass = OcrPassKind.Audit });
    }

    private sealed class SpyRecognizer(OcrTwoPassResult? result = null) : IAiOcrRecognizer
    {
        public int CallCount { get; private set; }

        public Task<OcrTwoPassResult> RecognizeAsync(
            OcrAgentRequest extractionRequest,
            OcrAgentRequest auditRequest,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(result ?? CreateAiResult());
        }
    }

    private sealed class ThrowingRecognizer(Exception exception) : IAiOcrRecognizer
    {
        public Task<OcrTwoPassResult> RecognizeAsync(
            OcrAgentRequest extractionRequest,
            OcrAgentRequest auditRequest,
            CancellationToken cancellationToken = default)
            => Task.FromException<OcrTwoPassResult>(exception);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
