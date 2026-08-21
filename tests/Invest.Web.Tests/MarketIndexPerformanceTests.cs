using Invest.Web.Domain.Stocks;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class MarketIndexPerformanceTests
{
    [Fact]
    public void 年初漲幅使用前一年最後可用交易日的指數作為基準()
    {
        var history = new DailyMarketIndex[]
        {
            Day(new DateOnly(2025, 12, 30), 100m, 200m),
            Day(new DateOnly(2025, 12, 31), 110m, 220m),
            Day(new DateOnly(2026, 1, 2), 120m, 210m),
            Day(new DateOnly(2026, 8, 20), 132m, 231m)
        };

        Assert.Equal(
            20m,
            MarketIndexPerformanceCalculator.YearToDateChangePercent(
                history,
                new DateOnly(2026, 8, 20),
                Market.Twse));

        Assert.Equal(
            -4.55m,
            MarketIndexPerformanceCalculator.YearToDateChangePercent(
                history,
                new DateOnly(2026, 1, 2),
                Market.Tpex));
    }

    [Fact]
    public void 缺少年初基準時回傳空值而不是假造百分比()
    {
        var history = new DailyMarketIndex[]
        {
            Day(new DateOnly(2026, 1, 2), 120m, 210m)
        };

        Assert.Null(
            MarketIndexPerformanceCalculator.YearToDateChangePercent(
                history,
                new DateOnly(2026, 1, 2),
                Market.Twse));
    }

    private static DailyMarketIndex Day(DateOnly date, decimal twse, decimal tpex) => new()
    {
        TradingDate = date,
        Quotes =
        [
            new MarketIndexQuote { Market = Market.Twse, Value = twse },
            new MarketIndexQuote { Market = Market.Tpex, Value = tpex }
        ]
    };
}
