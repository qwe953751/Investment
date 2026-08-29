using Invest.Web.Domain.Stocks;
using Invest.Web.Features.StockTopics.Models;
using Invest.Web.Features.StockTopics.Services;
using Invest.Web.Features.TradingValueRanking.Models;

namespace Invest.Web.Tests;

public sealed class TopicHeatCalculatorTests
{
    private static readonly TopicMapping Mapping = new()
    {
        Version = 2,
        Label = "測試分類",
        Description = string.Empty,
        Topics =
        [
            new Topic
            {
                Id = "chip",
                Name = "晶片",
                Source = TopicSource.Concept,
                Depth = 0,
                DirectTickers = ["2330", "1101"]
            }
        ]
    };

    private static readonly TradingValueRankingResult Ranking = new()
    {
        PeriodDays = 1,
        Mode = RankingMode.TradingHeat,
        HasSufficientData = true,
        CurrentPeriodStart = new DateOnly(2026, 8, 24),
        CurrentPeriodEnd = new DateOnly(2026, 8, 24),
        Rows =
        [
            Row("2330", 1, 0.7m, 0.035m),
            Row("1101", 2, 0.3m, -0.01m)
        ]
    };

    private static StockRankingRow Row(string ticker, int rank, decimal share, decimal change)
        => new()
        {
            Rank = rank,
            Ticker = ticker,
            Name = ticker,
            Market = Market.Twse,
            AverageDailyTradingValue = share * 1000m,
            PreviousAverageDailyTradingValue = 0m,
            MarketShare = share,
            PreviousMarketShare = 0m,
            PriceChangeRate = change,
            ActiveTradingDayCount = 1
        };

    [Fact]
    public void 泡泡圖價格反應以成交值加權且族群廣度只修正百分之二十()
    {
        var row = Assert.Single(TopicHeatCalculator.Calculate(Mapping, Ranking).Rows);

        // P = 0.7 × 3.5% + 0.3 × -1% = 2.15%。
        Assert.Equal(0.0215m, row.WeightedPriceChangeRate);
        Assert.Equal(57.26m, row.BreadthScore);

        // Y = P × (0.80 + 0.20 × B)，B = 57.26 / 100。
        Assert.Equal(0.80m, TopicHeatCalculator.PriceReactionBaseWeight);
        Assert.Equal(0.20m, TopicHeatCalculator.BreadthAdjustmentWeight);
        Assert.Equal(0.01966218m, row.BreadthAdjustedPriceReactionRate);
    }

    [Fact]
    public void 新聞熱度只填進欄位不會動到綜合熱度()
    {
        // 使用者拍板前新聞熱度只是參考欄。這一條是那個決定的守門員：
        // 一旦有人順手把它加進加權，全站每一個族群的熱度數字與排序都會變，
        // 而且不會有任何錯誤訊息告訴他發生了什麼事。
        var without = Assert.Single(TopicHeatCalculator.Calculate(Mapping, Ranking).Rows);

        var with = Assert.Single(TopicHeatCalculator
            .Calculate(Mapping, Ranking, new Dictionary<string, decimal> { ["chip"] = 99m })
            .Rows);

        Assert.Null(without.NewsScore);
        Assert.Equal(99m, with.NewsScore);
        Assert.Equal(without.CompositeScore, with.CompositeScore);
        Assert.Equal(0m, with.NewsWeight);
        Assert.Equal(without.FundWeight, with.FundWeight);
        Assert.Equal(without.BreadthWeight, with.BreadthWeight);
    }

    [Fact]
    public void 沒查到新聞的族群留白而不是零分()
    {
        // 0 分的意思是「查過了，這個族群的新聞不值錢」，
        // 留白的意思是「這段期間它沒有掛得上的重大訊息」。畫面上要分得出來。
        var row = Assert.Single(TopicHeatCalculator
            .Calculate(Mapping, Ranking, new Dictionary<string, decimal> { ["其他族群"] = 99m })
            .Rows);

        Assert.Null(row.NewsScore);
    }
}
