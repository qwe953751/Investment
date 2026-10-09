using System.Text.Json;
using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Reference;

namespace Invest.Web.Infrastructure.MarketData.Tpex;

/// <summary>
/// 讀取證券櫃檯買賣中心的上櫃股票每日行情。
///
/// 端點：www/zh-tw/afterTrading/dailyQuotes?date=yyyy/MM/dd&amp;type=EW&amp;response=json
/// 日期參數使用西元年，回應中的 date 欄位則是民國年。
/// </summary>
public sealed class TpexDailyQuoteClient(HttpClient httpClient, ILogger<TpexDailyQuoteClient> logger)
{
    private const string DailyQuoteTableTitleKeyword = "上櫃股票行情";

    public async Task<IReadOnlyList<DailyQuote>> GetDailyQuotesAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
        => await GetDailyQuotesCoreAsync(tradingDate, null, cancellationToken);

    public async Task<IReadOnlyList<DailyQuote>> GetDailyQuotesAsync(
        DateOnly tradingDate,
        IReadOnlySet<string> etfTickers,
        CancellationToken cancellationToken = default)
        => await GetDailyQuotesCoreAsync(tradingDate, etfTickers, cancellationToken);

    private async Task<IReadOnlyList<DailyQuote>> GetDailyQuotesCoreAsync(
        DateOnly tradingDate,
        IReadOnlySet<string>? etfTickers,
        CancellationToken cancellationToken)
    {
        var url = "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"
            + $"?date={tradingDate:yyyy/MM/dd}&type=EW&id=&response=json";

        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        var root = document.RootElement;

        if (!root.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array)
        {
            logger.LogInformation("TPEx {Date:yyyy-MM-dd} 沒有行情資料，視為非交易日。", tradingDate);
            return [];
        }

        var quoteTable = tables.EnumerateArray().FirstOrDefault(table =>
            table.TryGetProperty("title", out var title)
            && title.ValueKind == JsonValueKind.String
            && title.GetString()!.Contains(DailyQuoteTableTitleKeyword, StringComparison.Ordinal));

        if (quoteTable.ValueKind != JsonValueKind.Object
            || !quoteTable.TryGetProperty("fields", out var fields)
            || !quoteTable.TryGetProperty("data", out var rows))
        {
            logger.LogWarning("TPEx {Date:yyyy-MM-dd} 回應中找不到上櫃股票行情表格。", tradingDate);
            return [];
        }

        var columns = DailyQuoteColumns.From(fields);

        if (columns is null)
        {
            logger.LogWarning("TPEx {Date:yyyy-MM-dd} 上櫃股票行情缺少必要欄位，停止解析避免 OHLC 錯位。", tradingDate);
            return [];
        }

        return rows.EnumerateArray()
            .Select(row => ParseRow(row, columns, etfTickers))
            .OfType<DailyQuote>()
            .ToArray();
    }

    /// <summary>
    /// 讀取指定日期每一檔的官方參考價相關欄位（還原權息的依據）。和 <c>GetDailyQuotesAsync</c>
    /// 讀同一份 dailyQuotes 回應，但多取了「漲跌」與「次日 參考價」兩欄；價格與成交欄位的解析完全不動。
    /// </summary>
    /// <param name="include">只保留行情快取裡有的代號（權證等不在範圍內的商品不收）。</param>
    public async Task<IReadOnlyList<ReferenceRow>> GetReferenceRowsAsync(
        DateOnly tradingDate,
        Func<string, bool> include,
        CancellationToken cancellationToken = default)
    {
        var url = "https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"
            + $"?date={tradingDate:yyyy/MM/dd}&type=EW&id=&response=json";

        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        return ParseReferenceRows(document.RootElement, include);
    }

