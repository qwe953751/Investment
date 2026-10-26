using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.PeriodHistory;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>既有完整行情優先；獨立摘要只補缺口。最後統一收盤序列重算均線，避免兩份公式或來源接縫。</summary>
public static class PeriodKLineHistoryMerger
{
    public static DateOnly PeriodEnd(DateOnly start, KLinePeriod period) => period == KLinePeriod.Month
        ? new DateOnly(start.Year, start.Month, 1).AddMonths(1).AddDays(-1)
        : PeriodKLineCalculator.PeriodStart(start, period).AddDays(6);

    public static IReadOnlyList<PeriodKLinePoint> Merge(
        IReadOnlyList<PeriodKLinePoint> existing, IReadOnlyList<DailyStockTrading> trading,
        IReadOnlyList<DateOnly> marketDates, PeriodHistoryFile? history, KLinePeriod period,
        IReadOnlyList<StockPriceAdjustment> adjustments, DateOnly through)
    {
        if (history is null) return existing;
        if (!history.IsValid || history.AdjustmentThrough > through)
            throw new InvalidDataException("週月 K 摘要的版本或還原基準與本輪行情不相容。");

        var byPeriod = new SortedDictionary<DateOnly, PeriodKLinePoint>();
        var factor = adjustments.Where(a => a.Ticker == history.Ticker
                && a.EffectiveDate > history.AdjustmentThrough && a.EffectiveDate <= through)
            .Aggregate(1m, (value, a) => value * a.Factor);
        foreach (var bar in period == KLinePeriod.Week ? history.Weekly : history.Monthly)
        {
            if (bar.EndDate > through) continue;
            var start = PeriodKLineCalculator.PeriodStart(bar.Date, period);
            byPeriod[start] = new(start, bar.Date, bar.EndDate, bar.Open * factor,
                bar.High * factor, bar.Low * factor, bar.Close * factor,
                null, null, null, null, null, null, bar.TradingVolume);
        }

        var rowsByDate = trading.ToDictionary(row => row.TradingDate);
        foreach (var point in existing)
        {
            var complete = HasCompleteCoverage(point, rowsByDate, marketDates, period, through);
            // 沒有外部摘要時仍保留可信收盤；缺一個交易日也不能把剩下幾天畫成完整棒。
            if (complete || !byPeriod.ContainsKey(point.PeriodStart))
                byPeriod[point.PeriodStart] = complete ? point : point with { Open = null, High = null, Low = null };
        }

        var sums = new List<decimal> { 0m };
        var result = new List<PeriodKLinePoint>();
        decimal? previous = null;
        foreach (var point in byPeriod.Values)
        {
            sums.Add(sums[^1] + point.Close);
            result.Add(point with
            {
                PreviousClose = previous,
                Ma5 = DailyKLineCalculator.MovingAverage(sums, 5),
                Ma10 = DailyKLineCalculator.MovingAverage(sums, 10),
                Ma20 = DailyKLineCalculator.MovingAverage(sums, 20),
                Ma60 = DailyKLineCalculator.MovingAverage(sums, 60),
                Ma240 = DailyKLineCalculator.MovingAverage(sums, 240)
            });
            previous = point.Close;
        }
        return result;
    }

    internal static bool HasCompleteCoverage(PeriodKLinePoint point,
        IReadOnlyDictionary<DateOnly, DailyStockTrading> rows, IReadOnlyList<DateOnly> calendar,
        KLinePeriod period, DateOnly through)
        => calendar.Count > 0 && calendar[0] <= point.PeriodStart
            && HasCoverageFrom(point, rows, calendar, period, through, point.PeriodStart, false);

    internal static bool HasCompleteCoverageSince(PeriodKLinePoint point,
        IReadOnlyDictionary<DateOnly, DailyStockTrading> rows, IReadOnlyList<DateOnly> calendar,
        KLinePeriod period, DateOnly through, DateOnly officialFirst)
        => HasCoverageFrom(point, rows, calendar, period, through, officialFirst, true);

    private static bool HasCoverageFrom(PeriodKLinePoint point,
        IReadOnlyDictionary<DateOnly, DailyStockTrading> rows, IReadOnlyList<DateOnly> calendar,
        KLinePeriod period, DateOnly through, DateOnly first, bool requireFirstMatch)
    {
        var end = PeriodEnd(point.PeriodStart, period);
        var expected = calendar.Where(date => date >= first && date <= end && date <= through).ToArray();
        return point.HasBar && first >= point.PeriodStart && first <= end
            && (!requireFirstMatch || point.FirstTradingDate == first) && expected.Length > 0
            && expected.All(date => rows.TryGetValue(date, out var row) && row.TradingVolume is >= 0m
                && (DailyBarValidator.IsValid(row.OpenPrice, row.HighPrice, row.LowPrice, row.ClosePrice)
                    || row.TradingVolume == 0m && row.TradingValue == 0m && row.OpenPrice is null && row.HighPrice is null
                        && row.LowPrice is null && row.ClosePrice is null));
    }
}
