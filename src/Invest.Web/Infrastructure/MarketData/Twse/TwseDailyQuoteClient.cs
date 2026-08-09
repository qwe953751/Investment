using System.Text.Json;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData.Twse;

/// <summary>
/// 讀取臺灣證券交易所的每日收盤行情。
///
/// 一次請求即可取得當日全部上市個股，不需要逐檔查詢。
/// 端點：rwd/zh/afterTrading/MI_INDEX?date=yyyyMMdd&amp;type=ALLBUT0999&amp;response=json
/// </summary>
public sealed class TwseDailyQuoteClient(HttpClient httpClient, ILogger<TwseDailyQuoteClient> logger)
{
    private const string DailyQuoteTableTitleKeyword = "每日收盤行情";

    public async Task<IReadOnlyList<DailyQuote>> GetDailyQuotesAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var url = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
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
            return [];
        }

        var quoteTable = tables.EnumerateArray().FirstOrDefault(table =>
            table.TryGetProperty("title", out var title)
            && title.ValueKind == JsonValueKind.String
            && title.GetString()!.Contains(DailyQuoteTableTitleKeyword, StringComparison.Ordinal));

        if (quoteTable.ValueKind != JsonValueKind.Object
            || !quoteTable.TryGetProperty("data", out var rows))
        {
            logger.LogWarning("TWSE {Date:yyyy-MM-dd} 回應中找不到每日收盤行情表格。", tradingDate);
            return [];
        }

        return rows.EnumerateArray()
            .Select(ParseRow)
            .OfType<DailyQuote>()
            .ToArray();
    }

    /// <summary>
    /// 欄位順序：0 證券代號、1 證券名稱、2 成交股數、3 成交筆數、4 成交金額、8 收盤價。
    /// </summary>
    private static DailyQuote? ParseRow(JsonElement row)
    {
        if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() < 9)
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
            Market = Market.Twse,
            Ticker = ticker!,
            Name = row[1].GetString()?.Trim() ?? ticker!,
            TradingVolume = QuoteFieldParser.ParseDecimal(row[2].GetString()),
            TransactionCount = QuoteFieldParser.ParseInt(row[3].GetString()),
            TradingValue = QuoteFieldParser.ParseDecimal(row[4].GetString()),
            ClosePrice = QuoteFieldParser.ParseNullableDecimal(row[8].GetString())
        };
    }
}
