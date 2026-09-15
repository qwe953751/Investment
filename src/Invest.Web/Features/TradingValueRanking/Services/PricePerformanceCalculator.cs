using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 以同一個價格基準計算日、週與年初至今漲跌幅。
///
/// 排行、ETF 盤後快照與其他需要價格表現的畫面都從這裡取公式；前端只格式化結果，
/// 不在瀏覽器重新推導基準價。
/// </summary>
public static class PricePerformanceCalculator
{
    public static PricePerformance Calculate(
        IEnumerable<DailyStockTrading> source,
        IEnumerable<StockPriceAdjustment> sourceAdjustments,
        DateOnly endDate)
    {
        var rows = source
            .Where(row => row.TradingDate <= endDate)
            .OrderBy(row => row.TradingDate)
            .ToArray();
        var adjustments = sourceAdjustments
            .OrderBy(adjustment => adjustment.EffectiveDate)
            .ToArray();

        var daysSinceMonday = ((int)endDate.DayOfWeek + 6) % 7;
        var weekStart = endDate.AddDays(-daysSinceMonday);
        var previousYearEnd = new DateOnly(endDate.Year - 1, 12, 31);
        decimal? dailyBaseline = null;
        DateOnly? dailyBaselineDate = null;
        decimal? weeklyBaseline = null;
        DateOnly? weeklyBaselineDate = null;
        decimal? yearToDateBaseline = null;
        DateOnly? yearToDateBaselineDate = null;
        decimal? endClose = null;
        DateOnly? endCloseDate = null;

        foreach (var row in rows)
        {
            if (row.ClosePrice is not { } close)
            {
                continue;
            }

            if (row.TradingDate < weekStart)
            {
                weeklyBaseline = close;
                weeklyBaselineDate = row.TradingDate;
            }

            if (row.TradingDate < endDate)
            {
                dailyBaseline = close;
                dailyBaselineDate = row.TradingDate;
            }
            else
            {
                endClose = close;
                endCloseDate = row.TradingDate;
            }

            if (row.TradingDate <= previousYearEnd)
            {
                yearToDateBaseline = close;
                yearToDateBaselineDate = row.TradingDate;
            }
        }

        var adjustedDaily = Rebase(dailyBaseline, dailyBaselineDate, endCloseDate, adjustments);
        var adjustedWeekly = Rebase(weeklyBaseline, weeklyBaselineDate, endCloseDate, adjustments);
        var adjustedYearToDate = Rebase(
            yearToDateBaseline,
            yearToDateBaselineDate,
            endCloseDate,
            adjustments);

        return new PricePerformance(
            ChangeRate(endClose, adjustedDaily),
            ChangeRate(endClose, adjustedWeekly),
            ChangeRate(endClose, adjustedYearToDate),
            adjustedWeekly,
            adjustedYearToDate);
    }

    /// <summary>
    /// 把某天的收盤價換算到另一個日期的價格基準上，避免除權息被誤算成跌幅。
    /// </summary>
    internal static decimal? Rebase(
        decimal? baseline,
        DateOnly? baselineDate,
        DateOnly? basisDate,
        IReadOnlyList<StockPriceAdjustment> adjustments)
    {
        if (baseline is not { } value || baselineDate is not { } from || basisDate is not { } through)
        {
            return baseline;
        }

        var factor = 1m;

        foreach (var adjustment in adjustments)
        {
            if (adjustment.EffectiveDate > from && adjustment.EffectiveDate <= through)
            {
                factor *= adjustment.Factor;
            }
        }

        return value * factor;
    }

    private static decimal? ChangeRate(decimal? current, decimal? baseline)
        => current is { } value && baseline is > 0m
            ? (value - baseline.Value) / baseline.Value
            : null;
}

public sealed record PricePerformance(
    decimal? DailyChangeRate,
    decimal? WeeklyChangeRate,
    decimal? YearToDateChangeRate,
    decimal? WeeklyBaselineClose,
    decimal? YearToDateBaselineClose);
