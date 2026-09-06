using System.Globalization;
using System.Text.Json;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Features.Assets.Ocr.Services;

public sealed record OcrRecognitionDraft(
    string SchemaVersion,
    string ExecutionMode,
    IReadOnlyList<OcrRecognitionDraftRow> Rows,
    IReadOnlyList<string> Warnings,
    string Agent);

public sealed record OcrRecognitionDraftRow(
    string Ticker,
    string Name,
    decimal? Quantity,
    decimal? Cost,
    bool Verified,
    IReadOnlyList<string> Warnings);

/// <summary>
/// AI JSON 只是候選資料；單次結果仍會做格式、可讀性與欄位安全檢查，不能取代人工確認。
/// </summary>
public sealed class OcrRecognitionValidator
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public OcrRecognitionDraft Validate(OcrSinglePassResult result)
    {
        var document = Parse(result.Execution);
        var warnings = document.Warnings.ToList();
        if (!document.ImageReadable)
        {
            warnings.Add("AI 判定圖片無法完整閱讀。");
        }

        if (document.VisibleRowCount is not null && document.VisibleRowCount != document.Rows.Count)
        {
            warnings.Add($"AI 回報可見列數 {document.VisibleRowCount}，但輸出 {document.Rows.Count} 列；必須人工確認。");
        }

        return new(
            "1",
            result.ExecutionMode,
            document.Rows.OrderBy(row => row.RowIndex).Select(row => ToDraftRow(row, document.ImageReadable)).ToArray(),
            warnings.Distinct(StringComparer.Ordinal).ToArray(),
            result.Execution.Agent.ToString().ToLowerInvariant());
    }

    private static PassDocument Parse(OcrAgentExecution execution)
    {
        if (execution.Result.Status != OcrAgentRunStatus.Success
            || string.IsNullOrWhiteSpace(execution.Result.Output))
        {
            throw new OcrRecognitionValidationException(
                $"ai_agent_{execution.Result.Status.ToString().ToLowerInvariant()}");
        }

        try
        {
            return JsonSerializer.Deserialize<PassDocument>(execution.Result.Output, JsonOptions)
                ?? throw new OcrRecognitionValidationException("ai_empty_json");
        }
        catch (JsonException exception)
        {
            throw new OcrRecognitionValidationException("ai_invalid_json", exception);
        }
    }

    private static OcrRecognitionDraftRow ToDraftRow(PassRow row, bool imageReadable)
    {
        var ticker = NormalizeTicker(row.TickerText);
        var name = NormalizeNameForOutput(row.NameText);
        var quantity = ParseNumber(row.QuantityText);
        var cost = ParseNumber(row.TotalCostText);
        var rowWarnings = new List<string>();

        if (ticker.Length == 0 && name.Length == 0) rowWarnings.Add("缺少股票代號與名稱。");
        if (quantity is null) rowWarnings.Add("股數無法安全解析。");
        if (cost is null) rowWarnings.Add("總成本無法安全解析。");
        if (row.RowObscured) rowWarnings.Add("畫面可能有遮擋。");

        var verified = imageReadable
            && (ticker.Length > 0 || name.Length > 0)
            && quantity is > 0
            && cost is >= 0
            && !row.RowObscured;
        return new(ticker, name, quantity, cost, verified, rowWarnings);
    }

    private static decimal? ParseNumber(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var cleaned = value.Trim()
            .Replace(",", "", StringComparison.Ordinal)
            .Replace("，", "", StringComparison.Ordinal)
            .Replace("$", "", StringComparison.Ordinal)
            .Replace("＄", "", StringComparison.Ordinal)
            .Replace("NTD", "", StringComparison.OrdinalIgnoreCase)
            .Replace("TWD", "", StringComparison.OrdinalIgnoreCase)
            .Replace("USD", "", StringComparison.OrdinalIgnoreCase)
            .Replace("股", "", StringComparison.Ordinal)
            .Trim();
        return decimal.TryParse(cleaned,
            NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint,
            CultureInfo.InvariantCulture,
            out var parsed) ? parsed : null;
    }

    private static string NormalizeTicker(string? value)
        => string.Concat((value ?? string.Empty).Where(character =>
            char.IsLetterOrDigit(character) || character is '.' or '-')).ToUpperInvariant();

    private static string NormalizeNameForOutput(string? value)
        => string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private sealed class PassDocument
    {
        public bool ImageReadable { get; init; }
        public int? VisibleRowCount { get; init; }
        public IReadOnlyList<PassRow> Rows { get; init; } = [];
        public IReadOnlyList<string> Warnings { get; init; } = [];
    }

    private sealed record PassRow(
        int RowIndex,
        string? TickerText,
        string? NameText,
        string? QuantityText,
        string? TotalCostText,
        string? Currency,
        bool RowObscured,
        string? Evidence);
}

public sealed class OcrRecognitionValidationException(string errorCode, Exception? innerException = null)
    : Exception(errorCode, innerException)
{
    public string ErrorCode { get; } = errorCode;
}
