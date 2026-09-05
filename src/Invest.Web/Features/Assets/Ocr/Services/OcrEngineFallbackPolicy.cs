using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Features.Assets.Ocr.Services;

public enum OcrRecognitionEngine
{
    Ai,
    Tesseract
}

public enum OcrTesseractFallbackReason
{
    WorkerOffline,
    NoAvailableAgent,
    AllAgentsQuotaExhausted
}

/// <summary>
/// 正式 Worker 對網站公開的最小健康狀態。只有心跳夠新且至少一個 CLI 已完成訂閱登入，
/// 才能把含敏感持倉資料的圖片送進 AI 工作流程。
/// </summary>
public sealed record OcrWorkerReadiness(
    DateTimeOffset? LastHeartbeatAt,
    IReadOnlyCollection<OcrAgentKind> AuthenticatedAgents);

public sealed record OcrEngineDecision(
    OcrRecognitionEngine Engine,
    OcrTesseractFallbackReason? FallbackReason = null)
{
    public bool UsesTesseract => Engine == OcrRecognitionEngine.Tesseract;
}

/// <summary>
/// AI-first 與瀏覽器 Tesseract fallback 的唯一決策規則。
/// 這個類別不執行 Tesseract；正式網站收到 fallback 決策後，才在瀏覽器沿用現有引擎。
/// </summary>
public sealed class OcrEngineFallbackPolicy
{
    private static readonly OcrEngineDecision AiDecision = new(OcrRecognitionEngine.Ai);

    private readonly TimeProvider _timeProvider;
    private readonly TimeSpan _maximumHeartbeatAge;

    public OcrEngineFallbackPolicy(
        TimeProvider? timeProvider = null,
        TimeSpan? maximumHeartbeatAge = null)
    {
        _timeProvider = timeProvider ?? TimeProvider.System;
        _maximumHeartbeatAge = maximumHeartbeatAge ?? TimeSpan.FromMinutes(2);

        if (_maximumHeartbeatAge <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maximumHeartbeatAge),
                "Worker 心跳有效時間必須大於零。");
        }
    }

    public OcrEngineDecision DecideBeforeAi(OcrWorkerReadiness? readiness)
    {
        var now = _timeProvider.GetUtcNow();
        if (readiness?.LastHeartbeatAt is not { } heartbeatAt
            || now - heartbeatAt > _maximumHeartbeatAge)
        {
            return Tesseract(OcrTesseractFallbackReason.WorkerOffline);
        }

        if (readiness.AuthenticatedAgents.Count == 0)
        {
            return Tesseract(OcrTesseractFallbackReason.NoAvailableAgent);
        }

        return AiDecision;
    }

    /// <summary>
    /// 只把已知的「AI 無法使用」狀態轉成 Tesseract fallback；未分類的程式錯誤仍應向上拋出，
    /// 避免把真正的 bug 靜默偽裝成一次正常降級。
    /// </summary>
    public bool TryCreateFallback(
        Exception exception,
        out OcrEngineDecision decision)
    {
        switch (exception)
        {
            case OcrAllAgentsQuotaExhaustedException:
                decision = Tesseract(OcrTesseractFallbackReason.AllAgentsQuotaExhausted);
                return true;

            case OcrNoAvailableAgentException:
                decision = Tesseract(OcrTesseractFallbackReason.NoAvailableAgent);
                return true;

            default:
                decision = AiDecision;
                return false;
        }
    }

    private static OcrEngineDecision Tesseract(OcrTesseractFallbackReason reason)
        => new(OcrRecognitionEngine.Tesseract, reason);
}
