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
            || !quoteTable.TryGetProperty("data", out var rows))
        {
            logger.LogWarning("TPEx {Date:yyyy-MM-dd} 回應中找不到上櫃股票行情表格。", tradingDate);
            return [];
        }

        return rows.EnumerateArray()
            .Select(ParseRow)
            .OfType<DailyQuote>()
            .ToArray();
    }

    /// <summary>
    /// 欄位順序：0 代號、1 名稱、2 收盤、5 開盤、6 最高、7 最低、
    /// 8 成交股數、9 成交金額、10 成交筆數。
    /// </summary>
    private static DailyQuote? ParseRow(JsonElement row)
    {
        if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() < 11)
        {
            return null;
        }

        var ticker = row[0].GetString()?.Trim();

        if (!QuoteFieldParser.IsCommonStockTicker(ticker))
        {
            return null;
        }

        return new DailyQuote
        {
            Market = Market.Tpex,
            Ticker = ticker!,
            Name = row[1].GetString()?.Trim() ?? ticker!,
            ClosePrice = QuoteFieldParser.ParseNullableDecimal(row[2].GetString()),
            OpenPrice = QuoteFieldParser.ParseNullableDecimal(row[5].GetString()),
            HighPrice = QuoteFieldParser.ParseNullableDecimal(row[6].GetString()),
            LowPrice = QuoteFieldParser.ParseNullableDecimal(row[7].GetString()),
            TradingVolume = QuoteFieldParser.ParseDecimal(row[8].GetString()),
            TradingValue = QuoteFieldParser.ParseDecimal(row[9].GetString()),
            TransactionCount = QuoteFieldParser.ParseInt(row[10].GetString())
        };
    }
}
