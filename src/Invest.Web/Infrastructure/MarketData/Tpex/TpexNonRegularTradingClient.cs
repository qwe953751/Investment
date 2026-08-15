using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.Tpex;

/// <summary>
/// 讀取上櫃市場的非一般交易，用來從每日收盤行情裡把它們扣掉。
///
/// 櫃買的每日收盤行情標題是「不含定價」，所以盤後定價不用扣，
/// 要扣的只有盤中零股（oddQuote）、盤後零股（odd）與鉅額（blockTrade/quote）。
/// </summary>
public sealed class TpexNonRegularTradingClient(
    HttpClient httpClient,
    ILogger<TpexNonRegularTradingClient> logger)
{
    public async Task<IReadOnlyDictionary<string, NonRegularTrading>> GetNonRegularTradingAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var accumulator = new NonRegularTradingAccumulator();
        var date = tradingDate.ToString("yyyy/MM/dd");

        // 盤中零股：0 代號、7 成交股數、8 成交金額。
        await AccumulateAsync(
            $"https://www.tpex.org.tw/www/zh-tw/afterTrading/oddQuote?date={date}&type=Daily&response=json",
            "盤中零股", tradingDate, accumulator, tickerIndex: 0, volumeIndex: 7, valueIndex: 8,
            cancellationToken);

        // 盤後零股：0 代號、2 成交股數、4 成交金額。
        await AccumulateAsync(
            $"https://www.tpex.org.tw/www/zh-tw/afterTrading/odd?date={date}&type=Daily&response=json",
            "盤後零股", tradingDate, accumulator, tickerIndex: 0, volumeIndex: 2, valueIndex: 4,
            cancellationToken);

        // 鉅額：2 代號、5 成交股數、6 成交值。一檔股票當日可能有多筆，逐筆累加。
        await AccumulateAsync(
            $"https://www.tpex.org.tw/www/zh-tw/blockTrade/quote?date={date}&response=json",
            "鉅額交易", tradingDate, accumulator, tickerIndex: 2, volumeIndex: 5, valueIndex: 6,
            cancellationToken);

        return accumulator.Totals;
    }

    private async Task AccumulateAsync(
        string url,
        string reportName,
        DateOnly tradingDate,
        NonRegularTradingAccumulator accumulator,
        int tickerIndex,
        int volumeIndex,
        int valueIndex,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (!document.RootElement.TryGetProperty("tables", out var tables)
            || tables.ValueKind != JsonValueKind.Array)
        {
            logger.LogDebug("TPEx {Date:yyyy-MM-dd} 的{Report}報表沒有資料。", tradingDate, reportName);
            return;
        }

        foreach (var table in tables.EnumerateArray())
        {
            if (!table.TryGetProperty("data", out var rows) || rows.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            foreach (var row in rows.EnumerateArray())
            {
                accumulator.Add(
                    QuoteFieldParser.ReadCell(row, tickerIndex)?.Trim(),
                    QuoteFieldParser.ParseCell(row, valueIndex),
                    QuoteFieldParser.ParseCell(row, volumeIndex));
            }
        }
    }
}
