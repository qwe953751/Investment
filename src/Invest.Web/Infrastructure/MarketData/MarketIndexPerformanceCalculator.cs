using Invest.Web.Domain.Stocks;

namespace Invest.Web.Infrastructure.MarketData;

/// <summary>
/// 市場指數的年初至今績效計算。盤後匯出、Blazor 頁面與盤中收集器共用，
/// 避免不同入口各自挑不同的年初基準。
/// </summary>
public static class MarketIndexPerformanceCalculator
{
    /// <summary>
    /// 以指定日期以前、前一年年底以前最後一個有效交易日為基準，
    /// 回傳百分比數字，例如 1.25 代表 +1.25%。
    ///
    /// 找不到「去年 12 月的收盤」就回 null 讓畫面顯示 —，不會一路往回找。
    /// 往回找會拿到看起來很正常、卻錯得離譜的數字：手上的歷史只到 11 月時，
    /// 「今年以來」會變成「從去年 11 月以來」，多算一整個 12 月的漲跌，
    /// 而畫面上完全看不出這件事。台股每年最後一個交易日一定落在 12 月下旬，
    /// 所以基準日沒落在 12 月，就是我們的歷史真的缺了年底那一段。
    /// </summary>
    public static decimal? YearToDateChangePercent(
        IReadOnlyList<DailyMarketIndex> history,
        DateOnly endDate,
        Market market,
        decimal? currentValue = null)
    {
        var previousYear = endDate.Year - 1;
        var baseline = FindValue(
            history,
            new DateOnly(previousYear, 12, 31),
            market,
            new DateOnly(previousYear, 12, 1));
        var ending = currentValue ?? FindValue(history, endDate, market);

        if (!baseline.HasValue || baseline.Value <= 0m || !ending.HasValue || ending.Value <= 0m)
        {
            return null;
        }

        var baseValue = baseline.Value;
        var endValue = ending.Value;

        return decimal.Round(
            (endValue - baseValue) / baseValue * 100m,
            2,
            MidpointRounding.AwayFromZero);
    }

    /// <param name="notBefore">
    /// 往回找的下限。年初基準用得到，收盤值不需要（<paramref name="throughDate"/> 本來就是最新那天）。
    /// </param>
    private static decimal? FindValue(
        IReadOnlyList<DailyMarketIndex> history,
        DateOnly throughDate,
        Market market,
        DateOnly? notBefore = null)
        => history
            .Where(day => day.TradingDate <= throughDate
                && (notBefore is not { } floor || day.TradingDate >= floor))
            .OrderByDescending(day => day.TradingDate)
            .Select(day => day.Quotes.FirstOrDefault(quote => quote.Market == market))
            .Where(quote => quote is not null && quote.Value > 0m)
            .Select(quote => (decimal?)quote!.Value)
            .FirstOrDefault();
}
