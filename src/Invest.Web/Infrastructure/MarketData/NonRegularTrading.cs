namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 某一檔股票當日「非一般交易」的成交量值。
///
/// 官方每日收盤行情的註記寫得很清楚：「本統計資訊含一般、零股、盤後定價、鉅額交易」。
/// 但市場上看的成交值排行（玩股網、籌碼K 等）只算一般交易，
/// 兩者的差距在高價股上特別明顯——台積電當日就差了 59 億，足以改變排名。
/// 因此回補行情時要逐檔把這些非一般交易扣掉。
/// </summary>
public readonly record struct NonRegularTrading(decimal TradingValue, decimal TradingVolume)
{
    public static NonRegularTrading operator +(NonRegularTrading left, NonRegularTrading right)
        => new(
            left.TradingValue + right.TradingValue,
            left.TradingVolume + right.TradingVolume);
}

/// <summary>
/// 把多份報表的非一般交易逐檔累加起來。一檔股票同一天可能同時有零股與鉅額交易。
/// </summary>
internal sealed class NonRegularTradingAccumulator
{
    private readonly Dictionary<string, NonRegularTrading> _totals = new(StringComparer.Ordinal);

    public void Add(string? ticker, decimal tradingValue, decimal tradingVolume)
    {
        // 排行只看一般股票，ETF 與權證的扣除額拿了也用不到。
        if (!QuoteFieldParser.IsCommonStockTicker(ticker))
        {
            return;
        }

        var entry = new NonRegularTrading(tradingValue, tradingVolume);
        _totals[ticker!] = _totals.TryGetValue(ticker!, out var existing) ? existing + entry : entry;
    }

    public IReadOnlyDictionary<string, NonRegularTrading> Totals => _totals;
}
