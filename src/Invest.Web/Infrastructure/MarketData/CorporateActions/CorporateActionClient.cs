using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.CorporateActions;

/// <summary>
/// 讀取 TWSE／TPEx 官方除權息計算結果中的 P0 與 P1。
/// 這裡只解析事件；OHLC 還原公式由 DailyKLineCalculator 統一處理。
/// </summary>
public sealed class CorporateActionClient(
    HttpClient httpClient,
    ILogger<CorporateActionClient> logger)
{
    private const string TwseSource = "TWSE TWT49U";
    private const string TpexSource = "TPEx exDailyQ";

    public async Task<IReadOnlyList<StockPriceAdjustment>> GetAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken = default)
    {
        if (endDate < startDate)
        {
            throw new ArgumentOutOfRangeException(nameof(endDate));
        }

        var result = new List<StockPriceAdjustment>();

        // TWSE 長區間可能回傳查詢頁 HTML，或因回應太大超過逾時。
        // 按日曆月分段，保留完整歷史又避免悄悄截掉 MA240 需要的早期事件。
        foreach (var range in DateRanges(startDate, endDate))
        {
            var twseTask = GetTwseAsync(range.Start, range.End, cancellationToken);
            var tpexTask = GetTpexAsync(range.Start, range.End, cancellationToken);
            await Task.WhenAll(twseTask, tpexTask);
            result.AddRange(await twseTask);
            result.AddRange(await tpexTask);
        }

        result.Sort((left, right) =>
        {
            var ticker = string.CompareOrdinal(left.Ticker, right.Ticker);
            return ticker != 0 ? ticker : left.EffectiveDate.CompareTo(right.EffectiveDate);
        });

        logger.LogInformation(
            "官方除權息事件 {Start:yyyy-MM-dd}~{End:yyyy-MM-dd} 共 {Count} 筆一般股票。",
            startDate,
            endDate,
            result.Count);
        return result;
    }

    private async Task<IReadOnlyList<StockPriceAdjustment>> GetTwseAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken)
    {
        var url = "https://wwwc.twse.com.tw/rwd/zh/exRight/TWT49U"
            + $"?startDate={startDate:yyyyMMdd}&endDate={endDate:yyyyMMdd}&response=json";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Referrer = new Uri(
            "https://wwwc.twse.com.tw/zh/announcement/ex-right/twt49u.html");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        RequireJson(response, TwseSource);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;

        RequireStatus(root, TwseSource);
        RequireRange(root, "strDate", $"{startDate:yyyyMMdd}", TwseSource);
        RequireRange(root, "endDate", $"{endDate:yyyyMMdd}", TwseSource);
        return ParseTable(root, Market.Twse, TwseSource, "資料日期", "股票代號");
    }

    private async Task<IReadOnlyList<StockPriceAdjustment>> GetTpexAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken)
    {
        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["startDate"] = startDate.ToString("yyyy/MM/dd"),
            ["endDate"] = endDate.ToString("yyyy/MM/dd"),
            ["response"] = "json"
        });
        using var response = await httpClient.PostAsync(
            "https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ",
            content,
            cancellationToken);
        response.EnsureSuccessStatusCode();
        RequireJson(response, TpexSource);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;

        RequireStatus(root, TpexSource);
        RequireRange(root, "date", $"{startDate:yyyyMMdd}~{endDate:yyyyMMdd}", TpexSource);

        if (!root.TryGetProperty("tables", out var tables)
            || tables.ValueKind != JsonValueKind.Array
            || tables.GetArrayLength() == 0)
        {
            throw new InvalidDataException($"{TpexSource} 回應缺少 tables。");
        }

        return ParseTable(tables[0], Market.Tpex, TpexSource, "除權息日期", "代號");
    }

    private static IReadOnlyList<StockPriceAdjustment> ParseTable(
        JsonElement table,
        Market market,
        string source,
        string dateField,
        string tickerField)
    {
        if (!table.TryGetProperty("fields", out var fields)
            || fields.ValueKind != JsonValueKind.Array
            || !table.TryGetProperty("data", out var data)
            || data.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException($"{source} 回應缺少 fields 或 data。");
        }

        var names = fields.EnumerateArray().Select(item => item.GetString()).ToArray();
        var dateIndex = RequiredField(names, dateField, source);
        var tickerIndex = RequiredField(names, tickerField, source);
        var previousCloseIndex = RequiredField(names, "除權息前收盤價", source);
        var referencePriceIndex = RequiredField(names, "除權息參考價", source);
        var result = new List<StockPriceAdjustment>();

        foreach (var row in data.EnumerateArray())
        {
            var ticker = QuoteFieldParser.ReadCell(row, tickerIndex)?.Trim();

            if (!QuoteFieldParser.IsCommonStockTicker(ticker))
            {
                continue;
            }

            var date = ParseRocDate(QuoteFieldParser.ReadCell(row, dateIndex));
            var previousClose = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, previousCloseIndex));
            var referencePrice = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, referencePriceIndex));

            if (date is null || previousClose is not > 0m || referencePrice is not > 0m)
            {
                throw new InvalidDataException($"{source} 的 {ticker} 有無法解析的 P0/P1 或生效日。");
            }

            result.Add(new StockPriceAdjustment(
                ticker!, date.Value, previousClose.Value, referencePrice.Value, source)
            {
                Market = market
            });
        }

        return result;
    }

    private static void RequireStatus(JsonElement root, string source)
    {
        var status = root.TryGetProperty("stat", out var value) ? value.GetString() : null;
        if (!string.Equals(status, "ok", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException($"{source} 查詢失敗：{status ?? "缺少 stat"}");
        }
    }

    private static void RequireJson(HttpResponseMessage response, string source)
    {
        var mediaType = response.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException(
                $"{source} 回應不是 JSON（Content-Type: {mediaType ?? "—"}）。");
        }
    }

    private static IEnumerable<(DateOnly Start, DateOnly End)> DateRanges(
        DateOnly startDate,
        DateOnly endDate)
    {
        var start = startDate;

        while (start <= endDate)
        {
            var endOfMonth = new DateOnly(start.Year, start.Month, 1)
                .AddMonths(1)
                .AddDays(-1);
            var end = endOfMonth < endDate ? endOfMonth : endDate;
            yield return (start, end);
            start = end.AddDays(1);
        }
    }

    private static void RequireRange(
        JsonElement root,
        string propertyName,
        string expected,
        string source)
    {
        var actual = root.TryGetProperty(propertyName, out var value) ? value.GetString() : null;
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                $"{source} 回應日期 {actual ?? "—"}，與要求的 {expected} 不符。");
        }
    }

    private static int RequiredField(IReadOnlyList<string?> fields, string name, string source)
    {
        for (var index = 0; index < fields.Count; index++)
        {
            if (string.Equals(fields[index], name, StringComparison.Ordinal))
            {
                return index;
            }
        }

        throw new InvalidDataException($"{source} 回應缺少欄位「{name}」。");
    }

    private static DateOnly? ParseRocDate(string? raw)
    {
        var parts = raw?
            .Replace("年", "/", StringComparison.Ordinal)
            .Replace("月", "/", StringComparison.Ordinal)
            .Replace("日", string.Empty, StringComparison.Ordinal)
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        return parts is { Length: 3 }
            && int.TryParse(parts[0], out var year)
            && int.TryParse(parts[1], out var month)
            && int.TryParse(parts[2], out var day)
            && DateOnly.TryParse($"{year + 1911:0000}-{month:00}-{day:00}", out var date)
                ? date
                : null;
    }
}
