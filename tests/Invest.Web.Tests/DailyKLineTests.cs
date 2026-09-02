using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class DailyKLineTests
{
    [Fact]
    public void 日K快照只補到少數標的時不能標成已完成()
    {
        var quotes = Enumerable.Range(0, 100)
            .Select(index => new DailyQuote
            {
                Market = Market.Twse,
                Ticker = (2330 + index).ToString(),
                Name = "測試標的",
                OpenPrice = index < 3 ? 100m : null,
                HighPrice = index < 3 ? 101m : null,
                LowPrice = index < 3 ? 99m : null,
                ClosePrice = 100m,
                TradingValue = 1m
            })
            .ToArray();

        var snapshot = new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = new DateOnly(2026, 8, 21),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UtcNow,
            DailyBarSchemaVersion = DailyQuoteSnapshot.CurrentDailyBarSchemaVersion,
            Quotes = quotes
        };

        Assert.False(snapshot.HasCompleteDailyBars);
    }

    [Fact]
    public void 舊版或價格關係不可能的日K必須重新回補()
    {
        var tradingDate = new DateOnly(2026, 8, 28);
        var invalid = new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = tradingDate,
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UtcNow,
            DailyBarSchemaVersion = DailyQuoteSnapshot.CurrentDailyBarSchemaVersion,
            Quotes =
            [
                new DailyQuote
                {
                    Market = Market.Tpex,
                    Ticker = "6584",
                    Name = "南俊國際",
                    OpenPrice = 682m,
                    HighPrice = 647m,
                    LowPrice = 675.69m,
                    ClosePrice = 682m,
                    TradingValue = 1m
                }
            ]
        };
        var oldVersion = new DailyQuoteSnapshot
        {
            SchemaVersion = invalid.SchemaVersion,
            TradingDate = tradingDate,
            IsTradingDay = true,
            DownloadedAt = invalid.DownloadedAt,
            DailyBarSchemaVersion = DailyQuoteSnapshot.CurrentDailyBarSchemaVersion - 1,
            Quotes =
            [
                new DailyQuote
                {
                    Market = Market.Tpex,
                    Ticker = "6584",
                    Name = "南俊國際",
                    OpenPrice = 680m,
                    HighPrice = 682m,
                    LowPrice = 647m,
                    ClosePrice = 682m,
                    TradingValue = 1m
                }
            ]
        };

        Assert.False(invalid.HasCompleteDailyBars);
        Assert.False(oldVersion.HasCompleteDailyBars);
    }

    [Fact]
    public void 不可能的日K不應進入圖表或均線()
    {
        var start = new DateOnly(2026, 8, 27);
        var selected = DailyKLineSelector.Select(
        [
            new DailyStockTrading
            {
                TradingDate = start,
                Ticker = "6584",
                OpenPrice = 682m,
                HighPrice = 647m,
                LowPrice = 675.69m,
                ClosePrice = 682m,
                TradingValue = 1m
            },
            new DailyStockTrading
            {
                TradingDate = start.AddDays(1),
                Ticker = "6584",
                OpenPrice = 680m,
                HighPrice = 682m,
                LowPrice = 678m,
                ClosePrice = 681m,
                TradingValue = 1m
            }
        ],
        [],
        "6584",
        start.AddDays(1),
        start.AddDays(1),
        months: 1);

        var point = Assert.Single(selected);
        Assert.Equal(start.AddDays(1), point.TradingDate);
        Assert.Equal(680m, point.Open);
        Assert.Null(point.Ma5);
    }

    [Fact]
    public void 完整快照混入單一不可能日K時必須重新回補()
    {
        var validQuotes = Enumerable.Range(0, 100)
            .Select(index => new DailyQuote
            {
                Market = Market.Twse,
                Ticker = (2330 + index).ToString(),
                Name = "測試標的",
                OpenPrice = 99m,
                HighPrice = 101m,
                LowPrice = 98m,
                ClosePrice = 100m,
                TradingValue = 1m
            });
        var quotes = validQuotes
            .Append(new DailyQuote
            {
                Market = Market.Twse,
                Ticker = "6584",
                Name = "南俊國際",
                OpenPrice = 682m,
                HighPrice = 647m,
                LowPrice = 675.69m,
                ClosePrice = 682m,
                TradingValue = 1m
            })
            .ToArray();

        var snapshot = new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = new DateOnly(2026, 8, 28),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UtcNow,
            DailyBarSchemaVersion = DailyQuoteSnapshot.CurrentDailyBarSchemaVersion,
            Quotes = quotes
        };

        Assert.False(snapshot.HasCompleteDailyBars);
    }

    [Fact]
    public void 只選取指定日期前三個月且欄位完整的日K()
    {
        var endDate = new DateOnly(2026, 8, 19);
        var trading = new[]
        {
            Bar(new DateOnly(2026, 5, 19), 100m),
            Bar(new DateOnly(2026, 5, 20), 101m, complete: false),
            Bar(new DateOnly(2026, 5, 21), 102m),
            Bar(new DateOnly(2026, 8, 19), 103m),
            Bar(new DateOnly(2026, 8, 20), 104m)
        };

        var selected = DailyKLineSelector.Select(trading, "2330", endDate);

        Assert.Equal(
            [new DateOnly(2026, 5, 19), new DateOnly(2026, 5, 21), new DateOnly(2026, 8, 19)],
            selected.Select(bar => bar.TradingDate));
    }

    [Fact]
    public void 還原權息會累乘事件倍率並同時調整開高低收()
    {
        var firstDate = new DateOnly(2026, 1, 2);
        var trading = Enumerable.Range(0, 4)
            .Select(index => Bar(firstDate.AddDays(index), 100m + index))
            .ToArray();
        var adjustments = new[]
        {
            new StockPriceAdjustment("2330", firstDate.AddDays(1), 100m, 90m, "TWSE TWT49U"),
            new StockPriceAdjustment("2330", firstDate.AddDays(3), 100m, 80m, "TWSE TWT49U")
        };

        var selected = DailyKLineSelector.Select(
            trading,
            adjustments,
            "2330",
            firstDate.AddDays(3),
            firstDate.AddDays(3),
            months: 12);

        Assert.Collection(
            selected,
            first =>
            {
                Assert.Equal(71.28m, first.Open);
                Assert.Equal(72.72m, first.High);
                Assert.Equal(70.56m, first.Low);
                Assert.Equal(72m, first.Close);
            },
            second => Assert.Equal(80.8m, second.Close),
            third => Assert.Equal(81.6m, third.Close),
            fourth => Assert.Equal(103m, fourth.Close));
    }

    [Fact]
    public void 均線使用圖表期間之前的有效收盤且包含五十二十六十與二百四十日()
    {
        var firstDate = new DateOnly(2025, 1, 1);
        var trading = Enumerable.Range(0, 260)
            .Select(index => Bar(
                firstDate.AddDays(index),
                index + 1m,
                complete: index >= 240))
            .ToArray();
        var endDate = trading[^1].TradingDate;

        var selected = DailyKLineSelector.Select(
            trading,
            [],
            "2330",
            endDate,
            endDate,
            months: 3);

        var first = selected[0];
        Assert.Equal(239m, first.Ma5);
        Assert.Equal(236.5m, first.Ma10);
        Assert.Equal(231.5m, first.Ma20);
        Assert.Equal(211.5m, first.Ma60);
        Assert.Equal(121.5m, first.Ma240);

        var last = selected[^1];
        Assert.Equal(258m, last.Ma5);
        Assert.Equal(255.5m, last.Ma10);
        Assert.Equal(250.5m, last.Ma20);
        Assert.Equal(230.5m, last.Ma60);
        Assert.Equal(140.5m, last.Ma240);
    }

    [Fact]
    public void K棒漲跌以收盤價相對同一根的開盤價判斷()
    {
        var firstDate = new DateOnly(2026, 8, 12);
        var trading = new[]
        {
            Bar(firstDate, 2415m),
            new DailyStockTrading
            {
                TradingDate = firstDate.AddDays(1),
                Ticker = "2330",
                OpenPrice = 2440m,
                HighPrice = 2450m,
                LowPrice = 2425m,
                ClosePrice = 2435m,
                TradingValue = 1m
            }
        };

        var selected = DailyKLineSelector.Select(
            trading,
            [],
            "2330",
            firstDate.AddDays(1),
            firstDate.AddDays(1),
            months: 1);

        // 昨收 2415、開盤 2440、收盤 2435：比昨收是漲（舊規則），比自己的開盤是跌（現在的規則）。
        // 特意挑這種「跳空開高、收在開盤之下但仍高於昨收」的棒子，才鎖得住兩種規則的差異。
        Assert.Equal(2415m, selected[1].PreviousClose);
        Assert.Equal(DailyKLineTrend.Down, DailyKLineTrendCalculator.Get(selected[1]));
    }

    [Fact]
    public void 補抓日K不會改動成交值與收盤價()
    {
        var snapshot = new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = new DateOnly(2026, 8, 19),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UtcNow,
            Quotes =
            [
                new DailyQuote
                {
                    Market = Market.Twse,
                    Ticker = "2330",
                    Name = "台積電",
                    TradingValue = 123m,
                    TradingVolume = 456m,
                    ClosePrice = 100m
                }
            ]
        };

        var updated = snapshot.WithDailyBars(
        [
            new DailyQuote
            {
                Market = Market.Twse,
                Ticker = "2330",
                Name = "台積電",
                TradingValue = 999m,
                OpenPrice = 98m,
                HighPrice = 102m,
                LowPrice = 97m,
                ClosePrice = 101m
            }
        ]);

        var quote = Assert.Single(updated.Quotes);
        Assert.Equal(123m, quote.TradingValue);
        Assert.Equal(456m, quote.TradingVolume);
        Assert.Equal(100m, quote.ClosePrice);
        Assert.Equal(98m, quote.OpenPrice);
        Assert.Equal(102m, quote.HighPrice);
        Assert.Equal(97m, quote.LowPrice);
        Assert.True(updated.HasCompleteDailyBars);
    }

    [Fact]
    public void 日K會帶出官方成交量供靜態圖表匯出()
    {
        var tradingDate = new DateOnly(2026, 8, 21);
        var selected = DailyKLineSelector.Select(
            [new DailyStockTrading
            {
                TradingDate = tradingDate,
                Ticker = "2330",
                OpenPrice = 100m,
                HighPrice = 102m,
                LowPrice = 99m,
                ClosePrice = 101m,
                TradingValue = 1m,
                TradingVolume = 12_345_000m
            }],
            [],
            "2330",
            tradingDate,
            tradingDate,
            months: 1);

        var point = Assert.Single(selected);
        Assert.Equal(12_345_000m, point.TradingVolume);
    }

    private static DailyStockTrading Bar(DateOnly date, decimal close, bool complete = true)
        => new()
        {
            TradingDate = date,
            Ticker = "2330",
            OpenPrice = complete ? close - 1m : null,
            HighPrice = complete ? close + 1m : null,
            LowPrice = complete ? close - 2m : null,
            ClosePrice = close,
            TradingValue = 1m
        };
}
