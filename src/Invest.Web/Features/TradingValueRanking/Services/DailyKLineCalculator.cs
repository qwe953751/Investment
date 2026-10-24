using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>
/// 從官方原始行情與除權息 P0/P1 產生向前還原的 K 棒與移動平均。
/// 日 K、週 K、月 K 共用同一份逐日還原序列（<see cref="AdjustedRows"/>），
/// 還原倍率只在這裡套用一次，週／月 K 不會有自己的還原邏輯。
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
        => Calculate(
            AdjustedRows(trading, adjustments, ticker, adjustmentThroughDate),
            startDate,
            endDate);

    /// <summary>
    /// 把一檔標的的原始行情逐日換算成向前還原的序列（由舊到新）。
    /// 收盤價有效的交易日都會留下，並標明那天的開高低收能不能畫成 K 棒：
    /// 缺開高低的舊資料仍可作為均線暖身，價格關係不可能的資料則整列不進圖表與均線，
    /// 但仍保留在序列裡，讓週／月 K 知道那個週期有一天被擋下、不能假裝完整。
    /// </summary>
    internal static IReadOnlyList<AdjustedDailyRow> AdjustedRows(
        IEnumerable<DailyStockTrading> trading,
        IEnumerable<StockPriceAdjustment> adjustments,
        string ticker,
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
        var result = new List<AdjustedDailyRow>(rows.Length);

        foreach (var row in rows)
        {
            var state = row.OpenPrice is null || row.HighPrice is null || row.LowPrice is null
                ? AdjustedRowState.CloseOnly
                : DailyBarValidator.IsValid(
                    row.OpenPrice,
                    row.HighPrice,
                    row.LowPrice,
                    row.ClosePrice)
                    ? AdjustedRowState.Bar
                    : AdjustedRowState.Rejected;
            var factor = events
                .Where(item => row.TradingDate < item.EffectiveDate)
                .Aggregate(1m, (current, item) => current * item.Factor);
            var isBar = state == AdjustedRowState.Bar;

            result.Add(new AdjustedDailyRow(
                row.TradingDate,
                state,
                isBar ? row.OpenPrice!.Value * factor : null,
                isBar ? row.HighPrice!.Value * factor : null,
                isBar ? row.LowPrice!.Value * factor : null,
                row.ClosePrice!.Value * factor,
                row.TradingVolume));
        }

        return result;
    }

    internal static IReadOnlyList<DailyKLinePoint> Calculate(
        IReadOnlyList<AdjustedDailyRow> rows,
        DateOnly startDate,
        DateOnly endDate)
    {
        var prefixCloseSums = new List<decimal>(rows.Count + 1) { 0m };
        var result = new List<DailyKLinePoint>();
        decimal? previousClose = null;

        foreach (var row in rows)
        {
            // 價格關係不可能的資料不進圖表，也不進均線與前收。
            if (row.State == AdjustedRowState.Rejected)
            {
                continue;
            }

            prefixCloseSums.Add(prefixCloseSums[^1] + row.Close);
            var closeBeforeThisBar = previousClose;
            previousClose = row.Close;

            if (row.TradingDate < startDate
                || row.TradingDate > endDate
                || row.State != AdjustedRowState.Bar)
            {
                continue;
            }

            result.Add(new DailyKLinePoint(
                row.TradingDate,
                row.Open!.Value,
                row.High!.Value,
                row.Low!.Value,
                row.Close,
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

    /// <summary>
    /// 以前綴和算最後一筆的 N 期簡單移動平均；不足 N 期為 null。日、週、月 K 共用。
    /// </summary>
    internal static decimal? MovingAverage(IReadOnlyList<decimal> prefixSums, int period)
    {
        var count = prefixSums.Count - 1;
        return count < period
            ? null
            : (prefixSums[count] - prefixSums[count - period]) / period;
    }
}

/// <summary>
/// 還原序列中一個交易日的狀態。
/// </summary>
internal enum AdjustedRowState
{
    /// <summary>開高低收齊全且價格關係合法，可以畫成 K 棒。</summary>
    Bar,

    /// <summary>只有收盤價（舊資料缺開高低）：不畫 K 棒，但收盤仍計入均線。</summary>
    CloseOnly,

    /// <summary>開高低收都有但價格關係不可能：整列不進圖表與均線。</summary>
    Rejected
}

/// <summary>
/// 已套用除權息還原倍率的一個交易日。開高低只有 <see cref="AdjustedRowState.Bar"/> 才有值。
/// </summary>
internal sealed record AdjustedDailyRow(
    DateOnly TradingDate,
    AdjustedRowState State,
    decimal? Open,
    decimal? High,
    decimal? Low,
    decimal Close,
    decimal? TradingVolume);

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
    // 紅漲綠跌比同一根棒子自己的開盤價，不是比前一交易日收盤——這是傳統 K 棒的讀法，
    // 使用者要看的是「這根棒子今天走出來的方向」，不是「今天收盤跟昨天比是漲是跌」。
    public static DailyKLineTrend Get(DailyKLinePoint point)
    {
        return point.Close > point.Open
            ? DailyKLineTrend.Up
            : point.Close < point.Open
                ? DailyKLineTrend.Down
                : DailyKLineTrend.Unchanged;
    }
}
