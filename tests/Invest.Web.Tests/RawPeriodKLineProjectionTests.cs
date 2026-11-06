using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;

namespace Invest.Web.Tests;

public sealed class RawPeriodKLineProjectionTests
{
    private static DailyStockTrading Row(string date, decimal open, decimal high, decimal low,
        decimal close, decimal volume = 10m) => new()
    {
        Ticker = "TEST", TradingDate = DateOnly.Parse(date), OpenPrice = open,
        HighPrice = high, LowPrice = low, ClosePrice = close,
        TradingVolume = volume, TradingValue = volume * close
    };

    [Theory]
    [InlineData(KLinePeriod.Week)]
    [InlineData(KLinePeriod.Month)]
    public void 期間中間的影線與成交量都參與彙整且不混入未來(KLinePeriod period)
    {
        var rows = new[] { Row("2026-06-01", 10, 12, 9, 11),
            Row("2026-06-02", 11, 30, 5, 12, 20), Row("2026-06-03", 12, 14, 10, 13),
            Row("2026-06-04", 13, 99, 1, 90) };
        var bar = Assert.Single(RawPeriodKLineProjection.Build(rows, "TEST", period, new(2026, 6, 3)));
        Assert.Equal("2026-06-01", bar.Date);
        Assert.Equal("2026-06-03", bar.EndDate);
        Assert.Equal(10m, bar.Open);
        Assert.Equal(30m, bar.High);
        Assert.Equal(5m, bar.Low);
        Assert.Equal(13m, bar.Close);
        Assert.Equal(40m, bar.TradingVolume);
        Assert.Null(bar.Ma5);
    }

    [Fact]
    public void 首期截斷不當完整棒_均線與指標用全部週期歷史()
    {
        var start = new DateOnly(2024, 1, 1);
        var rows = Enumerable.Range(0, 80).Select(i =>
            Row(start.AddDays(i * 7).ToString("yyyy-MM-dd"), i + 100, i + 102, i + 99, i + 101)).ToArray();
        var bars = RawPeriodKLineProjection.Build(rows, "TEST", KLinePeriod.Week, start.AddYears(2));
        Assert.Equal(80, bars.Count);
        Assert.Equal(178m, bars[^1].Ma5);
        Assert.Equal(150.5m, bars[^1].Ma60);
        Assert.NotNull(bars[^1].KdK);
        Assert.NotNull(bars[^1].MacdHistogram);
        var truncated = rows.Prepend(Row("2023-12-29", 99, 101, 98, 100));
        var safe = RawPeriodKLineProjection.Build(truncated, "TEST", KLinePeriod.Week, start.AddYears(2));
        Assert.Equal(bars, safe);
    }

    [Fact]
    public void 缺開高低的期間不能用剩餘日棒拼出完整影線()
    {
        var rows = new[] { Row("2026-06-01", 10, 12, 9, 11), new DailyStockTrading
            { Ticker = "TEST", TradingDate = new(2026, 6, 2), ClosePrice = 12, TradingValue = 0 } };
        var bar = Assert.Single(RawPeriodKLineProjection.Build(rows, "TEST", KLinePeriod.Week, new(2026, 6, 3)));
        Assert.Null(bar.Open);
        Assert.Null(bar.High);
        Assert.Equal(12m, bar.Close);
    }
}
