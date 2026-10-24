using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Services;

public enum KLinePeriod
{
    /// <summary>週一到週日為一週，只算實際有交易的日子。</summary>
    Week,

    /// <summary>日曆月，只算實際有交易的日子。</summary>
    Month
}

/// <summary>
/// 把向前還原的日 K 序列彙整成週 K、月 K，週期內每一天都參與計算。
///
/// 規則（前端組「還沒走完的最後一根」時照抄這份，兩邊靠共用的
/// tests/fixtures/kline-period-parity.json 釘住一致）：
/// <list type="bullet">
/// <item>開 = 週期第一個交易日的開盤；收 = 最後一個交易日的收盤。</item>
/// <item>高、低 = 週期內每一個交易日的最高、最低，不是只看第一天與最後一天——
/// 週中的高低點才是這根 K 棒的影線。</item>
/// <item>量 = 週期內成交股數加總。</item>
/// <item>前收 = 上一個週期的收盤。</item>
/// <item>均線 = 週期收盤的 N 期簡單平均（週 K 是 N 週，月 K 是 N 個月），不足 N 期為 null。</item>
/// <item>週期內只要有一天缺開高低，或被擋下為不可能的價格，這個週期就不畫 K 棒
/// （<see cref="PeriodKLinePoint.HasBar"/> 為 false），不用剩下幾天猜一根假的；
/// 但它的收盤照常計入均線，與日 K「缺開高低的舊資料仍可作為均線暖身」同一原則。</item>
/// </list>
/// 還原倍率已在逐日序列套用，所以週中除權息不會在彙整後出現假缺口。
/// </summary>
public static class PeriodKLineCalculator
{
    public static DateOnly PeriodStart(DateOnly date, KLinePeriod period) => period switch
    {
        // DayOfWeek 週日 = 0；((d + 6) % 7) 讓週一 = 0、週日 = 6。
        KLinePeriod.Week => date.AddDays(-(((int)date.DayOfWeek + 6) % 7)),
        KLinePeriod.Month => new DateOnly(date.Year, date.Month, 1),
        _ => throw new ArgumentOutOfRangeException(nameof(period), period, null)
    };

    public static IReadOnlyList<PeriodKLinePoint> Calculate(
        IEnumerable<DailyStockTrading> trading,
        IEnumerable<StockPriceAdjustment> adjustments,
        string ticker,
        KLinePeriod period,
        DateOnly adjustmentThroughDate)
        => Calculate(
            DailyKLineCalculator.AdjustedRows(trading, adjustments, ticker, adjustmentThroughDate),
            period);

    internal static IReadOnlyList<PeriodKLinePoint> Calculate(
        IReadOnlyList<AdjustedDailyRow> rows,
        KLinePeriod period)
    {
        var prefixCloseSums = new List<decimal> { 0m };
        var result = new List<PeriodKLinePoint>();
        decimal? previousClose = null;

        // rows 已由舊到新排序，GroupBy 依首次出現順序輸出，週期也就由舊到新。
        foreach (var group in rows.GroupBy(row => PeriodStart(row.TradingDate, period)))
        {
            var all = group.ToArray();
            var usable = all.Where(row => row.State != AdjustedRowState.Rejected).ToArray();

            // 整個週期都被擋下，沒有任何可信的收盤：不產生這個週期。
            if (usable.Length == 0)
            {
                continue;
            }

            var close = usable[^1].Close;
            prefixCloseSums.Add(prefixCloseSums[^1] + close);
            var drawable = all.All(row => row.State == AdjustedRowState.Bar);
            var volumes = usable.Where(row => row.TradingVolume is not null).ToArray();

            result.Add(new PeriodKLinePoint(
                group.Key,
                usable[0].TradingDate,
                usable[^1].TradingDate,
                drawable ? all[0].Open : null,
                drawable ? all.Max(row => row.High) : null,
                drawable ? all.Min(row => row.Low) : null,
                close,
                previousClose,
                DailyKLineCalculator.MovingAverage(prefixCloseSums, 5),
                DailyKLineCalculator.MovingAverage(prefixCloseSums, 10),
                DailyKLineCalculator.MovingAverage(prefixCloseSums, 20),
                DailyKLineCalculator.MovingAverage(prefixCloseSums, 60),
                DailyKLineCalculator.MovingAverage(prefixCloseSums, 240),
                volumes.Length == 0 ? null : volumes.Sum(row => row.TradingVolume)));
            previousClose = close;
        }

        return result;
    }
}

/// <summary>
/// 一根週 K 或月 K。<see cref="Open"/>、<see cref="High"/>、<see cref="Low"/> 為 null 代表這個週期
/// 不能畫成 K 棒（見 <see cref="PeriodKLineCalculator"/>），但收盤與均線仍有值，後面的週期要靠它們算均線。
/// </summary>
public sealed record PeriodKLinePoint(
    DateOnly PeriodStart,
    DateOnly FirstTradingDate,
    DateOnly LastTradingDate,
    decimal? Open,
    decimal? High,
    decimal? Low,
    decimal Close,
    decimal? PreviousClose,
    decimal? Ma5,
    decimal? Ma10,
    decimal? Ma20,
    decimal? Ma60,
    decimal? Ma240,
    decimal? TradingVolume)
{
    public bool HasBar => Open is not null && High is not null && Low is not null;
}
