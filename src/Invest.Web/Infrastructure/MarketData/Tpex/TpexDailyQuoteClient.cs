using System.Text.Json;
using Invest.Web.Domain.Stocks;

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
            .Select(row => ParseRow(row, columns))
            .OfType<DailyQuote>()
            .ToArray();
    }

    /// <summary>
    /// 欄位位置一律由官方回應的 fields 對應，不把目前順序硬編在程式裡。
    /// TPEx 曾在收盤與開盤之間增列漲跌欄；只靠固定索引會把最高、最低與均價整段錯位。
    /// </summary>
    private static DailyQuote? ParseRow(JsonElement row, DailyQuoteColumns columns)
    {
        if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() <= columns.MaxIndex)
        {
            return null;
        }

        var ticker = row[columns.Ticker].GetString()?.Trim();

        if (!QuoteFieldParser.IsCommonStockTicker(ticker))
        {
            return null;
        }

        return new DailyQuote
        {
            Market = Market.Tpex,
            Ticker = ticker!,
            Name = row[columns.Name].GetString()?.Trim() ?? ticker!,
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

        private static string NormalizeFieldName(string? value)
            => string.Concat((value ?? string.Empty).Where(character => !char.IsWhiteSpace(character)));
    }
}