    /// <summary>
    /// 解析上櫃股票行情表的參考價。
    ///
    /// 「漲跌」欄三種長相：帶正負號的數字（參考價 = 收盤 − 漲跌）、「---」（沒有成交）、
    /// 以及除權息當天的文字「除息」「除權」「除權息」——此時不給數字，參考價要靠
    /// 前一個交易日的「次日 參考價」（<see cref="ReferenceRow.NextReference"/>）。
    /// 實測 2026-07-01→07-02、2026-02-02→02-03、2026-08-07→08-10 三組相鄰交易日，
    /// 16,032 筆有數字漲跌的列，「收盤 − 漲跌」全部等於前一日的次日參考價。
    /// </summary>
    internal static IReadOnlyList<ReferenceRow> ParseReferenceRows(JsonElement root, Func<string, bool> include)
    {
        if (!root.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var quoteTable = tables.EnumerateArray().FirstOrDefault(table =>
            table.TryGetProperty("title", out var title)
            && title.ValueKind == JsonValueKind.String
            && title.GetString()!.Contains(DailyQuoteTableTitleKeyword, StringComparison.Ordinal));

        if (quoteTable.ValueKind != JsonValueKind.Object
            || !quoteTable.TryGetProperty("fields", out var fieldArray)
            || fieldArray.ValueKind != JsonValueKind.Array
            || !quoteTable.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var byName = fieldArray.EnumerateArray()
            .Select((field, index) => (Name: DailyQuoteColumns.NormalizeFieldName(field.GetString()), Index: index))
            .Where(field => field.Name.Length > 0)
            .GroupBy(field => field.Name, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().Index, StringComparer.Ordinal);

        if (!byName.TryGetValue("代號", out var tickerColumn)
            || !byName.TryGetValue("收盤", out var closeColumn)
            || !byName.TryGetValue("漲跌", out var changeColumn)
            || !byName.TryGetValue("次日參考價", out var nextReferenceColumn)
            || !byName.TryGetValue("最後買價", out var bidColumn)
            || !byName.TryGetValue("最後賣價", out var askColumn))
        {
            throw new InvalidDataException(
                "櫃買中心上櫃股票行情缺少代號、收盤、漲跌、次日參考價或最後買賣價欄位，停止解析避免參考價錯位。");
        }

        var maxIndex = new[]
        {
            tickerColumn, closeColumn, changeColumn, nextReferenceColumn, bidColumn, askColumn
        }.Max();
        var result = new List<ReferenceRow>();

        foreach (var row in rows.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() <= maxIndex)
            {
                continue;
            }

            var ticker = QuoteFieldParser.ReadCell(row, tickerColumn)?.Trim();

            if (string.IsNullOrEmpty(ticker) || !include(ticker))
            {
                continue;
            }

            var close = QuoteFieldParser.ParseNullableDecimal(QuoteFieldParser.ReadCell(row, closeColumn));
            var nextReference = QuoteFieldParser.ParseNullableDecimal(
                QuoteFieldParser.ReadCell(row, nextReferenceColumn));
            var changeText = (QuoteFieldParser.ReadCell(row, changeColumn) ?? string.Empty).Trim();
            decimal? reference = null;
            string? marker = null;

            if (changeText.Length > 0 && !changeText.All(character => character == '-'))
            {
                if (QuoteFieldParser.ParseNullableDecimal(changeText) is { } change)
                {
                    if (close is { } closePrice)
                    {
                        reference = closePrice - change;
                    }
                }
                else
                {
                    marker = changeText;
                }
            }

            result.Add(new ReferenceRow
            {
                Market = Market.Tpex,
                Ticker = ticker,
                Close = close,
                Reference = reference is > 0m ? reference : null,
                NextReference = nextReference is > 0m ? nextReference : null,
                Marker = reference is > 0m ? null : marker,
                Bid = Positive(QuoteFieldParser.ReadCell(row, bidColumn)),
                Ask = Positive(QuoteFieldParser.ReadCell(row, askColumn))
            });
        }

        return result;
    }

    private static decimal? Positive(string? raw)
        => QuoteFieldParser.ParseNullableDecimal(raw) is > 0m and var value ? value : null;

    /// <summary>
    /// 欄位位置一律由官方回應的 fields 對應，不把目前順序硬編在程式裡。
    /// TPEx 曾在收盤與開盤之間增列漲跌欄；只靠固定索引會把最高、最低與均價整段錯位。
    /// </summary>
    private static DailyQuote? ParseRow(
        JsonElement row,
        DailyQuoteColumns columns,
        IReadOnlySet<string>? etfTickers)
    {
        if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() <= columns.MaxIndex)
        {
            return null;
        }

        var ticker = row[columns.Ticker].GetString()?.Trim();

        var name = row[columns.Name].GetString()?.Trim();
        var kind = QuoteFieldParser.GetTaiwanStockKind(ticker, name, etfTickers);

        if (kind is null)
        {
            return null;
        }

        return new DailyQuote
        {
            Market = Market.Tpex,
            Ticker = ticker!,
            Name = name ?? ticker!,
            Kind = kind.Value,
            ClosePrice = QuoteFieldParser.ParseNullableDecimal(row[columns.Close].GetString()),
            OpenPrice = QuoteFieldParser.ParseNullableDecimal(row[columns.Open].GetString()),
            HighPrice = QuoteFieldParser.ParseNullableDecimal(row[columns.High].GetString()),
            LowPrice = QuoteFieldParser.ParseNullableDecimal(row[columns.Low].GetString()),
            TradingVolume = QuoteFieldParser.ParseDecimal(row[columns.Volume].GetString()),
            TradingValue = QuoteFieldParser.ParseDecimal(row[columns.Value].GetString()),
            TransactionCount = QuoteFieldParser.ParseInt(row[columns.Transactions].GetString())
        };
    }

    private sealed record DailyQuoteColumns(
        int Ticker,
        int Name,
        int Close,
        int Open,
        int High,
        int Low,
        int Volume,
        int Value,
        int Transactions)
    {
        public int MaxIndex => new[]
        {
            Ticker, Name, Close, Open, High, Low, Volume, Value, Transactions
        }.Max();

        public static DailyQuoteColumns? From(JsonElement fields)
        {
            if (fields.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var byName = fields.EnumerateArray()
                .Select((field, index) => new
                {
                    Name = NormalizeFieldName(field.GetString()),
                    Index = index
                })
                .Where(field => field.Name.Length > 0)
                .GroupBy(field => field.Name, StringComparer.Ordinal)
                .ToDictionary(group => group.Key, group => group.First().Index, StringComparer.Ordinal);
            var required = new[]
            {
                "代號", "名稱", "收盤", "開盤", "最高", "最低",
                "成交股數", "成交金額(元)", "成交筆數"
            };

            if (required.Any(field => !byName.ContainsKey(field)))
            {
                return null;
            }

            return new DailyQuoteColumns(
                byName["代號"],
                byName["名稱"],
                byName["收盤"],
                byName["開盤"],
                byName["最高"],
                byName["最低"],
                byName["成交股數"],
                byName["成交金額(元)"],
                byName["成交筆數"]);
        }

        internal static string NormalizeFieldName(string? value)
            => string.Concat((value ?? string.Empty).Where(character => !char.IsWhiteSpace(character)));
    }
}
