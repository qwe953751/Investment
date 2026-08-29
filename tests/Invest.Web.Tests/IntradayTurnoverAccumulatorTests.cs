using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData.Intraday;

namespace Invest.Web.Tests;

public class IntradayTurnoverAccumulatorTests
{
    private static readonly DateOnly Today = new(2026, 8, 28);

    private static IntradayQuote Quote(decimal? price, decimal volume, string ticker = "2330")
        => new()
        {
            Market = Market.Twse,
            Ticker = ticker,
            Name = ticker,
            Price = price,
            PriceSource = price is null ? IntradayPriceSource.None : IntradayPriceSource.LastTrade,
            TradingVolume = volume,
            EstimatedTradingValue = price is { } value ? value * volume : 0m
        };

    private static decimal Apply(IntradayTurnoverAccumulator accumulator, IntradayQuote quote, DateOnly? date = null)
        => accumulator.Apply(date ?? Today, [quote]).Single().EstimatedTradingValue;

    [Fact]
    public void 第一輪沒有前一輪可比只能整段用現價計價()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        // 開盤到第一輪之間的量無從拆解，只能沿用舊做法。這是這個演算法唯一保留的近似。
        Assert.Equal(1_000_000m, Apply(accumulator, Quote(100m, 10_000m)));
    }

    [Fact]
    public void 第二輪只把新增的量用當時的價計價()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        Apply(accumulator, Quote(100m, 10_000m));

        // 量從 10,000 增加到 15,000，價漲到 120。新增的 5,000 股用 120 計價，
        // 先前的 10,000 股仍留在 100 的價位——舊做法會把全部 15,000 股都算成 120。
        Assert.Equal(1_600_000m, Apply(accumulator, Quote(120m, 15_000m)));
    }

    [Fact]
    public void 逐輪累加比現價乘累計量更接近真實成交金額()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        // 早盤 10,000 股成交在 100，尾盤 10,000 股成交在 200。真實金額是
        // 10,000×100 + 10,000×200 = 3,000,000。
        Apply(accumulator, Quote(100m, 10_000m));
        var accumulated = Apply(accumulator, Quote(200m, 20_000m));

        const decimal Truth = 3_000_000m;
        const decimal OldWay = 200m * 20_000m;

        Assert.Equal(Truth, accumulated);
        Assert.Equal(4_000_000m, OldWay);
        Assert.True(Math.Abs(accumulated - Truth) < Math.Abs(OldWay - Truth));
    }

    [Fact]
    public void 沒有新成交時金額不會變動()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        Apply(accumulator, Quote(100m, 10_000m));

        // 冷門股整天都是這樣：價格因為買賣中價而跳動，但一股都沒有成交。
        // 金額不能跟著價格漂移，否則沒成交的股票也會憑空長出成交值。
        Assert.Equal(1_000_000m, Apply(accumulator, Quote(130m, 10_000m)));
    }

    [Fact]
    public void 累計量倒退視為重置而不是負的成交()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        Apply(accumulator, Quote(100m, 10_000m));

        // MIS 換日或回傳壞值時累計量會變小。沿用舊累計會把兩天的量疊在一起。
        Assert.Equal(500_000m, Apply(accumulator, Quote(100m, 5_000m)));
    }

    [Fact]
    public void 缺價那一輪的量會留到下一輪有價時才計價()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        Apply(accumulator, Quote(100m, 10_000m));

        // 沒有價就換不成錢，這一輪金額不動。
        Assert.Equal(1_000_000m, Apply(accumulator, Quote(null, 12_000m)));

        // 但那 2,000 股不能消失：下一輪有價時，2,000 + 3,000 一起用 110 計價。
        Assert.Equal(1_000_000m + 5_000m * 110m, Apply(accumulator, Quote(110m, 15_000m)));
    }

    [Fact]
    public void 換交易日重新起算()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        Apply(accumulator, Quote(100m, 10_000m));

        // 跨日沿用昨天的累計量，今天第一輪的增量會變成負的。
        var next = Apply(accumulator, Quote(100m, 3_000m), Today.AddDays(1));

        Assert.Equal(300_000m, next);
        Assert.Equal(1, accumulator.TrackedCount);
    }

    [Fact]
    public void 每一檔各自累加互不影響()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        accumulator.Apply(Today, [Quote(100m, 10_000m, "2330"), Quote(50m, 4_000m, "2317")]);

        var second = accumulator.Apply(Today, [Quote(120m, 15_000m, "2330"), Quote(50m, 4_000m, "2317")]);

        Assert.Equal(1_600_000m, second.Single(quote => quote.Ticker == "2330").EstimatedTradingValue);
        Assert.Equal(200_000m, second.Single(quote => quote.Ticker == "2317").EstimatedTradingValue);
        Assert.Equal(2, accumulator.TrackedCount);
    }

    [Fact]
    public void 沒有成交量的個股金額是零()
    {
        var accumulator = new IntradayTurnoverAccumulator();

        Assert.Equal(0m, Apply(accumulator, Quote(100m, 0m)));
    }
}
