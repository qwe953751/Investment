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
        var cost = ParseNumber(row.TotalCostText);
        var rowWarnings = new List<string>();
        var quantity = ResolveQuantity(row, rowWarnings, out var needsReview);

        if (ticker.Length == 0 && name.Length == 0) rowWarnings.Add("缺少股票代號與名稱。");
        if (cost is null) rowWarnings.Add("總成本無法安全解析。");
        if (row.RowObscured) rowWarnings.Add("畫面可能有遮擋。");
        if (quantity == 0) rowWarnings.Add("股數為 0，可能已全部賣出，請確認要保留或移除。");

        // 成本為 0 卻還有股數，是昨日餘額版型最常見的矛盾：當天全部賣出後券商把成本歸零，
        // 但「今賣成」欄不在截圖內時，股數仍是昨日餘額。不改數字，只降級讓人核對。
        if (quantity is > 0 && cost == 0)
        {
            rowWarnings.Add("總成本為 0 但股數大於 0（例如當天已全部賣出、賣出欄未入鏡），請對照券商畫面核對。");
            needsReview = true;
        }

        var verified = imageReadable
            && (ticker.Length > 0 || name.Length > 0)
            && quantity is > 0
            && cost is >= 0
            && !row.RowObscured
            && !needsReview;
        return new(ticker, name, quantity, cost, verified, rowWarnings);
    }

    /// <summary>
    /// 股數有兩種版型：單一庫存欄（直接用 <c>QuantityText</c>），或券商拆成「昨日餘額／今買成／今賣成」。
    /// 後者 AI 只逐欄照抄，這裡才計算：昨日餘額＋今買成－今賣成。
    /// 今買成或今賣成沒有出現在畫面（AI 回 null，通常是被裁切）時視為 0——這是 2026-10-13
    /// 使用者定案的取捨，代價是當天有賣出、而賣出欄不在截圖內時，股數會偏高。
    /// 看不懂的數字、負數、小數或賣超過持有量一律不猜：股數留空並降級給人工修正。
    /// </summary>
    private static decimal? ResolveQuantity(PassRow row, List<string> warnings, out bool needsReview)
    {
        needsReview = false;
        var listed = ParseNumber(row.QuantityText);
        var hasYesterday = !string.IsNullOrWhiteSpace(row.YesterdayBalanceText);

        if (!hasYesterday)
        {
            if (!string.IsNullOrWhiteSpace(row.TodayBuyText) || !string.IsNullOrWhiteSpace(row.TodaySellText))
            {
                warnings.Add("只看到今買成或今賣成、沒有昨日餘額，無法計算股數。");
                needsReview = true;
            }

            if (listed is null) warnings.Add("股數無法安全解析。");
            return listed;
        }

        var yesterday = ParseNumber(row.YesterdayBalanceText);
        if (yesterday is null or < 0
            || !TryParseMovement(row.TodayBuyText, out var buy)
            || !TryParseMovement(row.TodaySellText, out var sell))
        {
            warnings.Add("昨日餘額、今買成或今賣成無法安全解析，無法計算股數。");
            needsReview = true;
            return null;
        }

        var computed = yesterday.Value + buy - sell;
        if (computed < 0 || computed != decimal.Truncate(computed))
        {
            warnings.Add(
                $"昨日餘額 {FormatNumber(yesterday.Value)}＋今買成 {FormatNumber(buy)}－今賣成 {FormatNumber(sell)}"
                + $" = {FormatNumber(computed)}，不是合理的股數。");
            needsReview = true;
            return null;
        }

        if (listed is not null && listed != computed)
        {
            warnings.Add(
                $"股數欄 {FormatNumber(listed.Value)} 與昨日餘額＋今買成－今賣成 = {FormatNumber(computed)} 不一致，"
                + "已採用後者，請核對。");
            needsReview = true;
        }

        return computed;
    }

    /// <summary>空白視為沒有出現（0）；有內容就必須是非負數，否則算看不懂。</summary>
    private static bool TryParseMovement(string? text, out decimal value)
    {
        value = 0;
        if (string.IsNullOrWhiteSpace(text)) return true;
        var parsed = ParseNumber(text);
        if (parsed is null or < 0) return false;
        value = parsed.Value;
        return true;
    }

    private static string FormatNumber(decimal value)
        => value.ToString("#,##0.####", CultureInfo.InvariantCulture);

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
        string? YesterdayBalanceText,
        string? TodayBuyText,
        string? TodaySellText,
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
