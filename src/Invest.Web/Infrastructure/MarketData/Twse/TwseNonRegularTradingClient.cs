using System.Text.Json;

namespace Invest.Web.Infrastructure.MarketData.Twse;

/// <summary>
/// 讀取上市市場的非一般交易，用來從每日收盤行情裡把它們扣掉。
///
/// 證交所把四種交易併在同一個成交金額裡，但各自有獨立的報表可以查：
/// 盤中零股（TWTC7U）、盤後零股（TWT53U）、盤後定價（BFT41U）、鉅額（BFIAUU）。
/// 四份報表都是一次給當日全市場，不需要逐檔查詢。
/// </summary>
public sealed class TwseNonRegularTradingClient(
    HttpClient httpClient,
    ILogger<TwseNonRegularTradingClient> logger)
{
    /// <summary>
    /// 盤後定價報表的「成交數量」單位是張，其餘報表都是股。
    /// </summary>
    private const decimal SharesPerLot = 1000m;

    public async Task<IReadOnlyDictionary<string, NonRegularTrading>> GetNonRegularTradingAsync(
        DateOnly tradingDate,
        CancellationToken cancellationToken = default)
    {
        var accumulator = new NonRegularTradingAccumulator();
        var date = tradingDate.ToString("yyyyMMdd");

        // 盤中零股：0 證券代號、2 成交股數、4 成交金額。
        await AccumulateAsync(
            $"https://www.twse.com.tw/rwd/zh/afterTrading/TWTC7U?date={date}&response=json",
            "盤中零股", tradingDate, accumulator, tickerIndex: 0, volumeIndex: 2, valueIndex: 4,
            volumeScale: 1m, cancellationToken);

        // 盤後零股：0 證券代號、2 成交股數、4 成交金額。
        await AccumulateAsync(
            $"https://www.twse.com.tw/rwd/zh/afterTrading/TWT53U?date={date}&response=json",
            "盤後零股", tradingDate, accumulator, tickerIndex: 0, volumeIndex: 2, valueIndex: 4,
            volumeScale: 1m, cancellationToken);

        // 盤後定價：0 證券代號、2 成交數量（張）、4 成交金額。
        await AccumulateAsync(
            $"https://www.twse.com.tw/rwd/zh/afterTrading/BFT41U?date={date}&response=json",
            "盤後定價", tradingDate, accumulator, tickerIndex: 0, volumeIndex: 2, valueIndex: 4,
            volumeScale: SharesPerLot, cancellationToken);

        // 鉅額：0 證券代號、4 成交股數、5 成交金額。最後一列是「總計」，代號不是數字所以會被濾掉。
        //
        // selectType=S 只涵蓋「單一證券」的鉅額交易。另有 selectType=M 的「股票組合」，
        // 但官方只給組合的合計，不逐檔拆開，因此無法歸屬到個股。
        // 組合鉅額的量很小（2026-08-07 全市場只有兩筆共 2,487 萬元），
        // 會讓極少數個股的成交值高估約 0.1%，不足以影響名次。
        await AccumulateAsync(
            $"https://www.twse.com.tw/rwd/zh/block/BFIAUU?date={date}&selectType=S&response=json",
            "鉅額交易", tradingDate, accumulator, tickerIndex: 0, volumeIndex: 4, valueIndex: 5,
            volumeScale: 1m, cancellationToken);

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
        decimal volumeScale,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);

        if (!document.RootElement.TryGetProperty("data", out var rows)
            || rows.ValueKind != JsonValueKind.Array)
        {
            // 非交易日、或當天這一類交易完全沒有成交時就沒有 data 欄位，兩者都不算異常。
            logger.LogDebug("TWSE {Date:yyyy-MM-dd} 的{Report}報表沒有資料。", tradingDate, reportName);
            return;
        }

        foreach (var row in rows.EnumerateArray())
        {
            accumulator.Add(
                QuoteFieldParser.ReadCell(row, tickerIndex)?.Trim(),
                QuoteFieldParser.ParseCell(row, valueIndex),
                QuoteFieldParser.ParseCell(row, volumeIndex) * volumeScale);
        }
    }
}
