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
    /// </summary>
    public static decimal? YearToDateChangePercent(
        IReadOnlyList<DailyMarketIndex> history,
        DateOnly endDate,
        Market market,
        decimal? currentValue = null)
    {
        var baselineDate = new DateOnly(endDate.Year - 1, 12, 31);
        var baseline = FindValue(history, baselineDate, market);
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

    private static decimal? FindValue(
        IReadOnlyList<DailyMarketIndex> history,
        DateOnly throughDate,
        Market market)
        => history
            .Where(day => day.TradingDate <= throughDate)
            .OrderByDescending(day => day.TradingDate)
            .Select(day => day.Quotes.FirstOrDefault(quote => quote.Market == market))
            .Where(quote => quote is not null && quote.Value > 0m)
            .Select(quote => (decimal?)quote!.Value)
            .FirstOrDefault();
}
