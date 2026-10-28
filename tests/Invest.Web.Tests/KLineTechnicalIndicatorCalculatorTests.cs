using Invest.Web.Domain.Indicators;

namespace Invest.Web.Tests;

public sealed class KLineTechnicalIndicatorCalculatorTests
{
    private sealed record Bar(decimal? High, decimal? Low, decimal Close);

    [Fact]
    public void 固定價格先暖身_不足期數留空_零價差KD中性()
    {
        var bars = Enumerable.Range(0, 36).Select(_ => new Bar(100m, 100m, 100m)).ToArray();
        var values = KLineTechnicalIndicatorCalculator.Calculate(bars, bar => bar.High, bar => bar.Low, bar => bar.Close);

        Assert.Null(values[7].KdK);
        Assert.Equal(50m, values[8].KdK);
        Assert.Equal(50m, values[8].KdD);
        Assert.Null(values[24].MacdDif);
        Assert.Equal(0m, values[25].MacdDif);
        Assert.Null(values[32].MacdSignal);
        Assert.Equal(0m, values[33].MacdSignal);
        Assert.Equal(0m, values[33].MacdHistogram);
    }

    [Fact]
    public void 缺OHLC時KD重新暖身_MACD保留收盤暖身但該棒不畫()
    {
        var bars = Enumerable.Range(0, 45).Select(index => new Bar(110m, 90m, 100m + index)).ToArray();
        bars[35] = new Bar(null, null, 135m);
        var values = KLineTechnicalIndicatorCalculator.Calculate(bars, bar => bar.High, bar => bar.Low, bar => bar.Close);

        Assert.NotNull(values[34].MacdHistogram);
        Assert.Null(values[35].MacdHistogram);
        Assert.Null(values[35].KdK);
        Assert.NotNull(values[36].MacdHistogram);
        Assert.Null(values[43].KdK);
        Assert.NotNull(values[44].KdK);
    }
}
