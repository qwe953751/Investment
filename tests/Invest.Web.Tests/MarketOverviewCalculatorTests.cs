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
    public void 美股個別指數熱絡分數同時納入技術與VIX風險且輸出0到10()
    {
        var history = BuildHistory(
            ("^GSPC", 100m, 1_000m),
            ("^VIX", 18m, 1_000m),
            ("XLK", 100m, 1_000m));

        var result = MarketOverviewCalculator.CalculateHeatAt(history, MarketOverviewCatalog.Us, new DateOnly(2026, 9, 5));

        Assert.NotNull(result.IndexHeatScores["^GSPC"]);
        Assert.InRange(result.IndexHeatScores["^GSPC"]!.Value, 0m, 10m);
    }

    [Fact]
    public void 美股綜合熱絡需要四大指數與足夠類股確認資料()
    {
        var history = BuildHistory(
            ("^DJI", 100m, 1_000m), ("^GSPC", 100m, 1_000m),
            ("^IXIC", 100m, 1_000m), ("^SOX", 100m, 1_000m),
            ("^VIX", 18m, 1_000m));
        foreach (var sector in MarketOverviewCatalog.UsSectors)
        {
            history = history
                .Select(snapshot => snapshot)
                .Concat(BuildHistory((sector.Symbol, 100m, 1_000m)))
                .GroupBy(snapshot => snapshot.TradingDate)
                .Select(group => Merge(group))
                .ToArray();
        }

        var result = MarketOverviewCalculator.CalculateHeatAt(history, MarketOverviewCatalog.Us, new DateOnly(2026, 9, 5));

        Assert.NotNull(result.CompositeHeatScore);
        Assert.NotNull(result.SectorHeatScore);
        Assert.Equal(11, result.SectorValidCount);
        Assert.Equal(4, result.IndexHeatScores.Count);
    }

    [Fact]
    public void 加密貨幣綜合熱絡包含DOGE且不需要VIX或類股熱力圖()
    {
        var history = BuildHistory(
            ("BTC-USD", 100m, 1_000m), ("ETH-USD", 100m, 1_000m),
            ("SOL-USD", 100m, 1_000m), ("DOGE-USD", 100m, 1_000m));

        var result = MarketOverviewCalculator.CalculateHeatAt(history, MarketOverviewCatalog.Crypto, new DateOnly(2026, 9, 5));

        Assert.NotNull(result.CompositeHeatScore);
        Assert.Null(result.SectorHeatScore);
        Assert.Null(result.SectorValidCount);
        Assert.Equal(3, result.IndexHeatScores.Count);
        Assert.InRange(result.CompositeHeatScore!.Value, 0m, 10m);
    }

    [Fact]
    public void 缺少VIX時美股指數熱絡分數不以假資料補值()
    {
        var history = BuildHistory(("^GSPC", 100m, 1_000m));

        var result = MarketOverviewCalculator.CalculateHeatAt(history, MarketOverviewCatalog.Us, new DateOnly(2026, 9, 5));

        Assert.Null(result.IndexHeatScores["^GSPC"]);
    }

    [Fact]
    public void 四市場名冊包含日韓與DOGE()
    {
        var symbols = MarketOverviewCatalog.All().Select(symbol => symbol.Symbol).ToHashSet(StringComparer.Ordinal);

        Assert.Contains("^N225", symbols);
        Assert.Contains("^KS11", symbols);
        Assert.Contains("DOGE-USD", symbols);
        Assert.Equal(4, MarketOverviewCatalog.Definitions.Count);
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

    private static MarketOverviewSnapshot[] BuildHistory(params (string Symbol, decimal Base, decimal Volume)[] symbols)
    {
        return Enumerable.Range(0, 260)
            .Select(index => Snapshot(
                new DateOnly(2025, 12, 20).AddDays(index),
                symbols.Select(symbol => (
                    symbol.Symbol,
                    Close: symbol.Base + index * 0.1m,
                    TradingValue: symbol.Volume)).ToArray()))
            .ToArray();
    }

    private static MarketOverviewSnapshot Merge(IGrouping<DateOnly, MarketOverviewSnapshot> group)
    {
        var first = group.First();
        return new MarketOverviewSnapshot
        {
            TradingDate = group.Key,
            DownloadedAt = first.DownloadedAt,
            Quotes = [.. group.SelectMany(snapshot => snapshot.Quotes)]
        };
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
                TradingValue = q.TradingValue,
                TradingVolume = q.TradingValue
            })]
        };
}
