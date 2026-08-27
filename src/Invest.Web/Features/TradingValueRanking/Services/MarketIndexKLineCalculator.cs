using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 從官方市場指數 OHLC 與個股成交值產生指數日 K。
///
/// 指數本身沒有獨立的成交金額欄位，因此下層量柱採同一市場個股一般交易成交值加總；
/// 這個定義跟排行榜使用的成交值相同，並且不在瀏覽器重新計算。
/// </summary>
public static class MarketIndexKLineCalculator
{
    public static IReadOnlyList<MarketIndexKLinePoint> Calculate(
        IEnumerable<DailyMarketIndex> indices,
        IEnumerable<DailyStockTrading> trading,
        IReadOnlyDictionary<string, Market> stockMarkets,
        Market market,
        DateOnly startDate,
        DateOnly endDate)
    {
        if (endDate < startDate)
        {
            return [];
        }

        var turnoverByDate = trading
            .Where(row => stockMarkets.TryGetValue(row.Ticker, out var rowMarket)
                && rowMarket == market)
            .GroupBy(row => row.TradingDate)
            .ToDictionary(group => group.Key, group => group.Sum(row => row.TradingValue));

        var rows = indices
            .OrderBy(day => day.TradingDate)
            .Select(day =>
            {
                var quote = day.Quotes.FirstOrDefault(item => item.Market == market);

                return quote is
                {
                    Value: > 0m,
                    OpenPrice: > 0m,
                    HighPrice: > 0m,
                    LowPrice: > 0m
                }
                    ? new IndexBar(
                        day.TradingDate,
                        quote.OpenPrice!.Value,
                        quote.HighPrice!.Value,
                        quote.LowPrice!.Value,
                        quote.Value)
                    : null;
            })
            .OfType<IndexBar>()
            .ToArray();

        var closeSums = new List<decimal>(rows.Length + 1) { 0m };
        var result = new List<MarketIndexKLinePoint>();
        decimal? previousClose = null;

        foreach (var row in rows)
        {
            closeSums.Add(closeSums[^1] + row.Close);
            var closeBeforeThisBar = previousClose;
            previousClose = row.Close;

            if (row.Date < startDate || row.Date > endDate)
            {
                continue;
            }

            result.Add(new MarketIndexKLinePoint(
                row.Date,
                row.Open,
                row.High,
                row.Low,
                row.Close,
                closeBeforeThisBar,
                MovingAverage(closeSums, 5),
                MovingAverage(closeSums, 10),
                MovingAverage(closeSums, 20),
                MovingAverage(closeSums, 60),
                MovingAverage(closeSums, 240),
                turnoverByDate.TryGetValue(row.Date, out var tradingValue)
                    ? tradingValue
                    : null));
        }

        return result;
    }

    private static decimal? MovingAverage(IReadOnlyList<decimal> closeSums, int period)
    {
        var count = closeSums.Count - 1;
        return count < period
            ? null
            : (closeSums[count] - closeSums[count - period]) / period;
    }

    private sealed record IndexBar(
        DateOnly Date,
        decimal Open,
        decimal High,
        decimal Low,
        decimal Close);
}

public sealed record MarketIndexKLinePoint(
    DateOnly TradingDate,
    decimal Open,
    decimal High,
    decimal Low,
    decimal Close,
    decimal? PreviousClose,
    decimal? Ma5,
    decimal? Ma10,
    decimal? Ma20,
    decimal? Ma60,
    decimal? Ma240,
    decimal? TradingValue);
