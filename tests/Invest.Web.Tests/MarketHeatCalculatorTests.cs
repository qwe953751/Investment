using Invest.Web.Domain.Stocks;
using Invest.Web.Features.TradingValueRanking.Services;
using Invest.Web.Infrastructure.MarketData;

namespace Invest.Web.Tests;

public sealed class MarketHeatCalculatorTests
{
    [Fact]
    public void 市場熱絡程度包含趨勢廣度量能且歷史只取前五日()
    {
        var start = new DateOnly(2026, 1, 5);
        var dates = Enumerable.Range(0, 7).Select(offset => start.AddDays(offset)).ToArray();
        var trading = dates
            .SelectMany((date, index) =>
            new DailyStockTrading[]
            {
                new DailyStockTrading
                {
                    TradingDate = date,
                    Ticker = "2330",
                    ClosePrice = index == 6 ? 12m : 10m,
                    TradingValue = index == 6 ? 200m : 100m
                },
                new DailyStockTrading
                {
                    TradingDate = date,
                    Ticker = "1101",
                    ClosePrice = index == 6 ? 8m : 10m,
                    TradingValue = index == 6 ? 200m : 100m
                }
            })
            .ToArray();
        var indices = dates
            .Select((date, index) => new DailyMarketIndex
            {
                TradingDate = date,
                Quotes =
                [
                    new MarketIndexQuote
                    {
                        Market = Market.Twse,
                        Value = 100m + index,
                        ChangePercent = index == 6 ? 1m : null
                    },
                    new MarketIndexQuote
                    {
                        Market = Market.Tpex,
                        Value = 200m + index * 2m,
                        ChangePercent = index == 6 ? 1m : null
                    }
                ]
            })
            .ToArray();

        var result = MarketHeatCalculator.Calculate(trading, indices, dates[^1]);

        Assert.NotNull(result);
        Assert.Equal(1, result.UpCount);
        Assert.Equal(1, result.DownCount);
        Assert.Equal(0, result.FlatCount);
        Assert.Equal(2, result.ComparedStockCount);
        Assert.Equal(400m, result.MarketTurnover);
        Assert.Equal(200m, result.AverageMarketTurnover);
        Assert.Equal(2m, result.VolumeRatio);
        Assert.Equal(5m, result.BreadthScore);
        Assert.Equal(1m, result.IndexDailyChangePercent);
        Assert.Equal(5, result.PreviousDays.Count);
        Assert.All(result.PreviousDays, day => Assert.InRange(day.Score, 0m, 10m));
        Assert.All(
            new[] { result.Score, result.ShortTrendScore, result.BreadthScore, result.VolumeScore },
            score => Assert.True(score is >= 0m and <= 10m));
    }
}
