using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 從官方原始行情與除權息 P0/P1 產生向前還原的 K 棒與移動平均。
/// </summary>
public static class DailyKLineCalculator
{
    public static IReadOnlyList<DailyKLinePoint> Calculate(
        IEnumerable<DailyStockTrading> trading,
        IEnumerable<StockPriceAdjustment> adjustments,
        string ticker,
        DateOnly startDate,
        DateOnly endDate,
        DateOnly adjustmentThroughDate)
    {
        var rows = trading
            .Where(row => row.Ticker == ticker
                && row.TradingDate <= adjustmentThroughDate
                && row.ClosePrice is > 0m)
            .OrderBy(row => row.TradingDate)
            .ToArray();
        var events = adjustments
            .Where(item => item.Ticker == ticker
                && item.EffectiveDate <= adjustmentThroughDate
                && item.PreviousClose > 0m
                && item.ReferencePrice > 0m)
            .OrderBy(item => item.EffectiveDate)
            .ToArray();
        var prefixCloseSums = new List<decimal>(rows.Length + 1) { 0m };
        var result = new List<DailyKLinePoint>();
        decimal? previousClose = null;

        foreach (var row in rows)
        {
            var factor = events
                .Where(item => row.TradingDate < item.EffectiveDate)
                .Aggregate(1m, (current, item) => current * item.Factor);
            var close = row.ClosePrice!.Value * factor;
            prefixCloseSums.Add(prefixCloseSums[^1] + close);
            var closeBeforeThisBar = previousClose;
            previousClose = close;

            if (row.TradingDate < startDate
                || row.TradingDate > endDate
                || row.OpenPrice is null
                || row.HighPrice is null
                || row.LowPrice is null)
            {
                continue;
            }

            result.Add(new DailyKLinePoint(
                row.TradingDate,
                row.OpenPrice.Value * factor,
                row.HighPrice.Value * factor,
                row.LowPrice.Value * factor,
                close,
                closeBeforeThisBar,
                MovingAverage(prefixCloseSums, 5),
                MovingAverage(prefixCloseSums, 10),
                MovingAverage(prefixCloseSums, 20),
                MovingAverage(prefixCloseSums, 60),
                MovingAverage(prefixCloseSums, 240),
                row.TradingVolume));
        }

        return result;
    }

    private static decimal? MovingAverage(IReadOnlyList<decimal> prefixSums, int period)
    {
        var count = prefixSums.Count - 1;
        return count < period
            ? null
            : (prefixSums[count] - prefixSums[count - period]) / period;
    }
}

public sealed record DailyKLinePoint(
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
    decimal? TradingVolume = null);

public enum DailyKLineTrend
{
    Up,
    Down,
    Unchanged
}

public static class DailyKLineTrendCalculator
{
    public static DailyKLineTrend Get(DailyKLinePoint point)
    {
        var referenceClose = point.PreviousClose ?? point.Open;

        return point.Close > referenceClose
            ? DailyKLineTrend.Up
            : point.Close < referenceClose
                ? DailyKLineTrend.Down
                : DailyKLineTrend.Unchanged;
    }
}
