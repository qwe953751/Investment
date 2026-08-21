using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class DailyKLineTests
{
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
    public void K棒漲跌以收盤價相對前一交易日收盤判斷()
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

        Assert.Equal(2415m, selected[1].PreviousClose);
        Assert.Equal(DailyKLineTrend.Up, DailyKLineTrendCalculator.Get(selected[1]));
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
