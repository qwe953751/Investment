using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Models;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class MarketIndexKLineCalculatorTests
{
    [Fact]
    public void 指數K線會以同市場成交值加總並計算均線()
    {
        var start = new DateOnly(2026, 8, 3);
        var indices = Enumerable.Range(0, 5)
            .Select(offset =>
            {
                var close = 100m + offset;
                return new DailyMarketIndex
                {
                    TradingDate = start.AddDays(offset),
                    Quotes =
                    [
                        new MarketIndexQuote
                        {
                            Market = Market.Twse,
                            Value = close,
                            OpenPrice = close - 1m,
                            HighPrice = close + 2m,
                            LowPrice = close - 2m
                        }
                    ]
                };
            })
            .ToArray();
        var trading = Enumerable.Range(0, 5)
            .Select(offset => new DailyStockTrading
            {
                TradingDate = start.AddDays(offset),
                Ticker = "2330",
                TradingValue = (offset + 1) * 1_000m
            })
            .ToArray();

        var points = MarketIndexKLineCalculator.Calculate(
            indices,
            trading,
            new Dictionary<string, Market> { ["2330"] = Market.Twse },
            Market.Twse,
            start,
            start.AddDays(4));

        Assert.Equal(5, points.Count);
        Assert.Null(points[0].Ma5);
        Assert.Null(points[^1].Ma240);
        Assert.Equal(102m, points[^1].Ma5);
        Assert.Equal(103m, points[^1].PreviousClose);
        Assert.Equal(5_000m, points[^1].TradingValue);
    }

    [Fact]
    public void 指數K線會計算MA240()
    {
        var start = new DateOnly(2025, 1, 1);
        var indices = Enumerable.Range(0, 240)
            .Select(offset =>
            {
                var close = 100m + offset;
                return new DailyMarketIndex
                {
                    TradingDate = start.AddDays(offset),
                    Quotes =
                    [
                        new MarketIndexQuote
                        {
                            Market = Market.Twse,
                            Value = close,
                            OpenPrice = close - 1m,
                            HighPrice = close + 2m,
                            LowPrice = close - 2m
                        }
                    ]
                };
            })
            .ToArray();

        var points = MarketIndexKLineCalculator.Calculate(
            indices,
            [],
            new Dictionary<string, Market>(),
            Market.Twse,
            start,
            start.AddDays(239));

        Assert.Null(points[238].Ma240);
        Assert.Equal(219.5m, points[^1].Ma240);
    }

    [Fact]
    public void 指數K線會略過價格關係不可能的指數棒()
    {
        var start = new DateOnly(2026, 8, 27);
        var indices = new[]
        {
            new DailyMarketIndex
            {
                TradingDate = start,
                Quotes =
                [
                    new MarketIndexQuote
                    {
                        Market = Market.Twse,
                        Value = 682m,
                        OpenPrice = 682m,
                        HighPrice = 647m,
                        LowPrice = 675m
                    }
                ]
            },
            new DailyMarketIndex
            {
                TradingDate = start.AddDays(1),
                Quotes =
                [
                    new MarketIndexQuote
                    {
                        Market = Market.Twse,
                        Value = 681m,
                        OpenPrice = 680m,
                        HighPrice = 682m,
                        LowPrice = 678m
                    }
                ]
            }
        };

        var points = MarketIndexKLineCalculator.Calculate(
            indices,
            [],
            new Dictionary<string, Market>(),
            Market.Twse,
            start,
            start.AddDays(1));

        var point = Assert.Single(points);
        Assert.Equal(start.AddDays(1), point.TradingDate);
    }

    [Fact]
    public void 指數快照混入不可能指數棒時必須重新回補()
    {
        var snapshot = new DailyQuoteSnapshot
        {
            SchemaVersion = DailyQuoteSnapshot.CurrentSchemaVersion,
            TradingDate = new DateOnly(2026, 8, 28),
            IsTradingDay = true,
            DownloadedAt = DateTimeOffset.UtcNow,
            MarketIndexSchemaVersion = DailyQuoteSnapshot.CurrentMarketIndexSchemaVersion,
            MarketIndices =
            [
                new MarketIndexQuote
                {
                    Market = Market.Twse,
                    Value = 682m,
                    OpenPrice = 682m,
                    HighPrice = 647m,
                    LowPrice = 675m
                },
                new MarketIndexQuote
                {
                    Market = Market.Tpex,
                    Value = 400m,
                    OpenPrice = 399m,
                    HighPrice = 401m,
                    LowPrice = 398m
                }
            ]
        };

        Assert.False(snapshot.HasCompleteMarketIndices);
    }
}
