using System.Globalization;
using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Infrastructure.MarketData.Twse;

/// <summary>
/// 讀取臺灣證券交易所的每日收盤行情。
///
/// 一次請求即可取得當日全部上市個股，不需要逐檔查詢。
/// 端點：wwwc.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=yyyyMMdd&amp;type=ALLBUT0999&amp;response=json
/// </summary>
public sealed class TwseDailyQuoteClient(HttpClient httpClient, ILogger<TwseDailyQuoteClient> logger)
{
    private const string DailyQuoteTableTitleKeyword = "每日收盤行情";
    private const string PriceIndexTableTitleKeyword = "價格指數";
    private const string MarketSummaryIndexField = "發行量加權股價指數";

    public async Task<IReadOnlyList<DailyQuote>> GetDailyQuotesAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
        => (await GetDailyDataCoreAsync(tradingDate, null, cancellationToken)).Quotes;

    public async Task<IReadOnlyList<DailyQuote>> GetDailyQuotesAsync(
        DateOnly tradingDate,
        IReadOnlySet<string> etfTickers,
        CancellationToken cancellationToken = default)
        => (await GetDailyDataCoreAsync(tradingDate, etfTickers, cancellationToken)).Quotes;

    public Task<TwseDailyData> GetDailyDataAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
        => GetDailyDataCoreAsync(tradingDate, null, cancellationToken);

    public Task<TwseDailyData> GetDailyDataAsync(
        DateOnly tradingDate,
        IReadOnlySet<string> etfTickers,
        CancellationToken cancellationToken = default)
        => GetDailyDataCoreAsync(tradingDate, etfTickers, cancellationToken);

    private async Task<TwseDailyData> GetDailyDataCoreAsync(
        DateOnly tradingDate,
        IReadOnlySet<string>? etfTickers,
        CancellationToken cancellationToken)
    {
        var url = "https://wwwc.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
            + $"?date={tradingDate:yyyyMMdd}&type=ALLBUT0999&response=json";

        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        var root = document.RootElement;

        if (!root.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array)
        {
            // 非交易日時回傳 {"stat":"很抱歉，沒有符合條件的資料!"}，沒有 tables 欄位。
            logger.LogInformation("TWSE {Date:yyyy-MM-dd} 沒有行情資料，視為非交易日。", tradingDate);
            return new([], null);
        }

        var quoteTable = tables.EnumerateArray().FirstOrDefault(table =>
            table.TryGetProperty("title", out var title)
            && title.ValueKind == JsonValueKind.String
            && title.GetString()!.Contains(DailyQuoteTableTitleKeyword, StringComparison.Ordinal));

        IReadOnlyList<DailyQuote> quotes = [];

        if (quoteTable.ValueKind == JsonValueKind.Object
            && quoteTable.TryGetProperty("data", out var rows)
            && rows.ValueKind == JsonValueKind.Array)
        {
            quotes = rows.EnumerateArray()
                .Select(row => ParseRow(row, etfTickers))
                .OfType<DailyQuote>()
                .ToArray();
        }
        else
        {
            logger.LogWarning("TWSE {Date:yyyy-MM-dd} 回應中找不到每日收盤行情表格。", tradingDate);
        }

        var indexTable = tables.EnumerateArray().FirstOrDefault(table =>
            table.TryGetProperty("title", out var title)
            && title.ValueKind == JsonValueKind.String
            && title.GetString()!.Contains(PriceIndexTableTitleKeyword, StringComparison.Ordinal));

        return new(quotes, ParseMarketIndex(indexTable));
    }

    /// <summary>
    /// 讀取指定日期每一檔上市證券的官方開盤競價基準（參考價），是還原權息的依據。
    ///
    /// 來源是證交所「股價升降幅度」(TWT84U)：開盤前就公布、一次涵蓋全部證券（不論當天有沒有成交），
    /// 而且除權息、減資、分割、停牌恢復當天的基準都已經換算好。收盤行情表的「漲跌」欄在這些日子
    /// 只標 X、不給數字，所以不能拿它當參考價的來源。
    /// </summary>
    /// <param name="include">只保留行情快取裡有的代號（認購權證等不在範圍內的商品不收）。</param>
    public async Task<IReadOnlyList<ReferenceRow>> GetReferenceRowsAsync(
        DateOnly tradingDate,
        Func<string, bool> include,
        CancellationToken cancellationToken = default)
    {
        // ALLBUT0999 排除權證，約 1,400 列、130 KB；ALL 含權證有三萬六千列、近 4 MB，沒有必要。
        var url = "https://www.twse.com.tw/exchangeReport/TWT84U"
            + $"?response=json&date={tradingDate:yyyyMMdd}&selectType=ALLBUT0999";

        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        return ParseReferenceRows(document.RootElement, tradingDate, include);
    }

