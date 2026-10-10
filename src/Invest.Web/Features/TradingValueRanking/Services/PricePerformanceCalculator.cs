using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 以同一個價格基準計算日、週與年初至今漲跌幅。
///
/// 排行、ETF／TDR 盤後快照、盤中收集器與其他需要價格表現的畫面都從這裡取公式；前端只格式化結果，
/// 不在瀏覽器重新推導基準價。
///
/// <para>
/// 基準價的規則（盤中盤後必須一致，這裡是唯一定義處）：
/// </para>
/// <list type="bullet">
/// <item><description>
/// <b>日</b>：當天的基準價 <see cref="DailyStockTrading.ReferencePrice"/>（前一日收盤，前一日沒有成交時依
/// 委託簿規則決定，並換算過當天的權益事件）；該天沒有官方參考價資料時，退回前收盤乘事件倍數。
/// </description></item>
/// <item><description>
/// <b>週</b>、<b>年初至今</b>：期初之前最後一個收盤，乘上期間內所有權益事件的倍數。
/// 期初之前沒有收盤（今年才掛牌）時，起算點改用掛牌參考價（<see cref="ListingReference"/>），
/// 結果標示為「掛牌以來」。
/// </description></item>
/// </list>
/// </summary>
public static class PricePerformanceCalculator
{
    public static PricePerformance Calculate(
        IEnumerable<DailyStockTrading> source,
        IEnumerable<StockPriceAdjustment> sourceAdjustments,
        DateOnly endDate,
        ListingReference? listing = null)
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
        decimal? endReference = null;

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
                endReference = row.ReferencePrice;
            }

            if (row.TradingDate <= previousYearEnd)
            {
                yearToDateBaseline = close;
                yearToDateBaselineDate = row.TradingDate;
            }
        }

        var adjustedDaily = endReference is > 0m
            ? endReference
            : Rebase(dailyBaseline, dailyBaselineDate, endCloseDate, adjustments);

        // 期初之前沒有收盤，但這檔是期間內才掛牌的：用掛牌參考價當起點（「掛牌以來」）。
        var weeklyFromListing = false;
        var yearToDateFromListing = false;

        if (weeklyBaseline is null && listing is { } weeklyListing && weeklyListing.Date >= weekStart)
        {
            weeklyBaseline = weeklyListing.Reference;
            weeklyBaselineDate = weeklyListing.Date;
            weeklyFromListing = true;
        }

        if (yearToDateBaseline is null && listing is { } yearListing && yearListing.Date > previousYearEnd)
        {
            yearToDateBaseline = yearListing.Reference;
            yearToDateBaselineDate = yearListing.Date;
            yearToDateFromListing = true;
        }

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
            adjustedYearToDate,
            weeklyFromListing,
            yearToDateFromListing);
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
    decimal? YearToDateBaselineClose,
    bool WeeklyFromListing = false,
    bool YearToDateFromListing = false);
