using System.Globalization;
using System.Text.Json;
using Invest.Web.Infrastructure.Ai.Cli;

namespace Invest.Web.Features.Assets.Ocr.Services;

public sealed record OcrRecognitionDraft(
    string SchemaVersion,
    string ExecutionMode,
    IReadOnlyList<OcrRecognitionDraftRow> Rows,
    IReadOnlyList<string> Warnings,
    string ExtractionAgent,
    string AuditAgent);

public sealed record OcrRecognitionDraftRow(
    string Ticker,
    string Name,
    decimal? Quantity,
    decimal? Cost,
    bool Verified,
    IReadOnlyList<string> Warnings);

/// <summary>
/// AI 的 JSON 只是候選資料。只有兩個獨立 Pass 的身份、股數與總成本相符，才標成 verified；
/// 不一致的列仍可送回既有人工校對表，但不會被包裝成已驗證結果。
/// </summary>
public sealed class OcrRecognitionValidator
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public OcrRecognitionDraft Validate(OcrTwoPassResult result)
    {
        var extraction = Parse(result.Extraction, "extraction");
        var audit = Parse(result.Audit, "audit");
        var warnings = new List<string>();

        if (!extraction.ImageReadable || !audit.ImageReadable)
        {
            warnings.Add("至少一個 AI Pass 判定圖片無法完整閱讀。");
        }

        if (extraction.VisibleRowCount != audit.VisibleRowCount)
        {
            warnings.Add($"兩次辨識的可見列數不同（{Display(extraction.VisibleRowCount)} / {Display(audit.VisibleRowCount)}）。");
        }

        warnings.AddRange(extraction.Warnings.Select(value => $"擷取：{value}"));
        warnings.AddRange(audit.Warnings.Select(value => $"稽核：{value}"));

        var unmatchedAudit = audit.Rows.ToList();
        var rows = new List<OcrRecognitionDraftRow>();
        foreach (var primary in extraction.Rows.OrderBy(row => row.RowIndex))
        {
            var match = FindMatch(primary, unmatchedAudit);
            if (match is not null)
            {
                unmatchedAudit.Remove(match);
            }

            rows.Add(Merge(primary, match));
        }

        foreach (var missed in unmatchedAudit.OrderBy(row => row.RowIndex))
        {
            var row = Merge(missed, null);
            rows.Add(row with
            {
                Verified = false,
                Warnings = row.Warnings.Concat(["只在稽核 Pass 出現；可能是第一遍漏列，必須人工確認。"])
                    .Distinct(StringComparer.Ordinal)
                    .ToArray()
            });
        }

        return new(
            "1",
            result.ExecutionMode,
            rows,
            warnings.Distinct(StringComparer.Ordinal).ToArray(),
            result.Extraction.Agent.ToString().ToLowerInvariant(),
            result.Audit.Agent.ToString().ToLowerInvariant());
    }

    private static PassDocument Parse(OcrAgentExecution execution, string pass)
    {
        if (execution.Result.Status != OcrAgentRunStatus.Success
            || string.IsNullOrWhiteSpace(execution.Result.Output))
        {
            throw new OcrRecognitionValidationException(
                $"{pass}_agent_{execution.Result.Status.ToString().ToLowerInvariant()}");
        }

        try
        {
            return JsonSerializer.Deserialize<PassDocument>(execution.Result.Output, JsonOptions)
                ?? throw new OcrRecognitionValidationException($"{pass}_empty_json");
        }
        catch (JsonException exception)
        {
            throw new OcrRecognitionValidationException($"{pass}_invalid_json", exception);
        }
    }

    private static PassRow? FindMatch(PassRow row, IReadOnlyList<PassRow> candidates)
    {
        var ticker = NormalizeTicker(row.TickerText);
        if (ticker.Length > 0)
        {
            var tickerMatch = candidates.FirstOrDefault(candidate => NormalizeTicker(candidate.TickerText) == ticker);
            if (tickerMatch is not null)
            {
                return tickerMatch;
            }
        }

        var name = NormalizeName(row.NameText);
        if (name.Length > 0)
        {
            var nameMatch = candidates.FirstOrDefault(candidate => NormalizeName(candidate.NameText) == name);
            if (nameMatch is not null)
            {
                return nameMatch;
            }
        }

        return candidates.FirstOrDefault(candidate => candidate.RowIndex == row.RowIndex);
    }

    private static OcrRecognitionDraftRow Merge(PassRow primary, PassRow? audit)
    {
        var ticker = NormalizeTicker(primary.TickerText ?? audit?.TickerText);
        var name = NormalizeNameForOutput(primary.NameText ?? audit?.NameText);
        var quantity = ParseNumber(primary.QuantityText ?? audit?.QuantityText);
        var cost = ParseNumber(primary.TotalCostText ?? audit?.TotalCostText);
        var rowWarnings = new List<string>();

        if (ticker.Length == 0 && name.Length == 0)
        {
            rowWarnings.Add("缺少股票代號與名稱。");
        }
        if (quantity is null)
        {
            rowWarnings.Add("股數無法安全解析。");
        }
        if (cost is null)
        {
            rowWarnings.Add("總成本無法安全解析。");
        }
        if (primary.RowObscured || audit?.RowObscured == true)
        {
            rowWarnings.Add("畫面可能有遮擋。");
        }

        var identityAgrees = audit is not null && IdentityAgrees(primary, audit);
        var quantityAgrees = audit is not null
            && NumbersAgree(ParseNumber(primary.QuantityText), ParseNumber(audit.QuantityText), 0.001m, 0m);
        var costAgrees = audit is not null
            && NumbersAgree(ParseNumber(primary.TotalCostText), ParseNumber(audit.TotalCostText), 0.50m, 0.002m);

        if (audit is null)
        {
            rowWarnings.Add("另一個 Pass 沒有找到對應列。");
        }
        else
        {
            if (!identityAgrees) rowWarnings.Add("兩個 Pass 的股票身份不一致。");
            if (!quantityAgrees) rowWarnings.Add("兩個 Pass 的股數不一致。");
            if (!costAgrees) rowWarnings.Add("兩個 Pass 的總成本不一致。");
        }

        var verified = identityAgrees
            && quantityAgrees
            && costAgrees
            && quantity is > 0
            && cost is >= 0
            && !primary.RowObscured
            && audit?.RowObscured != true;

        return new(ticker, name, quantity, cost, verified, rowWarnings);
    }

    private static bool IdentityAgrees(PassRow left, PassRow right)
    {
        var leftTicker = NormalizeTicker(left.TickerText);
        var rightTicker = NormalizeTicker(right.TickerText);
        if (leftTicker.Length > 0 || rightTicker.Length > 0)
        {
            return leftTicker.Length > 0 && leftTicker == rightTicker;
        }

        var leftName = NormalizeName(left.NameText);
        var rightName = NormalizeName(right.NameText);
        return leftName.Length > 0 && leftName == rightName;
    }

    private static bool NumbersAgree(decimal? left, decimal? right, decimal absoluteTolerance, decimal relativeTolerance)
    {
        if (left is null || right is null)
        {
            return false;
        }

        var tolerance = Math.Max(absoluteTolerance, Math.Max(Math.Abs(left.Value), Math.Abs(right.Value)) * relativeTolerance);
        return Math.Abs(left.Value - right.Value) <= tolerance;
    }

    private static decimal? ParseNumber(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

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
        return decimal.TryParse(
            cleaned,
            NumberStyles.AllowLeadingSign | NumberStyles.AllowDecimalPoint,
            CultureInfo.InvariantCulture,
            out var parsed)
            ? parsed
            : null;
    }

    private static string NormalizeTicker(string? value)
        => string.Concat((value ?? string.Empty).Where(character => char.IsLetterOrDigit(character) || character is '.' or '-'))
            .ToUpperInvariant();

    private static string NormalizeName(string? value)
        => string.Concat((value ?? string.Empty).Where(character => !char.IsWhiteSpace(character)))
            .ToUpperInvariant();

    private static string NormalizeNameForOutput(string? value)
        => string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static string Display(int? value) => value?.ToString(CultureInfo.InvariantCulture) ?? "不明";

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
