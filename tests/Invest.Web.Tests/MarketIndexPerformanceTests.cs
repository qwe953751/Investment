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

    [Fact]
    public void 歷史缺了年底那一段時不會退回去拿十一月當年初基準()
    {
        // 拿 11/28 當基準的話會算出 +10%，看起來完全正常，實際上多算了一整個 12 月。
        // 這種錯誤在畫面上看不出來，所以寧可顯示 —。
        var history = new DailyMarketIndex[]
        {
            Day(new DateOnly(2025, 11, 28), 100m, 200m),
            Day(new DateOnly(2026, 8, 20), 110m, 220m)
        };

        Assert.Null(
            MarketIndexPerformanceCalculator.YearToDateChangePercent(
                history,
                new DateOnly(2026, 8, 20),
                Market.Twse));
    }

    [Fact]
    public void 十二月只要有任何一天就算得出來()
    {
        // 下限是 12/01 而不是「一定要有 12/31」：台股最後一個交易日不固定，
        // 而且該年最後一個交易日之後放假，12 月下旬任何一天都是合理的年底收盤。
        var history = new DailyMarketIndex[]
        {
            Day(new DateOnly(2025, 12, 1), 100m, 200m),
            Day(new DateOnly(2026, 8, 20), 110m, 220m)
        };

        Assert.Equal(
            10m,
            MarketIndexPerformanceCalculator.YearToDateChangePercent(
                history,
                new DateOnly(2026, 8, 20),
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