    /// <summary>
    /// 解析 TWT84U。欄位有兩個同名的「開盤競價基準」，所以不能依名稱找，只能依位置——
    /// 官方的分組是 [證券代號、名稱] [本日：漲停價、開盤競價基準、跌停價]
    /// [前日：開盤競價基準、收盤價、買進揭示價、賣出揭示價] [最近成交日、可否零股交易]。
    /// 位置對不上就丟例外，不在錯位的欄位上猜。
    ///
    /// 前日的收盤價、揭示買賣價在前一日沒有成交（或沒有委託）時是「--」或 0.00，一律當作沒有。
    /// </summary>
    internal static IReadOnlyList<ReferenceRow> ParseReferenceRows(
        JsonElement root,
        DateOnly expectedDate,
        Func<string, bool> include)
    {
        if (!root.TryGetProperty("stat", out var status)
            || !string.Equals(status.GetString(), "OK", StringComparison.OrdinalIgnoreCase))
        {
            // 非交易日：「很抱歉，沒有符合條件的資料!」。
            return [];
        }

        // 回應的日期必須是要求的那一天；官方偶爾會把查不到的日期導回最近一天。
        var echoed = root.TryGetProperty("date", out var dateValue) ? dateValue.GetString() : null;

        if (!string.Equals(echoed, $"{expectedDate:yyyyMMdd}", StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                $"證交所股價升降幅度回應日期 {echoed ?? "—"}，與要求的 {expectedDate:yyyyMMdd} 不符。");
        }

        if (!root.TryGetProperty("fields", out var fieldArray)
            || fieldArray.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("證交所股價升降幅度回應缺少 fields 或 data。");
        }

        string?[] expectedFields =
        [
            "證券代號", "證券名稱", "漲停價", "開盤競價基準", "跌停價",
            "開盤競價基準", "收盤價", "買進揭示價", "賣出揭示價", "最近成交日"
        ];
        var fields = fieldArray.EnumerateArray().Select(field => field.GetString()).ToArray();

        if (fields.Length < expectedFields.Length
            || !expectedFields.Select((name, index) => fields[index] == name).All(match => match))
        {
            throw new InvalidDataException("證交所股價升降幅度的欄位順序和預期不同，停止解析避免參考價錯位。");
        }

        const int TickerColumn = 0;
        const int ReferenceColumn = 3;
        const int PreviousReferenceColumn = 5;
        const int PreviousCloseColumn = 6;
        const int PreviousBidColumn = 7;
        const int PreviousAskColumn = 8;
        var result = new List<ReferenceRow>();

        foreach (var row in rows.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() <= PreviousAskColumn)
            {
                continue;
            }

            var ticker = QuoteFieldParser.ReadCell(row, TickerColumn)?.Trim();

            if (string.IsNullOrEmpty(ticker) || !include(ticker))
            {
                continue;
            }

            result.Add(new ReferenceRow
            {
                Market = Market.Twse,
                Ticker = ticker,
                Reference = Positive(QuoteFieldParser.ReadCell(row, ReferenceColumn)),
                PreviousReference = Positive(QuoteFieldParser.ReadCell(row, PreviousReferenceColumn)),
                PreviousClose = Positive(QuoteFieldParser.ReadCell(row, PreviousCloseColumn)),
                PreviousBid = Positive(QuoteFieldParser.ReadCell(row, PreviousBidColumn)),
                PreviousAsk = Positive(QuoteFieldParser.ReadCell(row, PreviousAskColumn))
            });
        }

