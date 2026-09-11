using Invest.Web.Infrastructure.MarketData.Overview;

namespace Invest.Web.Tests;

public sealed class MarketOverviewCalculatorTests
{
    [Fact]
    public void 計算指數的日漲跌幅()
    {
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 4), ("^GSPC", 100m, 0m)),
            Snapshot(new DateOnly(2026, 9, 5), ("^GSPC", 105m, 0m))
        };

        var result = MarketOverviewCalculator.CalculateIndex(history, "^GSPC", "S&P 500");

        Assert.NotNull(result);
        Assert.Equal(105m, result!.Value);
        Assert.Equal(5m, result.DailyChangePercent);
    }

    [Fact]
    public void 只有一天資料時漲跌幅是空值而不是假造出來的零()
    {
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 5), ("^GSPC", 105m, 0m))
        };

        var result = MarketOverviewCalculator.CalculateIndex(history, "^GSPC", "S&P 500");

        Assert.NotNull(result);
        Assert.Null(result!.DailyChangePercent);
    }

    [Fact]
    public void 完全沒有該symbol的資料時回傳空值()
    {
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 5), ("^GSPC", 105m, 0m))
        };

        Assert.Null(MarketOverviewCalculator.CalculateIndex(history, "^VIX", "VIX 恐慌指數"));
    }

    [Fact]
    public void 去年十二月有基準價時今年漲跌幅用該基準價計算()
    {
        var history = new[]
        {
            Snapshot(new DateOnly(2025, 12, 31), ("^GSPC", 100m, 0m)),
            Snapshot(new DateOnly(2026, 9, 5), ("^GSPC", 120m, 0m))
        };

        var result = MarketOverviewCalculator.CalculateIndex(history, "^GSPC", "S&P 500");

        Assert.Equal(20m, result!.YearToDateChangePercent);
    }

    [Fact]
    public void 去年十二月沒有任何資料時今年漲跌幅是空值而不是往更早的年份找()
    {
        var history = new[]
        {
            Snapshot(new DateOnly(2024, 12, 31), ("^GSPC", 90m, 0m)),
            Snapshot(new DateOnly(2026, 9, 5), ("^GSPC", 120m, 0m))
        };

        var result = MarketOverviewCalculator.CalculateIndex(history, "^GSPC", "S&P 500");

        Assert.Null(result!.YearToDateChangePercent);
    }

    [Fact]
    public void 類股權重是成交值占合計的比例且加總為百分之百()
    {
        var symbols = new[]
        {
            new MarketOverviewSymbol("XLK", "資訊科技"),
            new MarketOverviewSymbol("XLF", "金融")
        };

        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 4), ("XLK", 100m, 300m), ("XLF", 50m, 100m)),
            Snapshot(new DateOnly(2026, 9, 5), ("XLK", 110m, 300m), ("XLF", 51m, 100m))
        };

        var result = MarketOverviewCalculator.CalculateSectors(history, symbols);

        Assert.Equal(2, result.Count);
        var xlk = result.Single(r => r.Name == "資訊科技");
        var xlf = result.Single(r => r.Name == "金融");
        Assert.Equal(75m, xlk.Weight);
        Assert.Equal(25m, xlf.Weight);
        Assert.Equal(10m, xlk.ChangePercent);
    }

    [Fact]
    public void 成交值合計為零時權重是零而不是拋出除以零的例外()
    {
        var symbols = new[] { new MarketOverviewSymbol("XLK", "資訊科技") };
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 4), ("XLK", 100m, 0m)),
            Snapshot(new DateOnly(2026, 9, 5), ("XLK", 110m, 0m))
        };

        var result = MarketOverviewCalculator.CalculateSectors(history, symbols);

        Assert.Equal(0m, result.Single().Weight);
    }

    [Fact]
    public void 沒有任何symbol有兩天以上資料時熱度分數是空值()
    {
        var symbols = new[] { new MarketOverviewSymbol("XLK", "資訊科技") };
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 5), ("XLK", 100m, 100m))
        };

        Assert.Null(MarketOverviewCalculator.CalculateHeatScore(history, symbols));
    }

    [Fact]
    public void 全部類股上漲且成交值等於均量時熱度分數是廣度滿分與量能五分的平均()
    {
        // 廣度：全部上漲 → 10 分。量能：當日成交值＝20 日均量（比值 1.0）→ 5 分。
        // 平均各半，7.5 分。
        var symbols = new[] { new MarketOverviewSymbol("XLK", "資訊科技") };
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 4), ("XLK", 100m, 100m)),
            Snapshot(new DateOnly(2026, 9, 5), ("XLK", 110m, 100m))
        };

        Assert.Equal(7.5m, MarketOverviewCalculator.CalculateHeatScore(history, symbols));
    }

    [Fact]
    public void 全部symbol日期一致時整批日期就是那一天()
    {
        var symbols = new[]
        {
            new MarketOverviewSymbol("^DJI", "道瓊工業指數"),
            new MarketOverviewSymbol("XLK", "資訊科技")
        };
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 9), ("^DJI", 100m, 0m), ("XLK", 50m, 100m))
        };

        var result = MarketOverviewCalculator.DetermineAsOfDate(history, symbols);

        Assert.Equal(new DateOnly(2026, 9, 9), result.AsOfDate);
        Assert.Empty(result.AheadSymbols);
    }

    [Fact]
    public void 指數已經有隔天資料但類股還沒到時整批日期停在類股那一天且指數列在超前名單()
    {
        // 2026-09-11 實際發生的情境：^DJI 已經拿到 09-10，XLK 還停在 09-09。
        var symbols = new[]
        {
            new MarketOverviewSymbol("^DJI", "道瓊工業指數"),
            new MarketOverviewSymbol("XLK", "資訊科技")
        };
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 9), ("^DJI", 100m, 0m), ("XLK", 50m, 100m)),
            Snapshot(new DateOnly(2026, 9, 10), ("^DJI", 101m, 0m))
        };

        var result = MarketOverviewCalculator.DetermineAsOfDate(history, symbols);

        Assert.Equal(new DateOnly(2026, 9, 9), result.AsOfDate);
        Assert.Equal(["^DJI"], result.AheadSymbols);
    }

    [Fact]
    public void 完全沒有任何symbol有資料時日期是空值而不是今天()
    {
        var symbols = new[] { new MarketOverviewSymbol("^DJI", "道瓊工業指數") };

        var result = MarketOverviewCalculator.DetermineAsOfDate([], symbols);

        Assert.Null(result.AsOfDate);
        Assert.Empty(result.AheadSymbols);
    }

    [Fact]
    public void 有symbol完全沒被抓到時不會拖累其他symbol的日期()
    {
        // 名冊裡有一檔從沒抓到過資料（例如新上市或格式異常），不該讓整批永遠卡住。
        var symbols = new[]
        {
            new MarketOverviewSymbol("^DJI", "道瓊工業指數"),
            new MarketOverviewSymbol("NEWX", "從沒抓到的symbol")
        };
        var history = new[]
        {
            Snapshot(new DateOnly(2026, 9, 9), ("^DJI", 100m, 0m))
        };

        var result = MarketOverviewCalculator.DetermineAsOfDate(history, symbols);

        Assert.Equal(new DateOnly(2026, 9, 9), result.AsOfDate);
        Assert.Empty(result.AheadSymbols);
    }

    private static MarketOverviewSnapshot Snapshot(DateOnly date, params (string Symbol, decimal Close, decimal TradingValue)[] quotes)
        => new()
        {
            TradingDate = date,
            DownloadedAt = DateTimeOffset.Now,
            Quotes = [.. quotes.Select(q => new MarketOverviewQuote
            {
                Symbol = q.Symbol,
                Name = q.Symbol,
                ClosePrice = q.Close,
                TradingValue = q.TradingValue
            })]
        };
}
