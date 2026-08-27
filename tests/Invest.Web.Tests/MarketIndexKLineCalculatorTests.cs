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
        Assert.Equal(102m, points[^1].Ma5);
        Assert.Equal(103m, points[^1].PreviousClose);
        Assert.Equal(5_000m, points[^1].TradingValue);
    }
}