        return result;
    }

    private static decimal? Positive(string? raw)
        => QuoteFieldParser.ParseNullableDecimal(raw) is > 0m and var value ? value : null;

    public async Task<MarketIndexQuote?> GetMarketIndexAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var url = "https://wwwc.twse.com.tw/exchangeReport/FMTQIK"
            + $"?date={tradingDate:yyyyMMdd}&response=json";

        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        return ParseMarketSummaryIndex(document.RootElement, tradingDate);
    }

    /// <summary>
    /// 讀取臺灣證券交易所的指數日 K。MI_INDEX 只有收盤指數，不能拿來畫 K 棒；
    /// MI_5MINS_HIST 雖然名稱帶有 5 分鐘，但官方回應同時提供每個交易日的開高低收，
    /// 因此這裡用月份查詢後挑出指定日期。
    /// </summary>
    public async Task<MarketIndexQuote?> GetMarketIndexWithBarsAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var monthStart = new DateOnly(tradingDate.Year, tradingDate.Month, 1);
        var url = "https://www.twse.com.tw/indicesReport/MI_5MINS_HIST"
            + $"?date={monthStart:yyyyMMdd}&response=json";

        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        return ParseMarketIndexBar(document.RootElement, tradingDate);
    }

    /// <summary>
    /// 欄位順序：0 證券代號、1 證券名稱、2 成交股數、3 成交筆數、4 成交金額、
    /// 5 開盤價、6 最高價、7 最低價、8 收盤價。
    /// </summary>
    private static DailyQuote? ParseRow(JsonElement row, IReadOnlySet<string>? etfTickers)
    {
        if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() < 9)
        {
            return null;
        }

        var ticker = row[0].GetString()?.Trim();

        var name = row[1].GetString()?.Trim();
        var kind = QuoteFieldParser.GetTaiwanStockKind(ticker, name, etfTickers);

        if (kind is null)
        {
            return null;
        }

        return new DailyQuote
        {
            Market = Market.Twse,
            Ticker = ticker!,
            Name = name ?? ticker!,
            Kind = kind.Value,
            TradingVolume = QuoteFieldParser.ParseDecimal(row[2].GetString()),
            TransactionCount = QuoteFieldParser.ParseInt(row[3].GetString()),
            TradingValue = QuoteFieldParser.ParseDecimal(row[4].GetString()),
            OpenPrice = QuoteFieldParser.ParseNullableDecimal(row[5].GetString()),
            HighPrice = QuoteFieldParser.ParseNullableDecimal(row[6].GetString()),
            LowPrice = QuoteFieldParser.ParseNullableDecimal(row[7].GetString()),
            ClosePrice = QuoteFieldParser.ParseNullableDecimal(row[8].GetString())
        };
    }

    private static MarketIndexQuote? ParseMarketIndex(JsonElement table)
    {
        if (table.ValueKind != JsonValueKind.Object
            || !table.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var fields = table.TryGetProperty("fields", out var fieldArray)
            && fieldArray.ValueKind == JsonValueKind.Array
            ? fieldArray.EnumerateArray()
                .Select(field => field.ValueKind == JsonValueKind.String ? field.GetString() : null)
                .ToArray()
            : [];

        var nameIndex = FindField(fields, "指數") ?? 0;
        var valueIndex = FindField(fields, "收盤指數", "收市") ?? (fields.Length > 1 ? 1 : 0);
        var percentIndex = FindField(fields, "漲跌百分比(%)", "漲跌百分比");
        var pointsIndex = FindField(fields, "漲跌點數", "漲跌");

        foreach (var row in rows.EnumerateArray())
        {
            var name = QuoteFieldParser.ReadCell(row, nameIndex)?.Trim();

            if (name is null || !name.Contains("發行量加權股價指數", StringComparison.Ordinal))
            {
                continue;
            }

            var value = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, valueIndex));

            if (value is not { } indexValue || indexValue <= 0)
            {
                return null;
            }

            var changePercent = percentIndex is { } percent
                ? QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, percent))
                : null;

            if (changePercent is null && pointsIndex is { } points)
            {
                var changePoints = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, points));

                if (changePoints is { } pointsValue)
                {
                    var previousClose = indexValue - pointsValue;

                    if (previousClose > 0)
                    {
                        changePercent = decimal.Round(pointsValue / previousClose * 100m, 2);
                    }
                }
            }

            return new MarketIndexQuote
            {
                Market = Market.Twse,
                Value = indexValue,
                ChangePercent = changePercent
            };
        }

        return null;
    }

    private static MarketIndexQuote? ParseMarketSummaryIndex(JsonElement root, DateOnly tradingDate)
    {
        if (!root.TryGetProperty("fields", out var fieldArray)
            || fieldArray.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var fields = fieldArray.EnumerateArray()
            .Select(field => field.ValueKind == JsonValueKind.String ? field.GetString() : null)
            .ToArray();
        var dateIndex = FindField(fields, "日期");
        var valueIndex = FindField(fields, MarketSummaryIndexField);
        var pointsIndex = FindField(fields, "漲跌點數");

        if (dateIndex is not { } dateColumn || valueIndex is not { } valueColumn)
        {
            return null;
        }

        var targetDate = $"{tradingDate.Year - 1911:000}/{tradingDate:MM/dd}";

        foreach (var row in rows.EnumerateArray())
        {
            if (!string.Equals(
                    QuoteFieldParser.ReadCell(row, dateColumn)?.Trim(),
                    targetDate,
                    StringComparison.Ordinal))
            {
                continue;
            }

            var value = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, valueColumn));

            if (value is not { } indexValue || indexValue <= 0)
            {
                return null;
            }

            decimal? changePercent = null;

            if (pointsIndex is { } pointsColumn)
            {
                var changePoints = QuoteFieldParser.ParseNullableDecimal(
                    QuoteFieldParser.ReadCell(row, pointsColumn));

                if (changePoints is { } pointsValue)
                {
                    var previousClose = indexValue - pointsValue;

                    if (previousClose > 0)
                    {
                        changePercent = decimal.Round(pointsValue / previousClose * 100m, 2);
                    }
                }
            }

            return new MarketIndexQuote
            {
                Market = Market.Twse,
                Value = indexValue,
                ChangePercent = changePercent
            };
        }

        return null;
    }

    private static MarketIndexQuote? ParseMarketIndexBar(JsonElement root, DateOnly tradingDate)
    {
        if (!root.TryGetProperty("fields", out var fieldArray)
            || fieldArray.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var fields = fieldArray.EnumerateArray()
            .Select(field => field.ValueKind == JsonValueKind.String ? field.GetString() : null)
            .ToArray();
        var dateIndex = FindField(fields, "日期");
        var openIndex = FindField(fields, "開盤指數", "開盤", "開市");
        var highIndex = FindField(fields, "最高指數", "最高");
        var lowIndex = FindField(fields, "最低指數", "最低");
        var closeIndex = FindField(fields, "收盤指數", "收盤", "收市");

        if (dateIndex is not { } dateColumn
            || openIndex is not { } openColumn
            || highIndex is not { } highColumn
            || lowIndex is not { } lowColumn
            || closeIndex is not { } closeColumn)
        {
            return null;
        }

        var bars = rows.EnumerateArray()
            .Select(row =>
            {
                var date = ParseDate(QuoteFieldParser.ReadCell(row, dateColumn));
                var open = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, openColumn));
                var high = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, highColumn));
                var low = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, lowColumn));
                var close = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, closeColumn));

                return date is { } validDate
                    && open is > 0m
                    && high is > 0m
                    && low is > 0m
                    && close is > 0m
                    ? new MarketIndexBar(validDate, open.Value, high.Value, low.Value, close.Value)
                    : null;
            })
            .OfType<MarketIndexBar>()
            .OrderBy(bar => bar.Date)
            .ToArray();

        var current = bars.FirstOrDefault(bar => bar.Date == tradingDate);

        if (current is null)
        {
            return null;
        }

        var previous = bars.LastOrDefault(bar => bar.Date < tradingDate);

        return new MarketIndexQuote
        {
            Market = Market.Twse,
            Value = current.Close,
            OpenPrice = current.Open,
            HighPrice = current.High,
            LowPrice = current.Low,
            ChangePercent = previous is { Close: > 0m }
                ? decimal.Round((current.Close - previous.Close) / previous.Close * 100m, 2)
                : null
        };
    }

    private static DateOnly? ParseDate(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var parts = raw.Trim().Replace('-', '/').Split('/');

        if (parts.Length == 3
            && int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var year)
            && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var month)
            && int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out var day))
        {
            if (year < 1911)
            {
                year += 1911;
            }

            return DateOnly.TryParseExact(
                $"{year:0000}/{month:00}/{day:00}",
                "yyyy/MM/dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var date)
                ? date
                : null;
        }

        return DateOnly.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed
            : null;
    }

    private sealed record MarketIndexBar(
        DateOnly Date,
        decimal Open,
        decimal High,
        decimal Low,
        decimal Close);

    private static int? FindField(IReadOnlyList<string?> fields, params string[] names)
    {
        for (var index = 0; index < fields.Count; index++)
        {
            if (fields[index] is { } field
                && names.Any(name => string.Equals(field, name, StringComparison.Ordinal)))
            {
                return index;
            }
        }

        return null;
    }
}

public sealed record TwseDailyData(
    IReadOnlyList<DailyQuote> Quotes,
    MarketIndexQuote? MarketIndex);
