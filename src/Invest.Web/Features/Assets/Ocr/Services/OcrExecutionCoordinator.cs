using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Features.Assets.Ocr.Services;

/// <summary>
/// AI 兩遍辨識的抽象邊界，讓正式 Worker 可以在不依賴具體 checkpoint 儲存方式的情況下
/// 套用同一套 fallback 規則。
/// </summary>
public interface IAiOcrRecognizer
{
    Task<OcrTwoPassResult> RecognizeAsync(
        OcrAgentRequest extractionRequest,
        OcrAgentRequest auditRequest,
        CancellationToken cancellationToken = default);
}

public enum OcrExecutionMode
{
    Ai,
    TesseractFallback
}

/// <summary>
/// OCR 工作的唯一引擎選擇結果。Tesseract 由瀏覽器現有流程執行，這裡只回傳決策與原因，
/// 不在伺服器重新實作另一套 OCR。
/// </summary>
public sealed record OcrExecutionResult(
    OcrExecutionMode Mode,
    OcrTesseractFallbackReason? FallbackReason = null,
    OcrTwoPassResult? AiResult = null)
{
    public bool UsesTesseract => Mode == OcrExecutionMode.TesseractFallback;

    public static OcrExecutionResult FromAi(OcrTwoPassResult result)
        => new(OcrExecutionMode.Ai, AiResult: result);

    public static OcrExecutionResult FromTesseract(OcrTesseractFallbackReason reason)
        => new(OcrExecutionMode.TesseractFallback, reason);
}

/// <summary>
/// 將「上傳前健康檢查」與「AI 執行中已知不可用例外」接到同一個 fallback 邊界。
/// 未分類錯誤仍會往上拋，避免把程式 bug 藏在看似成功的 Tesseract 結果後面。
/// </summary>
public sealed class OcrExecutionCoordinator(
    OcrEngineFallbackPolicy fallbackPolicy,
    IAiOcrRecognizer aiRecognizer)
{
    public async Task<OcrExecutionResult> RecognizeAsync(
        OcrWorkerReadiness? readiness,
        OcrAgentRequest extractionRequest,
        OcrAgentRequest auditRequest,
        CancellationToken cancellationToken = default)
    {
        var preflight = fallbackPolicy.DecideBeforeAi(readiness);
        if (preflight.UsesTesseract)
        {
            return OcrExecutionResult.FromTesseract(preflight.FallbackReason!.Value);
        }

        try
        {
            var aiResult = await aiRecognizer.RecognizeAsync(
                extractionRequest,
                auditRequest,
                cancellationToken);
            return OcrExecutionResult.FromAi(aiResult);
        }
        catch (Exception exception)
        {
            if (!fallbackPolicy.TryCreateFallback(exception, out var fallback))
            {
                throw;
            }

            return OcrExecutionResult.FromTesseract(fallback.FallbackReason!.Value);
        }
    }
}
