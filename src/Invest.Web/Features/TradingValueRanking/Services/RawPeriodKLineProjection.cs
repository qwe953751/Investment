using Invest.Web.Domain.Indicators;
using Invest.Web.Domain.Stocks;

namespace Invest.Web.Features.TradingValueRanking.Services;

/// <summary>未還原市場共用的週／月輸出；日行情不截成三個月後才彙整。</summary>
public static class RawPeriodKLineProjection
{
    public static IReadOnlyList<RawPeriodKLineBar> Build(
        IEnumerable<DailyStockTrading> trading, string ticker, KLinePeriod period, DateOnly through)
    {
        var rows = trading.Where(r => r.Ticker == ticker && r.TradingDate <= through)
            .OrderBy(r => r.TradingDate).ToArray();
        // 快取首日可能落在週／月中途；不把截斷的首期當完整棒或均線暖身。
        if (rows.Length > 0 && rows[0].TradingDate > PeriodKLineCalculator.PeriodStart(rows[0].TradingDate, period))
            rows = rows.Where(r => PeriodKLineCalculator.PeriodStart(r.TradingDate, period)
                > PeriodKLineCalculator.PeriodStart(rows[0].TradingDate, period)).ToArray();
        var points = PeriodKLineCalculator.Calculate(rows, [], ticker, period, through);
        var indicators = KLineTechnicalIndicatorCalculator.Calculate(points, p => p.High, p => p.Low, p => p.Close);
        return points.Select((p, i) => new RawPeriodKLineBar(
            p.FirstTradingDate.ToString("yyyy-MM-dd"), p.LastTradingDate.ToString("yyyy-MM-dd"),
            p.Open, p.High, p.Low, p.Close, p.PreviousClose,
            p.Ma5, p.Ma10, p.Ma20, p.Ma60, p.Ma240, p.TradingVolume,
            indicators[i].KdK, indicators[i].KdD, indicators[i].MacdDif,
            indicators[i].MacdSignal, indicators[i].MacdHistogram)).ToArray();
    }
}

public sealed record RawPeriodKLineBar(
    string Date, string EndDate, decimal? Open, decimal? High, decimal? Low,
    decimal Close, decimal? PreviousClose, decimal? Ma5, decimal? Ma10, decimal? Ma20,
    decimal? Ma60, decimal? Ma240, decimal? TradingVolume, decimal? KdK, decimal? KdD,
    decimal? MacdDif, decimal? MacdSignal, decimal? MacdHistogram)
{
    public decimal? TradingValue { get; init; }
}
