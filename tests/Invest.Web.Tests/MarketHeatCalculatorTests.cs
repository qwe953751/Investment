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
        Assert.Equal(200m, result.PreviousMarketTurnover);
        Assert.Equal(200m, result.MarketTurnoverChange);
        Assert.Equal(1m, result.MarketTurnoverChangeRate);
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

    [Fact]
    public void 盤中估算成交值加總與前一交易日正式成交額比較()
    {
        var start = new DateOnly(2026, 1, 5);
        var dates = Enumerable.Range(0, 2).Select(offset => start.AddDays(offset)).ToArray();
        var trading = dates
            .SelectMany((date, index) => new DailyStockTrading[]
            {
                new()
                {
                    TradingDate = date,
                    Ticker = "2330",
                    ClosePrice = 10m,
                    TradingValue = index == 0 ? 100m : 200m
                },
                new()
                {
                    TradingDate = date,
                    Ticker = "1101",
                    ClosePrice = 10m,
                    TradingValue = index == 0 ? 100m : 200m
                }
            })
            .ToArray();
        var indices = dates.Select(date => new DailyMarketIndex
        {
            TradingDate = date,
            Quotes =
            [
                new MarketIndexQuote { Market = Market.Twse, Value = 100m },
                new MarketIndexQuote { Market = Market.Tpex, Value = 200m }
            ]
        }).ToArray();

        var result = MarketHeatCalculator.Calculate(trading, indices, dates[^1]);

        Assert.NotNull(result);
        Assert.Equal(400m, result.MarketTurnover);
        Assert.Equal(200m, result.PreviousMarketTurnover);
        Assert.Equal(200m, result.MarketTurnoverChange);
        Assert.Equal(1m, result.MarketTurnoverChangeRate);
    }

    [Fact]
    public void 盤中預估總成交額同時決定量能與前一日比較()
    {
        var start = new DateOnly(2026, 1, 5);
        var dates = Enumerable.Range(0, 21).Select(offset => start.AddDays(offset)).ToArray();
        var trading = dates
            .SelectMany((date, index) => new DailyStockTrading[]
            {
                new()
                {
                    TradingDate = date,
                    Ticker = "2330",
                    ClosePrice = 10m,
                    TradingValue = index == dates.Length - 1 ? 10m : 50m
                },
                new()
                {
                    TradingDate = date,
                    Ticker = "1101",
                    ClosePrice = 10m,
                    TradingValue = index == dates.Length - 1 ? 10m : 50m
                }
            })
            .ToArray();
        var indices = dates.Select(date => new DailyMarketIndex
        {
            TradingDate = date,
            Quotes =
            [
                new MarketIndexQuote { Market = Market.Twse, Value = 100m },
                new MarketIndexQuote { Market = Market.Tpex, Value = 200m }
            ]
        }).ToArray();

        // 退回表 11:00 校準過的 f(t) 是 0.542（見 IntradayTurnoverCalibration.Fallback）；
        // 本輪實際累計 32.52，預估全日成交額為 32.52 ÷ 0.542 = 60。
        // 這個值要同時驅動量能與「較前一交易日」比較，不能一邊用累計、一邊用預估。
        var projectedTurnover = IntradayTurnoverProjection.Estimate(
            32.52m, new TimeOnly(11, 0), IntradayTurnoverCalibration.Fallback);
        var result = MarketHeatCalculator.Calculate(trading, indices, dates[^1], projectedTurnover);

        Assert.NotNull(result);
        Assert.Equal(60m, projectedTurnover);
        Assert.Equal(60m, result.MarketTurnover);
        Assert.Equal(100m, result.PreviousMarketTurnover);
        Assert.Equal(-40m, result.MarketTurnoverChange);
        Assert.Equal(-0.4m, result.MarketTurnoverChangeRate);
        Assert.Equal(0.6m, result.VolumeRatio);
    }

    [Fact]
    public void 各分項先限制在十分再做熱絡加權()
    {
        var dates = new[]
        {
            new DateOnly(2026, 1, 5),
            new DateOnly(2026, 1, 6)
        };
        var trading = dates
            .SelectMany((date, index) => new DailyStockTrading[]
            {
                new()
                {
                    TradingDate = date,
                    Ticker = "2330",
                    ClosePrice = index == 0 ? 10m : 12m,
                    TradingValue = index == 0 ? 100m : 200m
                },
                new()
                {
                    TradingDate = date,
                    Ticker = "1101",
                    ClosePrice = index == 0 ? 10m : 8m,
                    TradingValue = index == 0 ? 100m : 200m
                }
            })
            .ToArray();
        var indices = dates.Select((date, index) => new DailyMarketIndex
        {
            TradingDate = date,
            Quotes =
            [
                new MarketIndexQuote { Market = Market.Twse, Value = 100m + index },
                new MarketIndexQuote { Market = Market.Tpex, Value = 200m + index * 2m }
            ]
        }).ToArray();

        var result = MarketHeatCalculator.Calculate(trading, indices, dates[^1]);

        Assert.NotNull(result);
        Assert.Equal(7m, result.ShortTrendScore);
        Assert.Equal(5m, result.BreadthScore);
        Assert.Equal(2m, result.VolumeRatio);
        Assert.Equal(10m, result.VolumeScore);
        Assert.Equal(7.2m, result.Score);
    }

    [Fact]
    public void 盤中預估總成交額在早盤門檻前不造值()
    {
        // 09:05 落在退回表的 09:00(0.0) 與 09:15(0.229) 之間，內插後 f(t) ≈ 0.076，
        // 低於 MinimumFraction(0.15)，此時還不給數字。
        Assert.Null(IntradayTurnoverProjection.Estimate(
            20m, new TimeOnly(9, 5), IntradayTurnoverCalibration.Fallback));
    }
}
