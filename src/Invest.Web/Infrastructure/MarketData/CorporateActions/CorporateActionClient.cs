using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Reference;

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
    private const string EmergingSource = "TPEx 興櫃除權除息";

    /// <summary>
    /// 一份完整歷史要按月分段，來回是幾十個請求；只要有一個抖掉，整個 export 就沒了。
    /// 2026-08-21 的每日排行快照就是這樣死的：櫃買回 520，
    /// 「輸出靜態網站」中斷 → 沒有 index.html → 發佈也跟著失敗，
    /// 那天的行情明明都抓齊了，網站卻停在前一天。
    /// </summary>
    private const int MaxAttempts = 3;

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
            var twseTask = WithRetryAsync(
                TwseSource,
                token => GetTwseAsync(range.Start, range.End, token),
                cancellationToken);
            var tpexTask = WithRetryAsync(
                TpexSource,
                token => GetTpexAsync(range.Start, range.End, token),
                cancellationToken);
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

    /// <summary>
    /// 讀取區間內<b>所有種類標的</b>（普通股、ETF、TDR、特別股、興櫃……）的官方除權息事件。
    /// 和 <see cref="GetAsync"/> 不同：這份不過濾代號形狀，因為還原權息要涵蓋 ETF 的配息
    /// （2026 年 874 筆）與興櫃；也不因為單列欄位異常就讓整份失敗——事件表是還原倍數的精確來源，
    /// 但「有沒有事件」另有每日參考價可以比對，無法解析的列略過即可。
    /// </summary>
    public async Task<IReadOnlyList<ReferenceAction>> GetAllKindsAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken = default)
    {
        if (endDate < startDate)
        {
            throw new ArgumentOutOfRangeException(nameof(endDate));
        }

        var result = new List<ReferenceAction>();

        foreach (var range in DateRanges(startDate, endDate))
        {
            var twseTask = WithRetryAsync(
                TwseSource,
                token => ReadTwseAsync(
                    range.Start,
                    range.End,
                    root => ParseActionTable(root, Market.Twse, TwseSource, "資料日期", "股票代號"),
                    token),
                cancellationToken);
            var tpexTask = WithRetryAsync(
                TpexSource,
                token => ReadTpexAsync(
                    range.Start,
                    range.End,
                    table => ParseActionTable(table, Market.Tpex, TpexSource, "除權息日期", "代號"),
                    token),
                cancellationToken);
            var emergingTask = WithRetryAsync(
                EmergingSource,
                token => ReadEmergingAsync(range.Start, range.End, token),
                cancellationToken);
            await Task.WhenAll(twseTask, tpexTask, emergingTask);
            result.AddRange(await twseTask);
            result.AddRange(await tpexTask);
            result.AddRange(await emergingTask);
        }

        result.Sort((left, right) =>
        {
            var date = left.Date.CompareTo(right.Date);
            return date != 0 ? date : string.CompareOrdinal(left.Ticker, right.Ticker);
        });
        return result;
    }

    /// <summary>
    /// 櫃買中心「興櫃股票除權除息資料」。興櫃的前日均價完全不處理除權息，
    /// 所以這張表是興櫃唯一的事件來源；表上只有現金股利與配股、增資的組成，沒有參考價。
    /// 端點和上櫃的 exDailyQ 一樣吃 startDate／endDate 並回傳 <c>date</c> 區間。
    /// </summary>
    private async Task<IReadOnlyList<ReferenceAction>> ReadEmergingAsync(
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
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "https://www.tpex.org.tw/www/zh-tw/emerging/dividend")
        {
            Content = content
        };
        request.Headers.Referrer = new Uri("https://www.tpex.org.tw/web/emergingstock/ex/exdividend.php?l=zh-tw");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        RequireJson(response, EmergingSource);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;

        RequireStatus(root, EmergingSource);
        RequireRange(root, "date", $"{startDate:yyyyMMdd}~{endDate:yyyyMMdd}", EmergingSource);

        if (!root.TryGetProperty("tables", out var tables)
            || tables.ValueKind != JsonValueKind.Array
            || tables.GetArrayLength() == 0)
        {
            throw new InvalidDataException($"{EmergingSource} 回應缺少 tables。");
        }

        return ParseEmergingTable(tables[0]);
    }

    internal static IReadOnlyList<ReferenceAction> ParseEmergingTable(JsonElement table)
    {
        if (!table.TryGetProperty("fields", out var fields)
            || fields.ValueKind != JsonValueKind.Array
            || !table.TryGetProperty("data", out var data)
            || data.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException($"{EmergingSource} 回應缺少 fields 或 data。");
        }

        var names = fields.EnumerateArray().Select(item => item.GetString()).ToArray();
        var tickerIndex = RequiredField(names, "代號", EmergingSource);
        var dateIndex = RequiredField(names, "除權除息日期", EmergingSource);
        var kindIndex = RequiredField(names, "種類", EmergingSource);
        var cashIndex = RequiredField(names, "現金股利", EmergingSource);
        var stockIndex = RequiredField(names, "每仟股無償配發股數", EmergingSource);
        var rightsSharesIndex = RequiredField(names, "每仟股認購股數", EmergingSource);
        var rightsPriceIndex = RequiredField(names, "每股認購價格", EmergingSource);
        var result = new List<ReferenceAction>();

        foreach (var row in data.EnumerateArray())
        {
            var ticker = QuoteFieldParser.ReadCell(row, tickerIndex)?.Trim();
            var date = ParseRocDate(QuoteFieldParser.ReadCell(row, dateIndex));

            if (string.IsNullOrEmpty(ticker) || date is null)
            {
                continue;
            }

            var kind = QuoteFieldParser.ReadCell(row, kindIndex)?.Trim();

            result.Add(new ReferenceAction
            {
                Date = date.Value,
                Market = Market.Emerging,
                Ticker = ticker,
                Kind = string.IsNullOrEmpty(kind) ? null : kind,
                Source = EmergingSource,
                CashDividend = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, cashIndex)),
                StockDividendPer1000 = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, stockIndex)),
                RightsSharesPer1000 = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, rightsSharesIndex)),
                RightsPrice = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, rightsPriceIndex))
            });
        }

        return result;
    }

    /// <summary>
    /// 抖一下就重試，重試完還是不行才往外丟。
    ///
    /// 值得重試的只有傳輸層的抖動：連線被切、逾時、5xx（<see cref="HttpRequestException"/>）、
    /// 讀到一半被截斷的 JSON。這些同一個請求再打一次通常就好了。
    ///
    /// 「回應合法但內容不對」不重試——欄位改名、日期對不上、stat 不是 ok，
    /// 那是對方改版，重打幾次都一樣，而且必須讓它紅出來。
    ///
    /// 重試用完還是失敗就中止整個 export，不退回「沒還原權息的 K 線」：
    /// 那種圖在除權息日會憑空多一段跳空，看起來像真的，事後也查不出來。
    /// 寧可網站停在前一天，也不要畫錯的價格。
    /// </summary>
    private async Task<TResult> WithRetryAsync<TResult>(
        string source,
        Func<CancellationToken, Task<TResult>> read,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await read(cancellationToken);
            }
            catch (Exception exception)
                when (attempt < MaxAttempts && IsTransient(exception, cancellationToken))
            {
                logger.LogWarning(
                    "{Source} 第 {Attempt} 次失敗（{Message}），{Seconds} 秒後重試。",
                    source,
                    attempt,
                    exception.Message,
                    attempt);

                await Task.Delay(TimeSpan.FromSeconds(attempt), cancellationToken);
            }
        }
    }

    private static bool IsTransient(Exception exception, CancellationToken cancellationToken)
        => !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or TaskCanceledException or JsonException or IOException;

    private Task<IReadOnlyList<StockPriceAdjustment>> GetTwseAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken)
        => ReadTwseAsync(
            startDate,
            endDate,
            root => ParseTable(root, Market.Twse, TwseSource, "資料日期", "股票代號"),
            cancellationToken);

    private async Task<TResult> ReadTwseAsync<TResult>(
        DateOnly startDate,
        DateOnly endDate,
        Func<JsonElement, TResult> parse,
        CancellationToken cancellationToken)
    {
        var url = "https://www.twse.com.tw/rwd/zh/exRight/TWT49U"
            + $"?startDate={startDate:yyyyMMdd}&endDate={endDate:yyyyMMdd}&response=json";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Referrer = new Uri(
            "https://www.twse.com.tw/zh/announcement/ex-right/twt49u.html");
        using var response = await httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        RequireJson(response, TwseSource);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;

        RequireStatus(root, TwseSource);
        RequireRange(root, "strDate", $"{startDate:yyyyMMdd}", TwseSource);
        RequireRange(root, "endDate", $"{endDate:yyyyMMdd}", TwseSource);
        return parse(root);
    }

    private Task<IReadOnlyList<StockPriceAdjustment>> GetTpexAsync(
        DateOnly startDate,
        DateOnly endDate,
        CancellationToken cancellationToken)
        => ReadTpexAsync(
            startDate,
            endDate,
            table => ParseTable(table, Market.Tpex, TpexSource, "除權息日期", "代號"),
            cancellationToken);

    private async Task<TResult> ReadTpexAsync<TResult>(
        DateOnly startDate,
        DateOnly endDate,
        Func<JsonElement, TResult> parse,
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

        return parse(tables[0]);
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

    /// <summary>
    /// 和 <see cref="ParseTable"/> 讀同一張表，但不過濾代號形狀，也不因單列異常就中斷。
    /// </summary>
    private static IReadOnlyList<ReferenceAction> ParseActionTable(
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
        var kindIndex = Array.FindIndex(names, name => string.Equals(name, "權/息", StringComparison.Ordinal));
        var result = new List<ReferenceAction>();

        foreach (var row in data.EnumerateArray())
        {
            var ticker = QuoteFieldParser.ReadCell(row, tickerIndex)?.Trim();
            var date = ParseRocDate(QuoteFieldParser.ReadCell(row, dateIndex));
            var previousClose = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, previousCloseIndex));
            var referencePrice = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, referencePriceIndex));

            // 沒有代號、日期或兩個價格的列（備註列、尚未公布參考價的預告）沒有辦法拿來還原，略過。
            if (string.IsNullOrEmpty(ticker) || date is null || previousClose is not > 0m || referencePrice is not > 0m)
            {
                continue;
            }

            var kind = kindIndex >= 0 ? QuoteFieldParser.ReadCell(row, kindIndex)?.Trim() : null;

            result.Add(new ReferenceAction
            {
                Date = date.Value,
                Market = market,
                Ticker = ticker,
                PreviousClose = previousClose.Value,
                ReferencePrice = referencePrice.Value,
                Kind = string.IsNullOrEmpty(kind) ? null : kind,
                Source = source
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
