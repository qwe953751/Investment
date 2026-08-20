using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 取一檔標的截至指定交易日的日 K。只有官方同時提供開高低收的交易日才畫入，
/// 不用缺欄位的資料猜一根假的 K 棒。
/// </summary>
public static class DailyKLineSelector
{
    public const int DefaultMonths = 3;

    public static IReadOnlyList<DailyKLinePoint> Select(
        IEnumerable<DailyStockTrading> trading,
        string ticker,
        DateOnly endDate,
        int months = DefaultMonths)
        => Select(trading, [], ticker, endDate, endDate, months);

    public static IReadOnlyList<DailyKLinePoint> Select(
        IEnumerable<DailyStockTrading> trading,
        IEnumerable<StockPriceAdjustment> adjustments,
        string ticker,
        DateOnly endDate,
        DateOnly adjustmentThroughDate,
        int months = DefaultMonths)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(months, 1);
        return DailyKLineCalculator.Calculate(
            trading,
            adjustments,
            ticker,
            endDate.AddMonths(-months),
            endDate,
            adjustmentThroughDate);
    }
}
